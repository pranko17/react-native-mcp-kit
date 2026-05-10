/**
 * `react-native-device-info` is treated as an OPTIONAL peer dependency
 * everywhere in this library — the handshake (`McpClient.autoDetectIdentity`),
 * the `device.info` aggregate read, and any future consumers all reach for
 * the package the same way: lazy `require`, swallow ENOENT-style failures,
 * fall back to `null` when it's not installed.
 *
 * This module centralises that pattern so the require lives in exactly one
 * place. Consumers either call `loadDeviceInfo()` and check for null, or use
 * the safe-call helpers below to invoke single fields without each site
 * re-implementing the try/catch.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDI = any;

let cachedDI: AnyDI | null | undefined;

/**
 * Load `react-native-device-info` once and cache the result (including the
 * negative case — repeated calls don't re-require when the package is
 * absent). Returns the unwrapped module (`.default` or namespace) or `null`
 * when the package isn't installed / fails to resolve.
 */
export const loadDeviceInfo = (): AnyDI | null => {
  if (cachedDI !== undefined) return cachedDI;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const di = require('react-native-device-info');
    cachedDI = di.default ?? di;
  } catch {
    cachedDI = null;
  }
  return cachedDI;
};

/** Test-only: drop the memoised module so the next call re-requires. */
export const __resetDeviceInfoCache = (): void => {
  cachedDI = undefined;
};

/**
 * Call a sync method on the DI module if it exists. Returns `fallback`
 * (default `null`) when the function is missing or throws. Useful for
 * older device-info versions where individual getters may be absent.
 */
export const callDI = <T>(fn: unknown, fallback: T | null = null): T | null => {
  if (typeof fn !== 'function') return fallback;
  try {
    return fn() as T;
  } catch {
    return fallback;
  }
};

/** Async variant of `callDI` for DI methods that return Promises. */
export const callDIAsync = async <T>(fn: unknown, fallback: T | null = null): Promise<T | null> => {
  if (typeof fn !== 'function') return fallback;
  try {
    return (await fn()) as T;
  } catch {
    return fallback;
  }
};

/**
 * Standard "package not available" payload used by both the device module
 * and any other consumer that wants to surface the absence consistently.
 */
export const DEVICE_INFO_UNAVAILABLE = {
  reason:
    'react-native-device-info is not installed. Add it as a dependency to expose battery / memory / disk / extended identity fields.',
  unavailable: true,
} as const;
