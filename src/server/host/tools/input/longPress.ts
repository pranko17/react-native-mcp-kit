import { resolveDevice } from '@/server/host/deviceResolver';
import {
  NATIVE_ID_SCHEMA,
  parseCoord,
  parseResolveOptions,
  PLATFORM_ARG_SCHEMA,
} from '@/server/host/helpers';
import { swipeIos } from '@/server/host/iosInput';
import { type ProcessRunner } from '@/server/host/processRunner';
import { type HostToolHandler } from '@/server/host/types';

import { swipeAndroid } from './android';
import {
  clampLongPressDuration,
  INPUT_TIMEOUT_MS,
  LONG_PRESS_DURATION_DEFAULT_MS,
  SWIPE_DURATION_MAX_MS,
  SWIPE_DURATION_MIN_MS,
} from './constants';

export const longPressTool = (runner: ProcessRunner): HostToolHandler => {
  return {
    description:
      'Primary way to deliver a long-press: hold a touch at (x, y) for durationMs through the OS gesture pipeline. Default 700ms — above the RN Pressable long-press threshold (~500ms) with margin. Internally a zero-distance swipe kept alive for the full duration on both platforms.',
    handler: async (args, ctx) => {
      const resolved = await resolveDevice(ctx, parseResolveOptions(args), runner);
      if (!resolved.ok) {
        return { error: resolved.error };
      }
      const x = parseCoord(args.x, 'x');
      if (!x.ok) return { error: x.error };
      const y = parseCoord(args.y, 'y');
      if (!y.ok) return { error: y.error };
      const durationMs = clampLongPressDuration(args.durationMs);
      const result =
        resolved.device.platform === 'ios'
          ? await swipeIos(
              resolved.device.nativeId,
              x.value,
              y.value,
              x.value,
              y.value,
              durationMs,
              runner
            )
          : await swipeAndroid(
              resolved.device.nativeId,
              x.value,
              y.value,
              x.value,
              y.value,
              durationMs,
              runner
            );
      if ('error' in result) {
        return { error: result.error };
      }
      return { device: resolved.device, durationMs, longPressed: true, x: x.value, y: y.value };
    },
    inputSchema: {
      durationMs: {
        default: LONG_PRESS_DURATION_DEFAULT_MS,
        description: 'Hold duration in milliseconds.',
        maximum: SWIPE_DURATION_MAX_MS,
        minimum: SWIPE_DURATION_MIN_MS,
        type: 'number',
      },
      platform: PLATFORM_ARG_SCHEMA,
      x: { description: 'Absolute x pixel coordinate.', minimum: 0, type: 'number' },
      y: { description: 'Absolute y pixel coordinate.', minimum: 0, type: 'number' },
      ...NATIVE_ID_SCHEMA,
    },
    timeout: INPUT_TIMEOUT_MS + SWIPE_DURATION_MAX_MS,
  };
};
