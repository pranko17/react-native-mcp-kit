import {
  type EnrichedAndroidDevice,
  type EnrichedDeviceList,
  type EnrichedIosSim,
  enrichDevicesWithClientStatus,
} from '@/server/host/deviceResolver';
import { type ProcessRunner } from '@/server/host/processRunner';
import { type HostToolHandler } from '@/server/host/types';

import { SCREENSHOT_TIMEOUT_MS } from './capture';

const filterConnected = (devices: EnrichedDeviceList): EnrichedDeviceList => {
  const onlyConnectedIos = (item: EnrichedIosSim): boolean => {
    return item.connected;
  };
  const onlyConnectedAndroid = (item: EnrichedAndroidDevice): boolean => {
    return item.connected;
  };
  return {
    android: Array.isArray(devices.android)
      ? devices.android.filter(onlyConnectedAndroid)
      : devices.android,
    ios: Array.isArray(devices.ios) ? devices.ios.filter(onlyConnectedIos) : devices.ios,
  };
};

export const listDevicesTool = (runner: ProcessRunner): HostToolHandler => {
  return {
    description:
      'Enumerate visible iOS simulators + Android devices. Connected clients are annotated with their clientId; connected devices are listed first in each platform group. Pass `connected: true` to filter to only devices with a live MCP client attached.',
    handler: async (args, ctx) => {
      const all = await enrichDevicesWithClientStatus(ctx.bridge, runner);
      return args.connected === true ? filterConnected(all) : all;
    },
    inputSchema: {
      connected: {
        default: false,
        description:
          'When true, drop devices without an attached MCP client. Error envelopes for each platform are preserved.',
        type: 'boolean',
      },
    },
    timeout: SCREENSHOT_TIMEOUT_MS,
  };
};
