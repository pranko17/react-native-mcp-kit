import { z } from 'zod';

import { resolveDevice } from '@/server/host/deviceResolver';
import {
  NATIVE_ID_SCHEMA,
  parseResolveOptions,
  parseStringArg,
  PLATFORM_ARG_SCHEMA,
} from '@/server/host/helpers';
import { pressKeyIos } from '@/server/host/iosInput';
import { type ProcessRunner } from '@/server/host/processRunner';
import { type HostToolHandler } from '@/server/host/types';

import { pressKeyAndroid } from './android';
import { INPUT_TIMEOUT_MS, KEY_NAMES } from './constants';

export const pressKeyTool = (runner: ProcessRunner): HostToolHandler => {
  return {
    description:
      'Primary way to press a hardware / semantic key — routes through the OS so native handlers (back, home, volume, etc.) fire. iOS lacks back / menu / power / volume_up / volume_down.',
    handler: async (args, ctx) => {
      const resolved = await resolveDevice(ctx, parseResolveOptions(args), runner);
      if (!resolved.ok) {
        return { error: resolved.error };
      }
      const key = parseStringArg(args.key);
      if (!key) {
        return { error: `'key' is required. Supported: ${KEY_NAMES.join(', ')}.` };
      }
      const result =
        resolved.device.platform === 'ios'
          ? await pressKeyIos(resolved.device.nativeId, key, runner)
          : await pressKeyAndroid(resolved.device.nativeId, key, runner);
      if ('error' in result) {
        return { error: result.error };
      }
      return { device: resolved.device, key, pressed: true };
    },
    inputSchema: z.looseObject({
      key: z
        .enum(KEY_NAMES as [string, ...string[]])
        .describe("Semantic key name. Mapped to the target platform's native key code internally."),
      platform: PLATFORM_ARG_SCHEMA,
      ...NATIVE_ID_SCHEMA,
    }),
    timeout: INPUT_TIMEOUT_MS,
  };
};
