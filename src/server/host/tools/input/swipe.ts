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
  clampSwipeDuration,
  INPUT_TIMEOUT_MS,
  SWIPE_DURATION_DEFAULT_MS,
  SWIPE_DURATION_MAX_MS,
  SWIPE_DURATION_MIN_MS,
} from './constants';

export const swipeTool = (runner: ProcessRunner): HostToolHandler => {
  return {
    description:
      'Primary way to deliver a swipe / scroll gesture, from (x1, y1) to (x2, y2) in physical pixels. Runs through the OS gesture pipeline — Pan responders, scroll momentum, and gesture handlers all behave as under a finger. durationMs default 300, clamped 50..5000.',
    handler: async (args, ctx) => {
      const resolved = await resolveDevice(ctx, parseResolveOptions(args), runner);
      if (!resolved.ok) {
        return { error: resolved.error };
      }
      const x1 = parseCoord(args.x1, 'x1');
      if (!x1.ok) return { error: x1.error };
      const y1 = parseCoord(args.y1, 'y1');
      if (!y1.ok) return { error: y1.error };
      const x2 = parseCoord(args.x2, 'x2');
      if (!x2.ok) return { error: x2.error };
      const y2 = parseCoord(args.y2, 'y2');
      if (!y2.ok) return { error: y2.error };
      const durationMs = clampSwipeDuration(args.durationMs);
      const result =
        resolved.device.platform === 'ios'
          ? await swipeIos(
              resolved.device.nativeId,
              x1.value,
              y1.value,
              x2.value,
              y2.value,
              durationMs,
              runner
            )
          : await swipeAndroid(
              resolved.device.nativeId,
              x1.value,
              y1.value,
              x2.value,
              y2.value,
              durationMs,
              runner
            );
      if ('error' in result) {
        return { error: result.error };
      }
      return {
        device: resolved.device,
        durationMs,
        from: { x: x1.value, y: y1.value },
        swiped: true,
        to: { x: x2.value, y: y2.value },
      };
    },
    inputSchema: {
      durationMs: {
        default: SWIPE_DURATION_DEFAULT_MS,
        description: 'Total swipe duration in milliseconds.',
        maximum: SWIPE_DURATION_MAX_MS,
        minimum: SWIPE_DURATION_MIN_MS,
        type: 'number',
      },
      platform: PLATFORM_ARG_SCHEMA,
      x1: {
        description: 'Start x pixel coordinate (top-left origin).',
        minimum: 0,
        type: 'number',
      },
      x2: { description: 'End x pixel coordinate (top-left origin).', minimum: 0, type: 'number' },
      y1: {
        description: 'Start y pixel coordinate (top-left origin).',
        minimum: 0,
        type: 'number',
      },
      y2: { description: 'End y pixel coordinate (top-left origin).', minimum: 0, type: 'number' },
      ...NATIVE_ID_SCHEMA,
    },
    timeout: INPUT_TIMEOUT_MS + SWIPE_DURATION_MAX_MS,
  };
};
