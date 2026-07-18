import { z } from 'zod';

import { resolveDevice } from '@/server/host/deviceResolver';
import {
  NATIVE_ID_SCHEMA,
  parseCoord,
  parseResolveOptions,
  PLATFORM_ARG_SCHEMA,
} from '@/server/host/helpers';
import { tapIos } from '@/server/host/iosInput';
import { type ProcessRunner } from '@/server/host/processRunner';
import { type HostToolHandler } from '@/server/host/types';

import { tapAndroid } from './android';
import { INPUT_TIMEOUT_MS } from './constants';

export const tapTool = (runner: ProcessRunner): HostToolHandler => {
  return {
    description:
      'Primary way to deliver a tap to the app, at physical-pixel (x, y). Runs through the real OS gesture pipeline so Pressable feedback, gesture responders, and hit-test all fire. For a fiber-targeted tap without copying bounds by hand, prefer host__tap_fiber.',
    handler: async (args, ctx) => {
      const resolved = await resolveDevice(ctx, parseResolveOptions(args), runner);
      if (!resolved.ok) {
        return { error: resolved.error };
      }
      const x = parseCoord(args.x, 'x');
      if (!x.ok) return { error: x.error };
      const y = parseCoord(args.y, 'y');
      if (!y.ok) return { error: y.error };
      const result =
        resolved.device.platform === 'ios'
          ? await tapIos(resolved.device.nativeId, x.value, y.value, runner)
          : await tapAndroid(resolved.device.nativeId, x.value, y.value, runner);
      if ('error' in result) {
        return { error: result.error };
      }
      return { device: resolved.device, tapped: true, x: x.value, y: y.value };
    },
    inputSchema: z.looseObject({
      platform: PLATFORM_ARG_SCHEMA,
      x: z.number().min(0).describe('Absolute x pixel coordinate (top-left origin).'),
      y: z.number().min(0).describe('Absolute y pixel coordinate (top-left origin).'),
      ...NATIVE_ID_SCHEMA,
    }),
    timeout: INPUT_TIMEOUT_MS,
  };
};
