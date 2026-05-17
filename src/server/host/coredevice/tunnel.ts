import { type ChildProcess, spawn } from 'node:child_process';
import { promises as dns } from 'node:dns';

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const KEEPER_POLL_INTERVAL_MS = 750;
const HOSTNAME_RESOLVE_INTERVAL_MS = 250;

export interface TunnelInfo {
  /** Device's IPv6 address through the CoreDevice tunnel (the `fd45:…::1`-style ULA). */
  deviceAddress: string;
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
//
// A cleaner alternative would be a Swift CLI that calls
// `CoreDevice.CapabilityStaticMember.acquireUsageAssertion` directly. The
// symbol is exposed in CoreDevice.framework. Left for a follow-up — the loop
// approach is good enough for an MVP and has zero native code.
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
      // Brief breath between iterations. Apple's usage assertion grace period
      // is several seconds, so the tunnel doesn't actually drop here.
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
  // mDNS publishes `<udid-lowercased>.coredevice.local` → device's tunnel IPv6.
  // The hostname becomes resolvable as soon as the tunnel link comes up.
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
    await sleep(HOSTNAME_RESOLVE_INTERVAL_MS);
  }
  throw new TunnelStartupError(
    `Could not resolve ${hostname} to an IPv6 address within deadline (last error: ${lastError?.message ?? 'unknown'})`
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
    return {
      close: () => {
        return keeper.stop();
      },
      info: { deviceAddress },
    };
  } catch (err) {
    await keeper.stop();
    throw err;
  }
};
