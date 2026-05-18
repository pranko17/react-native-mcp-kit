import { type ProcessRunner } from '@/server/host/processRunner';
import { type HostContext } from '@/server/host/types';

import { resolveClientToDevice } from './byClient';
import { resolveAndroidBySerial, resolveIosByUdid } from './byId';
import { scanForDevice } from './scan';
import { type DeviceResolution } from './types';

interface ResolveOptions {
  platform?: 'android' | 'ios';
  serial?: string;
  udid?: string;
}

export const resolveDevice = async (
  ctx: HostContext,
  options: ResolveOptions,
  runner: ProcessRunner
): Promise<DeviceResolution> => {
  // Step 0: explicit native identifier — highest priority, bypasses everything else
  if (options.udid) {
    return resolveIosByUdid(options.udid, runner);
  }
  if (options.serial) {
    return resolveAndroidBySerial(options.serial, runner);
  }

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

export {
  clearDeviceCache,
  listAndroidDevices,
  listIosRealDevices,
  listIosSimulators,
} from './list';
export { enrichDevicesWithClientStatus } from './enrich';
export {
  type AndroidDevice,
  type DeviceKind,
  type DeviceResolution,
  type EnrichedAndroidDevice,
  type EnrichedDeviceList,
  type EnrichedIosSim,
  type IosRealDevice,
  type IosSimulator,
  type ResolvedDevice,
} from './types';
