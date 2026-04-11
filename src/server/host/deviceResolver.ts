import { type Bridge, type ClientEntry } from '@/server/bridge';

import { ProcessNotFoundError, type ProcessRunner } from './processRunner';
import { type HostContext } from './types';

const CACHE_TTL_MS = 5_000;
const LIST_TIMEOUT_MS = 5_000;

export interface IosSimulator {
  name: string;
  state: string;
  udid: string;
}

export interface AndroidDevice {
  serial: string;
  state: string;
}

export interface ResolvedDevice {
  displayName: string;
  nativeId: string;
  platform: 'android' | 'ios';
}

export interface EnrichedIosSim extends IosSimulator {
  connected: boolean;
  clientId?: string;
}

export interface EnrichedAndroidDevice extends AndroidDevice {
  connected: boolean;
  clientId?: string;
}

export interface EnrichedDeviceList {
  android: EnrichedAndroidDevice[] | { error: string };
  ios: EnrichedIosSim[] | { error: string };
}

export type DeviceResolution = { device: ResolvedDevice; ok: true } | { error: string; ok: false };

interface Cache<T> {
  result: T;
  timestamp: number;
}

interface ResolveOptions {
  platform?: 'android' | 'ios';
}

let iosCache: Cache<IosSimulator[]> | null = null;
let androidCache: Cache<AndroidDevice[]> | null = null;

export const clearDeviceCache = (): void => {
  iosCache = null;
  androidCache = null;
};

export const listIosSimulators = async (runner: ProcessRunner): Promise<IosSimulator[]> => {
  if (iosCache && Date.now() - iosCache.timestamp < CACHE_TTL_MS) {
    return iosCache.result;
  }
  const proc = await runner('xcrun', ['simctl', 'list', 'devices', '--json'], {
    timeoutMs: LIST_TIMEOUT_MS,
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `xcrun simctl list failed (exit ${proc.exitCode}): ${proc.stderr.toString('utf8').trim().slice(0, 500)}`
    );
  }
  const parsed = JSON.parse(proc.stdout.toString('utf8')) as {
    devices: Record<string, Array<{ name?: string; state?: string; udid?: string }>>;
  };
  const out: IosSimulator[] = [];
  for (const runtime of Object.values(parsed.devices ?? {})) {
    for (const d of runtime) {
      if (typeof d.udid === 'string' && typeof d.name === 'string' && typeof d.state === 'string') {
        out.push({ name: d.name, state: d.state, udid: d.udid });
      }
    }
  }
  iosCache = { result: out, timestamp: Date.now() };
  return out;
};

export const listAndroidDevices = async (runner: ProcessRunner): Promise<AndroidDevice[]> => {
  if (androidCache && Date.now() - androidCache.timestamp < CACHE_TTL_MS) {
    return androidCache.result;
  }
  const proc = await runner('adb', ['devices'], { timeoutMs: LIST_TIMEOUT_MS });
  if (proc.exitCode !== 0) {
    throw new Error(
      `adb devices failed (exit ${proc.exitCode}): ${proc.stderr.toString('utf8').trim().slice(0, 500)}`
    );
  }
  const lines = proc.stdout.toString('utf8').split('\n');
  const out: AndroidDevice[] = [];
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const match = line.match(/^(\S+)\s+(\S+)\s*$/);
    if (match?.[1] && match[2]) {
      out.push({ serial: match[1], state: match[2] });
    }
  }
  androidCache = { result: out, timestamp: Date.now() };
  return out;
};

const matchIosSimByClient = (sims: IosSimulator[], client: ClientEntry): IosSimulator | null => {
  const bootedIos = sims.filter((s) => {
    return s.state === 'Booted';
  });
  if (bootedIos.length === 0) {
    return null;
  }
  if (!client.label) {
    return bootedIos.length === 1 ? bootedIos[0]! : null;
  }
  const label = client.label;
  const exact = bootedIos.filter((s) => {
    return s.name === label;
  });
  if (exact.length === 1) {
    return exact[0]!;
  }
  const substring = bootedIos.filter((s) => {
    return s.name.includes(label);
  });
  if (substring.length === 1) {
    return substring[0]!;
  }
  if (exact.length === 0 && substring.length === 0 && bootedIos.length === 1) {
    return bootedIos[0]!;
  }
  return null;
};

const matchAndroidDeviceByClient = (devices: AndroidDevice[]): AndroidDevice | null => {
  const online = devices.filter((d) => {
    return d.state === 'device';
  });
  return online.length === 1 ? online[0]! : null;
};

const resolveIosClient = async (
  client: ClientEntry,
  runner: ProcessRunner
): Promise<DeviceResolution> => {
  try {
    const sims = await listIosSimulators(runner);
    const matched = matchIosSimByClient(sims, client);
    if (matched) {
      return {
        device: { displayName: matched.name, nativeId: matched.udid, platform: 'ios' },
        ok: true,
      };
    }
    const bootedList = sims
      .filter((s) => {
        return s.state === 'Booted';
      })
      .map((s) => {
        return `${s.name} (${s.udid})`;
      })
      .join(', ');
    return {
      error: `Cannot resolve iOS client '${client.id}' to a booted simulator. Label hint: "${client.label ?? '(none)'}". Booted sims: ${bootedList || '(none)'}.`,
      ok: false,
    };
  } catch (err) {
    if (err instanceof ProcessNotFoundError) {
      return {
        error: 'xcrun not found. iOS host tools require Xcode command line tools (macOS only).',
        ok: false,
      };
    }
    return {
      error: `Failed to list iOS simulators: ${(err as Error).message}`,
      ok: false,
    };
  }
};

