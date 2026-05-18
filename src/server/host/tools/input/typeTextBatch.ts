import { resolveDevice } from '@/server/host/deviceResolver';
import {
  NATIVE_ID_SCHEMA,
  parseCoord,
  parseResolveOptions,
  PLATFORM_ARG_SCHEMA,
} from '@/server/host/helpers';
import { tapIos, typeTextIos } from '@/server/host/iosInput';
import { type ProcessRunner } from '@/server/host/processRunner';
import { type HostToolHandler } from '@/server/host/types';

import { tapAndroid, typeTextAndroid } from './android';
import {
  BATCH_FOCUS_DELAY_DEFAULT_MS,
  BATCH_FOCUS_DELAY_MAX_MS,
  INPUT_TIMEOUT_MS,
} from './constants';

interface BatchField {
  text: string;
  x: number;
  y: number;
  submit?: boolean;
}

export const typeTextBatchTool = (runner: ProcessRunner): HostToolHandler => {
  return {
    description: `Primary way to fill multiple text fields in one call. Each field: { x, y, text, submit? }. For each entry — tap to focus, wait focusDelayMs, then type via the same semantics as host__type_text (select-all → paste on iOS; adb input text on Android). Stops on the first error and returns { filled, failedAt, error? }.

focusDelayMs default is ${BATCH_FOCUS_DELAY_DEFAULT_MS}ms — tuned for in-place TextInputs (login / signup forms, already-mounted fields). When the tap triggers a screen transition (e.g. searchBar → SearchScreen) the target input won't be mounted yet and the typed text is lost; bump focusDelayMs to 700-800. Set to 0 when the input is already focused.`,
    handler: async (args, ctx) => {
      const resolved = await resolveDevice(ctx, parseResolveOptions(args), runner);
      if (!resolved.ok) {
        return { error: resolved.error };
      }
      const fields = args.fields;
      if (!Array.isArray(fields) || fields.length === 0) {
        return { error: "'fields' must be a non-empty array of { x, y, text, submit? }." };
      }

      const focusDelayMs =
        typeof args.focusDelayMs === 'number' && Number.isFinite(args.focusDelayMs)
          ? Math.max(0, Math.min(BATCH_FOCUS_DELAY_MAX_MS, Math.floor(args.focusDelayMs)))
          : BATCH_FOCUS_DELAY_DEFAULT_MS;

      const results: Array<{ submitted: boolean; x: number; y: number }> = [];

      for (let i = 0; i < fields.length; i++) {
        const raw = fields[i] as Partial<BatchField> | null;
        if (!raw || typeof raw !== 'object') {
          return { error: `fields[${i}]: must be an object.`, failedAt: i, filled: results.length };
        }
        const x = parseCoord(raw.x, `fields[${i}].x`);
        if (!x.ok) return { error: x.error, failedAt: i, filled: results.length };
        const y = parseCoord(raw.y, `fields[${i}].y`);
        if (!y.ok) return { error: y.error, failedAt: i, filled: results.length };
        if (typeof raw.text !== 'string') {
          return {
            error: `fields[${i}].text must be a string.`,
            failedAt: i,
            filled: results.length,
          };
        }
        const submit = raw.submit === true;

        const focused =
          resolved.device.platform === 'ios'
            ? await tapIos(resolved.device.nativeId, x.value, y.value, runner)
            : await tapAndroid(resolved.device.nativeId, x.value, y.value, runner);
        if ('error' in focused) {
          return { error: focused.error, failedAt: i, filled: results.length };
        }

        // Give the soft keyboard (or a screen transition to a search-style
        // view) a beat to come up before typing. Tunable per-call because
        // navigation-triggering taps need more than in-place input focus.
        if (focusDelayMs > 0) {
          await new Promise((r) => {
            return setTimeout(r, focusDelayMs);
          });
        }

        const typed =
          resolved.device.platform === 'ios'
            ? await typeTextIos(resolved.device.nativeId, raw.text, submit, runner)
            : await typeTextAndroid(resolved.device.nativeId, raw.text, submit, runner);
        if ('error' in typed) {
          return { error: typed.error, failedAt: i, filled: results.length };
        }

        results.push({ submitted: submit, x: x.value, y: y.value });
      }

      return { device: resolved.device, fields: results, filled: results.length };
    },
    inputSchema: {
      fields: {
        description:
          'Ordered list of { x, y, text, submit? } entries. Each entry taps the coordinate to focus the input, waits focusDelayMs, then types the text.',
        examples: [
          [
            { text: 'alice@example.com', x: 120, y: 400 },
            { submit: true, text: 'pa55word', x: 120, y: 520 },
          ],
        ],
        items: {
          properties: {
            submit: { default: false, type: 'boolean' },
            text: { type: 'string' },
            x: { minimum: 0, type: 'number' },
            y: { minimum: 0, type: 'number' },
          },
          required: ['x', 'y', 'text'],
          type: 'object',
        },
        minItems: 1,
        type: 'array',
      },
      focusDelayMs: {
        default: BATCH_FOCUS_DELAY_DEFAULT_MS,
        description: 'Delay between tap and type. Use 0 to skip when the input is already focused.',
        maximum: BATCH_FOCUS_DELAY_MAX_MS,
        minimum: 0,
        type: 'number',
      },
      platform: PLATFORM_ARG_SCHEMA,
      ...NATIVE_ID_SCHEMA,
    },
    timeout: INPUT_TIMEOUT_MS * 6,
  };
};
