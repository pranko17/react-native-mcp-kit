import { type AppTargetError } from '@/server/host/helpers';
import { ProcessNotFoundError, type ProcessRunner } from '@/server/host/processRunner';

import { ANDROID_KEYCODES, INPUT_TIMEOUT_MS, KEY_NAMES } from './constants';

// `adb shell input text` maps characters through the default virtual keyboard
// keymap, which only covers ASCII. Anything outside that set crashes the input
// service with an opaque "Attempt to get length of null array" NPE. Refuse it
// up front with an actionable message.
// eslint-disable-next-line no-control-regex
const NON_ASCII_RE = /[^\x00-\x7F]/;

const escapeAdbInputText = (text: string): string => {
  const spaced = text.replace(/\s/g, '%s');
  return spaced.replace(/([\\'"`$&|;<>()[\]{}*?!#~])/g, '\\$1');
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

export const tapAndroid = (
  serial: string,
  x: number,
  y: number,
  runner: ProcessRunner
): Promise<{ ok: true } | AppTargetError> => {
  return runAdbInput(serial, ['tap', String(x), String(y)], runner, 'tap');
};

export const swipeAndroid = (
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

export const typeTextAndroid = async (
  serial: string,
  text: string,
  submit: boolean,
  runner: ProcessRunner
): Promise<{ ok: true } | AppTargetError> => {
  if (NON_ASCII_RE.test(text)) {
    return {
      error:
        'Android type_text only supports ASCII — `adb shell input text` has no code path for non-ASCII characters. Workarounds: tap the target field then drive the content some other way (e.g. fiber_tree__call on onChangeText), or paste from the device clipboard via a helper app.',
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

export const pressKeyAndroid = (
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
