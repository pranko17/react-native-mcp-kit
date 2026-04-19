import { enrichDevicesWithClientStatus } from '@/server/host/deviceResolver';
import { type ProcessRunner } from '@/server/host/processRunner';
import { type HostToolHandler } from '@/server/host/types';

import { SCREENSHOT_TIMEOUT_MS } from './capture';

export const listDevicesTool = (runner: ProcessRunner): HostToolHandler => {
  return {
    description:
      'Enumerate visible iOS simulators + Android devices. Connected clients are annotated with their clientId; connected devices are listed first in each platform group.',
    handler: async (_args, ctx) => {
      return enrichDevicesWithClientStatus(ctx.bridge, runner);
    },
    inputSchema: {},
    timeout: SCREENSHOT_TIMEOUT_MS,
  };
};
