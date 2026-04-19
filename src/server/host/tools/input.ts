import { resolveDevice } from '@/server/host/deviceResolver';
import {
  type AppTargetError,
  NATIVE_ID_SCHEMA,
  parseCoord,
  parseResolveOptions,
  parseStringArg,
  PLATFORM_ARG_SCHEMA,
} from '@/server/host/helpers';
import { pressKeyIos, swipeIos, tapIos, typeTextIos } from '@/server/host/iosInput';
import { ProcessNotFoundError, type ProcessRunner } from '@/server/host/processRunner';
import { type HostToolHandler } from '@/server/host/types';

const INPUT_TIMEOUT_MS = 5_000;
const SWIPE_DURATION_DEFAULT_MS = 300;
const SWIPE_DURATION_MIN_MS = 50;
const SWIPE_DURATION_MAX_MS = 5_000;

const ANDROID_KEYCODES: Record<string, string> = {
  back: 'KEYCODE_BACK',
  backspace: 'KEYCODE_DEL',
  enter: 'KEYCODE_ENTER',
  escape: 'KEYCODE_ESCAPE',
  home: 'KEYCODE_HOME',
  menu: 'KEYCODE_MENU',
  power: 'KEYCODE_POWER',
  space: 'KEYCODE_SPACE',
  tab: 'KEYCODE_TAB',
  volume_down: 'KEYCODE_VOLUME_DOWN',
  volume_up: 'KEYCODE_VOLUME_UP',
};

const KEY_NAMES = Object.keys(ANDROID_KEYCODES).sort();

const escapeAdbInputText = (text: string): string => {
  const spaced = text.replace(/\s/g, '%s');
  return spaced.replace(/([\\'"`$&|;<>()[\]{}*?!#~])/g, '\\$1');
};

const clampSwipeDuration = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return SWIPE_DURATION_DEFAULT_MS;
  }
  return Math.max(SWIPE_DURATION_MIN_MS, Math.min(SWIPE_DURATION_MAX_MS, Math.floor(value)));
};

const runAdbInput = async (
  serial: string,
  args: readonly string[],
  runner: ProcessRunner,
  action: string
): Promise<{ ok: true } | AppTargetError> => {
  try {
    const proc = await runner('adb', ['-s', serial, 'shell', 'input', ...args], {
      timeoutMs: INPUT_TIMEOUT_MS,
    });
    if (proc.timedOut) {
      return { error: `Android ${action} timed out after ${INPUT_TIMEOUT_MS}ms` };
    }
    if (proc.exitCode !== 0) {
      return {
        error: `adb shell input ${action} failed (exit ${proc.exitCode}): ${proc.stderr.toString('utf8').trim().slice(0, 500)}`,
      };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof ProcessNotFoundError) {
      return {
        error: 'adb not found. Android host tools require Android platform-tools on PATH.',
      };
    }
    return { error: `Failed to run Android ${action}: ${(err as Error).message}` };
  }
};

const tapAndroid = (
  serial: string,
  x: number,
  y: number,
  runner: ProcessRunner
): Promise<{ ok: true } | AppTargetError> => {
  return runAdbInput(serial, ['tap', String(x), String(y)], runner, 'tap');
};

const swipeAndroid = (
  serial: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs: number,
  runner: ProcessRunner
): Promise<{ ok: true } | AppTargetError> => {
  return runAdbInput(
    serial,
    ['swipe', String(x1), String(y1), String(x2), String(y2), String(durationMs)],
    runner,
    'swipe'
  );
};

// `adb shell input text` maps characters through the default virtual keyboard
// keymap, which only covers ASCII. Anything outside that set crashes the input
// service with an opaque "Attempt to get length of null array" NPE. Refuse it
// up front with an actionable message.
// eslint-disable-next-line no-control-regex
const NON_ASCII_RE = /[^\x00-\x7F]/;

const typeTextAndroid = async (
  serial: string,
  text: string,
  submit: boolean,
  runner: ProcessRunner
): Promise<{ ok: true } | AppTargetError> => {
  if (NON_ASCII_RE.test(text)) {
    return {
      error:
        'Android type_text only supports ASCII — `adb shell input text` has no code path for non-ASCII characters. Workarounds: tap the target field then drive the content some other way (e.g. fiber_tree__invoke on onChangeText), or paste from the device clipboard via a helper app.',
    };
  }

  // Select all + delete existing text first (consistent with iOS behavior).
  // `input keycombination` sends keys simultaneously (Ctrl+A = select all).
  try {
    const selAll = await runner(
      'adb',
      ['-s', serial, 'shell', 'input', 'keycombination', '113', '29'],
      {
        timeoutMs: INPUT_TIMEOUT_MS,
      }
    );
    if (selAll.exitCode === 0) {
      await runAdbInput(serial, ['keyevent', 'KEYCODE_DEL'], runner, 'clear');
    }
  } catch {
    // keycombination not supported — skip clear, just append
  }

  const escaped = escapeAdbInputText(text);
  const typed = await runAdbInput(serial, ['text', escaped], runner, 'text');
  if ('error' in typed) {
    return typed;
  }
  if (submit) {
    return runAdbInput(serial, ['keyevent', 'KEYCODE_ENTER'], runner, 'submit');
  }
  return typed;
};

const pressKeyAndroid = (
  serial: string,
  key: string,
  runner: ProcessRunner
): Promise<{ ok: true } | AppTargetError> => {
  const keycode = ANDROID_KEYCODES[key];
  if (!keycode) {
    return Promise.resolve({
      error: `Unknown key '${key}'. Supported: ${KEY_NAMES.join(', ')}.`,
    });
  }
  return runAdbInput(serial, ['keyevent', keycode], runner, 'keyevent');
};

export const tapTool = (runner: ProcessRunner): HostToolHandler => {
  return {
    description:
      'Tap at physical-pixel (x, y). Goes through the real OS gesture pipeline — prefer over fiber_tree__invoke when you want touch semantics (Pressable feedback, gesture responders, hit-test).',
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
    inputSchema: {
      platform: PLATFORM_ARG_SCHEMA,
      x: {
        description: 'Absolute x pixel coordinate (top-left origin).',
        type: 'number',
      },
      y: {
        description: 'Absolute y pixel coordinate (top-left origin).',
        type: 'number',
      },
      ...NATIVE_ID_SCHEMA,
    },
    timeout: INPUT_TIMEOUT_MS,
  };
};

export const swipeTool = (runner: ProcessRunner): HostToolHandler => {
  return {
    description:
      'Swipe / scroll from (x1, y1) to (x2, y2) in physical pixels. durationMs default 300, clamped 50..5000.',
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
        description: `Total swipe duration in milliseconds. Default ${SWIPE_DURATION_DEFAULT_MS}. Clamped to ${SWIPE_DURATION_MIN_MS}..${SWIPE_DURATION_MAX_MS}.`,
        type: 'number',
      },
      platform: PLATFORM_ARG_SCHEMA,
      x1: {
        description: 'Start x pixel coordinate (top-left origin).',
        type: 'number',
      },
      x2: {
        description: 'End x pixel coordinate (top-left origin).',
        type: 'number',
      },
      y1: {
        description: 'Start y pixel coordinate (top-left origin).',
        type: 'number',
      },
      y2: {
        description: 'End y pixel coordinate (top-left origin).',
        type: 'number',
      },
      ...NATIVE_ID_SCHEMA,
    },
    timeout: INPUT_TIMEOUT_MS + SWIPE_DURATION_MAX_MS,
  };
};

