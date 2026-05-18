export const INPUT_TIMEOUT_MS = 5_000;

export const SWIPE_DURATION_DEFAULT_MS = 300;
export const SWIPE_DURATION_MIN_MS = 50;
export const SWIPE_DURATION_MAX_MS = 5_000;

export const LONG_PRESS_DURATION_DEFAULT_MS = 700;

export const DRAG_HOLD_DEFAULT_MS = 500;
export const DRAG_MOVE_DEFAULT_MS = 400;

export const BATCH_FOCUS_DELAY_DEFAULT_MS = 200;
export const BATCH_FOCUS_DELAY_MAX_MS = 5_000;

export const ANDROID_KEYCODES: Record<string, string> = {
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

export const KEY_NAMES = Object.keys(ANDROID_KEYCODES).sort();

export const clampSwipeDuration = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return SWIPE_DURATION_DEFAULT_MS;
  }
  return Math.max(SWIPE_DURATION_MIN_MS, Math.min(SWIPE_DURATION_MAX_MS, Math.floor(value)));
};

export const clampLongPressDuration = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return LONG_PRESS_DURATION_DEFAULT_MS;
  }
  return Math.max(SWIPE_DURATION_MIN_MS, Math.min(SWIPE_DURATION_MAX_MS, Math.floor(value)));
};
