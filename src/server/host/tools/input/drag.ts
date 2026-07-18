import { z } from 'zod';

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
  DRAG_HOLD_DEFAULT_MS,
  DRAG_MOVE_DEFAULT_MS,
  INPUT_TIMEOUT_MS,
  SWIPE_DURATION_MAX_MS,
  SWIPE_DURATION_MIN_MS,
} from './constants';

export const dragTool = (runner: ProcessRunner): HostToolHandler => {
  return {
    description:
      'Primary way to deliver a hold-then-drag gesture — swipe-to-delete, drag-to-reorder, pull-to-refresh-with-hold. Total gesture time = holdMs + durationMs (both platforms emit a single slow swipe — the hold is simulated by lingering near the start, not a true stop-then-move pause). When precise hold timing matters (e.g. iOS haptic long-press triggers), test + tune holdMs empirically.',
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
      const holdMs =
        typeof args.holdMs === 'number' && Number.isFinite(args.holdMs) && args.holdMs >= 0
          ? Math.min(SWIPE_DURATION_MAX_MS, Math.floor(args.holdMs))
          : DRAG_HOLD_DEFAULT_MS;
      const moveMs = clampSwipeDuration(args.durationMs ?? DRAG_MOVE_DEFAULT_MS);
      const total = Math.min(SWIPE_DURATION_MAX_MS, holdMs + moveMs);
      const result =
        resolved.device.platform === 'ios'
          ? await swipeIos(
              resolved.device.nativeId,
              x1.value,
              y1.value,
              x2.value,
              y2.value,
              total,
              runner
            )
          : await swipeAndroid(
              resolved.device.nativeId,
              x1.value,
              y1.value,
              x2.value,
              y2.value,
              total,
              runner
            );
      if ('error' in result) {
        return { error: result.error };
      }
      return {
        device: resolved.device,
        dragged: true,
        from: { x: x1.value, y: y1.value },
        holdMs,
        moveMs,
        to: { x: x2.value, y: y2.value },
        totalMs: total,
      };
    },
    inputSchema: z.looseObject({
      durationMs: z
        .number()
        .min(SWIPE_DURATION_MIN_MS)
        .max(SWIPE_DURATION_MAX_MS)
        .describe('Move portion in milliseconds.')
        .meta({ default: DRAG_MOVE_DEFAULT_MS })
        .optional(),
      holdMs: z
        .number()
        .min(0)
        .max(SWIPE_DURATION_MAX_MS)
        .describe('Hold time near start before the motion. 0 to skip hold.')
        .meta({ default: DRAG_HOLD_DEFAULT_MS })
        .optional(),
      platform: PLATFORM_ARG_SCHEMA,
      x1: z.number().min(0).describe('Start x pixel coordinate.'),
      x2: z.number().min(0).describe('End x pixel coordinate.'),
      y1: z.number().min(0).describe('Start y pixel coordinate.'),
      y2: z.number().min(0).describe('End y pixel coordinate.'),
      ...NATIVE_ID_SCHEMA,
    }),
    timeout: INPUT_TIMEOUT_MS + SWIPE_DURATION_MAX_MS,
  };
};