const resolveAndroidClient = async (
  client: ClientEntry,
  runner: ProcessRunner
): Promise<DeviceResolution> => {
  try {
    const devices = await listAndroidDevices(runner);
    const matched = matchAndroidDeviceByClient(devices);
    if (matched) {
      return {
        device: {
          displayName: matched.serial,
          nativeId: matched.serial,
          platform: 'android',
        },
        ok: true,
      };
    }
    const onlineList = devices
      .filter((d) => {
        return d.state === 'device';
      })
      .map((d) => {
        return d.serial;
      })
      .join(', ');
    return {
      error: `Cannot resolve Android client '${client.id}' to an online device. Online devices: ${onlineList || '(none)'}.`,
      ok: false,
    };
  } catch (err) {
    if (err instanceof ProcessNotFoundError) {
      return {
        error: 'adb not found. Android host tools require Android platform-tools on PATH.',
        ok: false,
      };
    }
    return {
      error: `Failed to list Android devices: ${(err as Error).message}`,
      ok: false,
    };
  }
};

const resolveClientToDevice = async (
  client: ClientEntry,
  runner: ProcessRunner
): Promise<DeviceResolution> => {
  if (client.platform === 'ios') {
    return resolveIosClient(client, runner);
  }
  if (client.platform === 'android') {
    return resolveAndroidClient(client, runner);
  }
  return {
    error: `Client '${client.id}' has unknown platform '${client.platform ?? '(none)'}'. Cannot resolve to a native device.`,
    ok: false,
  };
};

const scanIosDevices = async (runner: ProcessRunner): Promise<DeviceResolution> => {
  try {
    const sims = await listIosSimulators(runner);
    const booted = sims.filter((s) => {
      return s.state === 'Booted';
    });
    if (booted.length === 0) {
      return {
        error:
          'No booted iOS simulator found. Boot one via Simulator.app or `xcrun simctl boot <udid>`.',
        ok: false,
      };
    }
    if (booted.length === 1) {
      const only = booted[0]!;
      return {
        device: { displayName: only.name, nativeId: only.udid, platform: 'ios' },
        ok: true,
      };
    }
    const list = booted
      .map((s) => {
        return `${s.name} (${s.udid})`;
      })
      .join(', ');
    return {
      error: `Multiple iOS simulators booted: ${list}. Specify clientId or a more precise target.`,
      ok: false,
    };
  } catch (err) {
    if (err instanceof ProcessNotFoundError) {
      return {
        error: 'xcrun not found. iOS host tools require Xcode command line tools (macOS only).',
        ok: false,
      };
    }
    return {
      error: `Failed to list iOS simulators: ${(err as Error).message}`,
      ok: false,
    };
  }
};

const scanAndroidDevices = async (runner: ProcessRunner): Promise<DeviceResolution> => {
  try {
    const devices = await listAndroidDevices(runner);
    const online = devices.filter((d) => {
      return d.state === 'device';
    });
    if (online.length === 0) {
      return {
        error: 'No online Android device found. Start an emulator or connect a device.',
        ok: false,
      };
    }
    if (online.length === 1) {
      const only = online[0]!;
      return {
        device: {
          displayName: only.serial,
          nativeId: only.serial,
          platform: 'android',
        },
        ok: true,
      };
    }
    const list = online
      .map((d) => {
        return d.serial;
      })
      .join(', ');
    return {
      error: `Multiple Android devices online: ${list}. Specify clientId.`,
      ok: false,
    };
  } catch (err) {
    if (err instanceof ProcessNotFoundError) {
      return {
        error: 'adb not found. Android host tools require Android platform-tools on PATH.',
        ok: false,
      };
    }
    return {
      error: `Failed to list Android devices: ${(err as Error).message}`,
      ok: false,
    };
  }
};

const scanForDevice = async (
  platform: 'android' | 'ios' | undefined,
  runner: ProcessRunner
): Promise<DeviceResolution> => {
  if (platform === 'ios') {
    return scanIosDevices(runner);
  }
  if (platform === 'android') {
    return scanAndroidDevices(runner);
  }
  const iosResult = await scanIosDevices(runner);
  if (iosResult.ok) {
    return iosResult;
  }
  const androidResult = await scanAndroidDevices(runner);
  if (androidResult.ok) {
    return androidResult;
  }
  return {
    error: `No device available. iOS: ${iosResult.error} Android: ${androidResult.error}`,
    ok: false,
  };
};

