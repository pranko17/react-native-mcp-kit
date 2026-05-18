import { type ProcessRunner } from '@/server/host/processRunner';

import {
  ADB_MISSING_ERROR,
  listAndroidDevices,
  listIosSimulators,
  toDeviceError,
  XCRUN_MISSING_ERROR,
} from './list';
import { type DeviceResolution } from './types';

export const resolveIosByUdid = async (
  udid: string,
  runner: ProcessRunner
): Promise<DeviceResolution> => {
  try {
    const sims = await listIosSimulators(runner);
    const match = sims.find((s) => {
      return s.udid === udid;
    });
    if (!match) {
      const available =
        sims
          .map((s) => {
            return `${s.udid} (${s.name})`;
          })
          .join(', ') || '(none)';
      return {
        error: `iOS simulator with UDID '${udid}' not found. Available: ${available}`,
        ok: false,
      };
    }
    if (match.state !== 'Booted') {
      return {
        error: `iOS simulator '${match.name}' (${udid}) is in state '${match.state}', not Booted. Boot it first via xcrun simctl boot.`,
        ok: false,
      };
    }
    return {
      device: {
        displayName: match.name,
        kind: 'simulator',
        nativeId: match.udid,
        platform: 'ios',
      },
      ok: true,
    };
  } catch (err) {
    return toDeviceError(err, 'Failed to list iOS simulators', XCRUN_MISSING_ERROR);
  }
};

export const resolveAndroidBySerial = async (
  serial: string,
  runner: ProcessRunner
): Promise<DeviceResolution> => {
  try {
    const devices = await listAndroidDevices(runner);
    const match = devices.find((d) => {
      return d.serial === serial;
    });
    if (!match) {
      const available =
        devices
          .map((d) => {
            return d.serial;
          })
          .join(', ') || '(none)';
      return {
        error: `Android device with serial '${serial}' not found. Available: ${available}`,
        ok: false,
      };
    }
    if (match.state !== 'device') {
      return {
        error: `Android device '${serial}' is in state '${match.state}', not 'device' (ready). Wait for boot to complete.`,
        ok: false,
      };
    }
    return {
      device: {
        displayName: match.serial,
        kind: 'real-device',
        nativeId: match.serial,
        platform: 'android',
      },
      ok: true,
    };
  } catch (err) {
    return toDeviceError(err, 'Failed to list Android devices', ADB_MISSING_ERROR);
  }
};
