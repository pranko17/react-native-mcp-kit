import { type ClientEntry } from '@/server/bridge';
import { type ProcessRunner } from '@/server/host/processRunner';

import {
  ADB_MISSING_ERROR,
  listAndroidDevices,
  listIosRealDevices,
  listIosSimulators,
  toDeviceError,
  XCRUN_MISSING_ERROR,
} from './list';
import {
  type AndroidDevice,
  type DeviceResolution,
  type IosRealDevice,
  type IosSimulator,
} from './types';

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

const matchIosRealDeviceByClient = (
  devices: IosRealDevice[],
  client: ClientEntry
): IosRealDevice | null => {
  const paired = devices.filter((d) => {
    return d.pairingState === 'paired';
  });
  if (paired.length === 0) return null;
  if (!client.label) {
    return paired.length === 1 ? paired[0]! : null;
  }
  const label = client.label;
  const substring = paired.filter((d) => {
    return d.name.includes(label) || label.includes(d.name);
  });
  if (substring.length === 1) return substring[0]!;
  return paired.length === 1 ? paired[0]! : null;
};

const resolveIosRealClient = async (
  client: ClientEntry,
  runner: ProcessRunner
): Promise<DeviceResolution> => {
  try {
    const devices = await listIosRealDevices(runner);
    const matched = matchIosRealDeviceByClient(devices, client);
    if (matched) {
      return {
        device: {
          bundleId: client.bundleId,
          displayName: matched.name,
          kind: 'real-device',
          nativeId: matched.coreDeviceIdentifier,
          platform: 'ios',
        },
        ok: true,
      };
    }
    const pairedList = devices
      .filter((d) => {
        return d.pairingState === 'paired';
      })
      .map((d) => {
        return `${d.name} (${d.coreDeviceIdentifier})`;
      })
      .join(', ');
    return {
      error: `Cannot resolve iOS client '${client.id}' to a paired real device. Label hint: "${client.label ?? '(none)'}". Paired devices: ${pairedList || '(none)'}.`,
      ok: false,
    };
  } catch (err) {
    return toDeviceError(err, 'Failed to list iOS real devices', XCRUN_MISSING_ERROR);
  }
};

const resolveIosClient = async (
  client: ClientEntry,
  runner: ProcessRunner
): Promise<DeviceResolution> => {
  if (client.isSimulator === false) {
    return resolveIosRealClient(client, runner);
  }
  try {
    const sims = await listIosSimulators(runner);
    const matched = matchIosSimByClient(sims, client);
    if (matched) {
      return {
        device: {
          bundleId: client.bundleId,
          displayName: matched.name,
          kind: 'simulator',
          nativeId: matched.udid,
          platform: 'ios',
        },
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
    return toDeviceError(err, 'Failed to list iOS simulators', XCRUN_MISSING_ERROR);
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
          bundleId: client.bundleId,
          displayName: matched.serial,
          kind: 'real-device',
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
    return toDeviceError(err, 'Failed to list Android devices', ADB_MISSING_ERROR);
  }
};

export const resolveClientToDevice = async (
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