export const typeTextTool = (runner: ProcessRunner): HostToolHandler => {
  return {
    description:
      "Type text into the focused input (replaces existing content — select-all then paste). submit:true presses ENTER after typing. iOS: unicode via clipboard paste, keyboard-layout immune. Android: ASCII only (adb input text limitation); for non-Latin scripts use fiber_tree__invoke on the input's onChangeText instead.",
    handler: async (args, ctx) => {
      const resolved = await resolveDevice(ctx, parseResolveOptions(args), runner);
      if (!resolved.ok) {
        return { error: resolved.error };
      }
      const text = typeof args.text === 'string' ? args.text : undefined;
      if (text === undefined) {
        return { error: "'text' is required and must be a string" };
      }
      const submit = args.submit === true;
      const result =
        resolved.device.platform === 'ios'
          ? await typeTextIos(resolved.device.nativeId, text, submit, runner)
          : await typeTextAndroid(resolved.device.nativeId, text, submit, runner);
      if ('error' in result) {
        return { error: result.error };
      }
      return {
        device: resolved.device,
        length: text.length,
        submitted: submit,
        typed: true,
      };
    },
    inputSchema: {
      platform: PLATFORM_ARG_SCHEMA,
      submit: {
        description: 'Press ENTER after typing (e.g. to submit a search). Default false.',
        type: 'boolean',
      },
      text: {
        description:
          'Text to type into the currently focused input field. Whitespace and shell metacharacters are escaped automatically.',
        type: 'string',
      },
      ...NATIVE_ID_SCHEMA,
    },
    timeout: INPUT_TIMEOUT_MS,
  };
};

export const pressKeyTool = (runner: ProcessRunner): HostToolHandler => {
  return {
    description: `Press a hardware/semantic key. Accepted: ${KEY_NAMES.join(', ')}. iOS lacks back / menu / power / volume_up / volume_down.`,
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
    inputSchema: {
      key: {
        description: `Semantic key name. Mapped to the target platform's native key code internally. Supported: ${KEY_NAMES.join(', ')}.`,
        enum: KEY_NAMES,
        type: 'string',
      },
      platform: PLATFORM_ARG_SCHEMA,
      ...NATIVE_ID_SCHEMA,
    },
    timeout: INPUT_TIMEOUT_MS,
  };
};
