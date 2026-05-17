import { spawn, type ChildProcess } from 'node:child_process';
import { promises as dns } from 'node:dns';
import { networkInterfaces } from 'node:os';

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const KEEPER_POLL_INTERVAL_MS = 750;
const POLL_INTERVAL_MS = 250;

export interface TunnelInfo {
  /** Device's IPv6 address through the CoreDevice tunnel (the `fd…::1`-style ULA). */
  deviceAddress: string;
  /**
   * Mac-side IPv6 of the same tunnel (`fd…::2`). Sockets MUST bind to this
   * address before connecting to the device; default routing picks the wrong
   * utun on hosts with multiple tunnels (Tailscale, WireGuard, …).
   */
  hostAddress: string;
  /** Tunnel interface name on the Mac, e.g. `utun6`. */
  interfaceName: string;
  /**
   * Port the device's RemoteServiceDiscovery listens on inside the tunnel.
   * Dynamic per session; we lift it from the system log.
   */
  rsdPort: number;
}

export interface TunnelHandle {
  /** Stops the tunnel keeper. The OS tears the tunnel down within a few seconds. */
  close: () => Promise<void>;
  info: TunnelInfo;
}

export interface StartTunnelOptions {
  /** Maximum time to wait for the tunnel to come up. Default 30s. */
  startupTimeoutMs?: number;
}

export class TunnelStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TunnelStartupError';
  }
}

const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

// Apple's CoreDevice tunnel is brought up on-demand by whatever process holds
// a "usage assertion" against the device. devicectl acquires one for the
// duration of any subcommand it runs; when devicectl exits, the OS tears the
// tunnel down within a few seconds. We piggy-back on this by running a cheap
// `devicectl device info processes` command repeatedly. As long as a keeper
// op is in-flight, the tunnel stays up.
class TunnelKeeper {
  private active = true;
  private currentChild: ChildProcess | null = null;

  constructor(private readonly coreDeviceIdentifier: string) {}

  start(): void {
    void this.loop();
  }

  private async loop(): Promise<void> {
    while (this.active) {
      await this.runOneIteration();
      if (!this.active) break;
      await sleep(KEEPER_POLL_INTERVAL_MS);
    }
  }

  private runOneIteration(): Promise<void> {
    return new Promise((resolve) => {
      const child = spawn(
        'xcrun',
        ['devicectl', 'device', 'info', 'processes', '--device', this.coreDeviceIdentifier],
        { stdio: ['ignore', 'ignore', 'ignore'] }
      );
      this.currentChild = child;
      child.on('close', () => {
        this.currentChild = null;
        resolve();
      });
      child.on('error', () => {
        this.currentChild = null;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    this.active = false;
    const child = this.currentChild;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
    return new Promise((resolve) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.on('close', () => {
        resolve();
      });
    });
  }
}

const resolveDeviceAddress = async (
  coreDeviceIdentifier: string,
  deadline: number
): Promise<string> => {
  const hostname = `${coreDeviceIdentifier.toLowerCase()}.coredevice.local`;
  let lastError: Error | null = null;
  while (Date.now() < deadline) {
    try {
      const result = await dns.lookup(hostname, { family: 6 });
      if (result.address && result.address.includes(':')) {
        return result.address;
      }
    } catch (err) {
      lastError = err as Error;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new TunnelStartupError(
    `Could not resolve ${hostname} to an IPv6 address (last error: ${lastError?.message ?? 'unknown'})`
  );
};

// Find the utun interface that the OS just brought up for this device. We
// pick by MTU (16000 is unique to the CoreDevice tunnel) and require an
// fd<…>::/64 (ULA) address. The `::2` end is ours; the `::1` end is the
// device.
const findTunnelInterface = async (
  deviceAddress: string,
  deadline: number
): Promise<{ hostAddress: string; interfaceName: string }> => {
  while (Date.now() < deadline) {
    const interfaces = networkInterfaces();
    for (const [name, addrs] of Object.entries(interfaces)) {
      if (!name.startsWith('utun') || !addrs) continue;
      for (const addr of addrs) {
        if (addr.family !== 'IPv6') continue;
        if (!addr.address.startsWith('fd')) continue;
        // Both sides of the tunnel live in the same /64 ULA. The device
        // address ends in ::1; ours ends in ::2.
        const devPrefix = deviceAddress.replace(/::1$/, '::');
        const hostPrefix = addr.address.replace(/::2$/, '::');
        if (devPrefix === hostPrefix) {
          return { hostAddress: addr.address, interfaceName: name };
        }
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new TunnelStartupError(
    `Could not find utun interface matching device ${deviceAddress}. Is the tunnel up?`
  );
};

const runProcessCapture = (
  command: string,
  args: readonly string[],
  timeoutMs: number
): Promise<{ stderr: string; stdout: string }> => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ stderr, stdout });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
};

const RSD_PORT_PATTERN = /for server port (\d+)/g;

// The RSD port the device is listening on is logged by remotepairingd at
// tunnel establish time. Most predicates redact it as `<private>`; the
// "for server port" line slips through. We scan the last minute of log
// output; the tunnel was brought up within the last few seconds.
const findRsdPort = async (deadline: number): Promise<number> => {
  while (Date.now() < deadline) {
    const result = await runProcessCapture(
      'log',
      [
        'show',
        '--last',
        '60s',
        '--info',
        '--debug',
        '--predicate',
        'eventMessage CONTAINS "for server port"',
        '--style',
        'compact',
      ],
      5_000
    );
    let lastPort: number | undefined;
    let match;
    while ((match = RSD_PORT_PATTERN.exec(result.stdout)) !== null) {
      lastPort = Number(match[1]);
    }
    RSD_PORT_PATTERN.lastIndex = 0;
    if (lastPort) return lastPort;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new TunnelStartupError(
    'RSD port not found in system log. Is the tunnel up and is `log` available?'
  );
};

export const startTunnel = async (
  coreDeviceIdentifier: string,
  options: StartTunnelOptions = {}
): Promise<TunnelHandle> => {
  const deadline = Date.now() + (options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);

  const keeper = new TunnelKeeper(coreDeviceIdentifier);
  keeper.start();

  try {
    const deviceAddress = await resolveDeviceAddress(coreDeviceIdentifier, deadline);
    const { hostAddress, interfaceName } = await findTunnelInterface(deviceAddress, deadline);
    const rsdPort = await findRsdPort(deadline);
    return {
      close: () => {
        return keeper.stop();
      },
      info: { deviceAddress, hostAddress, interfaceName, rsdPort },
    };
  } catch (err) {
    await keeper.stop();
    throw err;
  }
};