export const resolveDevice = async (
  ctx: HostContext,
  options: ResolveOptions,
  runner: ProcessRunner
): Promise<DeviceResolution> => {
  // Step 1: explicit clientId — resolve it, no bare-scan fallback
  if (ctx.requestedClientId) {
    const client = ctx.bridge.getClient(ctx.requestedClientId);
    if (!client) {
      const available =
        ctx.bridge
          .listClients()
          .map((c) => {
            return c.id;
          })
          .join(', ') || '(none)';
      return {
        error: `Client '${ctx.requestedClientId}' not connected. Available: ${available}`,
        ok: false,
      };
    }
    return resolveClientToDevice(client, runner);
  }

  // Step 2: exactly one connected client matching the platform filter → auto-pick
  const clients = ctx.bridge.listClients();
  const filtered = options.platform
    ? clients.filter((c) => {
        return c.platform === options.platform;
      })
    : clients;

  if (filtered.length === 1) {
    return resolveClientToDevice(filtered[0]!, runner);
  }

  // Step 3: multiple matching clients → ambiguous, error
  if (filtered.length > 1) {
    const labels = filtered
      .map((c) => {
        return c.label ? `${c.id} (${c.label})` : c.id;
      })
      .join(', ');
    return {
      error: `Multiple clients connected: ${labels}. Specify clientId.`,
      ok: false,
    };
  }

  // Step 4: no clients matched — fall through to bare platform scan
  return scanForDevice(options.platform, runner);
};

export const enrichDevicesWithClientStatus = async (
  bridge: Bridge,
  runner: ProcessRunner
): Promise<EnrichedDeviceList> => {
  const iosPromise = listIosSimulators(runner)
    .then((sims) => {
      return { ok: true as const, sims };
    })
    .catch((err: unknown) => {
      if (err instanceof ProcessNotFoundError) {
        return { error: 'xcrun not found', ok: false as const };
      }
      return { error: (err as Error).message, ok: false as const };
    });

  const androidPromise = listAndroidDevices(runner)
    .then((devices) => {
      return { devices, ok: true as const };
    })
    .catch((err: unknown) => {
      if (err instanceof ProcessNotFoundError) {
        return { error: 'adb not found', ok: false as const };
      }
      return { error: (err as Error).message, ok: false as const };
    });

  const [iosRaw, androidRaw] = await Promise.all([iosPromise, androidPromise]);

  const clients = bridge.listClients();
  const iosClients = clients.filter((c) => {
    return c.platform === 'ios';
  });
  const androidClients = clients.filter((c) => {
    return c.platform === 'android';
  });

  let iosOut: EnrichedIosSim[] | { error: string };
  if (iosRaw.ok) {
    const enriched: EnrichedIosSim[] = iosRaw.sims.map((sim) => {
      return { ...sim, connected: false };
    });
    for (const client of iosClients) {
      if (!client.label) {
        continue;
      }
      const label = client.label;
      const exact = enriched.filter((s) => {
        return s.state === 'Booted' && !s.connected && s.name === label;
      });
      if (exact.length === 1) {
        exact[0]!.connected = true;
        exact[0]!.clientId = client.id;
        continue;
      }
      const substring = enriched.filter((s) => {
        return s.state === 'Booted' && !s.connected && s.name.includes(label);
      });
      if (substring.length === 1) {
        substring[0]!.connected = true;
        substring[0]!.clientId = client.id;
      }
    }
    enriched.sort((a, b) => {
      const rank = (item: EnrichedIosSim): number => {
        if (item.connected) {
          return 0;
        }
        return item.state === 'Booted' ? 1 : 2;
      };
      const aRank = rank(a);
      const bRank = rank(b);
      if (aRank !== bRank) {
        return aRank - bRank;
      }
      if (a.connected && b.connected) {
        return (a.clientId ?? '').localeCompare(b.clientId ?? '');
      }
      return a.name.localeCompare(b.name);
    });
    iosOut = enriched;
  } else {
    iosOut = { error: iosRaw.error };
  }

  let androidOut: EnrichedAndroidDevice[] | { error: string };
  if (androidRaw.ok) {
    const enriched: EnrichedAndroidDevice[] = androidRaw.devices.map((d) => {
      return { ...d, connected: false };
    });
    const onlineIdx = enriched.findIndex((d) => {
      return d.state === 'device';
    });
    const onlineCount = enriched.filter((d) => {
      return d.state === 'device';
    }).length;
    if (onlineCount === 1 && androidClients.length === 1 && onlineIdx >= 0) {
      enriched[onlineIdx]!.connected = true;
      enriched[onlineIdx]!.clientId = androidClients[0]!.id;
    }
    enriched.sort((a, b) => {
      const rank = (item: EnrichedAndroidDevice): number => {
        if (item.connected) {
          return 0;
        }
        return item.state === 'device' ? 1 : 2;
      };
      const aRank = rank(a);
      const bRank = rank(b);
      if (aRank !== bRank) {
        return aRank - bRank;
      }
      if (a.connected && b.connected) {
        return (a.clientId ?? '').localeCompare(b.clientId ?? '');
      }
      return a.serial.localeCompare(b.serial);
    });
    androidOut = enriched;
  } else {
    androidOut = { error: androidRaw.error };
  }

  return { android: androidOut, ios: iosOut };
};
