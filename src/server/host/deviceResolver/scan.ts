import { type ProcessRunner } from '@/server/host/processRunner';

import {
  ADB_MISSING_ERROR,
  listAndroidDevices,
  listIosSimulators,
  toDeviceError,
  XCRUN_MISSING_ERROR,
} from './list';
import { type DeviceResolution } from './types';

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
        device: {
          displayName: only.name,
          kind: 'simulator',
          nativeId: only.udid,
          platform: 'ios',
        },
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
    return toDeviceError(err, 'Failed to list iOS simulators', XCRUN_MISSING_ERROR);
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
          kind: 'real-device',
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
    return toDeviceError(err, 'Failed to list Android devices', ADB_MISSING_ERROR);
  }
};

export const scanForDevice = async (
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
