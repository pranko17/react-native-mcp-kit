/**
 * `react-native` is a peer dependency of this library — when running inside
 * an RN app it's always present, but tests / docs / SDK-level code may load
 * modules without RN around. Centralise the `require('react-native')` here
 * so consumers don't each grow their own try / catch.
 *
 * Two entry points:
 *   - `getRN()` — bare require. Use from modules that are only ever invoked
 *     in-app (alert, device, logBox, fiberTree). Throws if the package is
 *     missing.
 *   - `loadRN()` — try-wrapped + memoised. Returns `null` when RN can't be
 *     resolved (e.g. handshake code running before bundle / in server
 *     tooling). Use from code paths that need to tolerate the absence.
 *
 * Plus `loadRNInternal(path)` for private RN modules that may move between
 * RN versions (LogBox internals, getDevServer, ...). Same try-wrap + cache
 * shape so the call-site doesn't need its own boilerplate.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRN = any;

let cachedRN: AnyRN | null | undefined;
const cachedInternals = new Map<string, unknown>();

/**
 * Bare `require('react-native')`. Throws if the package isn't installed —
 * suitable for module factories that already assume an RN environment.
 */
export const getRN = (): AnyRN => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  return require('react-native');
};

/**
 * Try-wrapped `require('react-native')` with cached negative result. Returns
 * `null` when RN can't be resolved. Use this in handshake / SDK-level code
 * that wants to keep working in non-RN contexts.
 */
export const loadRN = (): AnyRN | null => {
  if (cachedRN !== undefined) return cachedRN;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const rn = require('react-native');
    cachedRN = rn.default ?? rn;
  } catch {
    cachedRN = null;
  }
  return cachedRN;
};

// Metro can't statically resolve `require(`react-native/${subPath}`)` —
// dynamic template-literal requires are silently dropped at bundle time and
// throw `Invalid call at ...`. RN private API paths must therefore be wired
// up as literal `require(...)` calls. Each entry is a thunk so the actual
// require fires on demand (and lazy-fails when the path moved in a newer RN).
/* eslint-disable @typescript-eslint/no-require-imports */
const RN_INTERNAL_LOADERS: Record<RNInternalPath, () => unknown> = {
  'Libraries/Core/Devtools/getDevServer': () => {
    return require('react-native/Libraries/Core/Devtools/getDevServer');
  },
  'Libraries/LogBox/Data/LogBoxData': () => {
    return require('react-native/Libraries/LogBox/Data/LogBoxData');
  },
};
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Known RN private sub-module paths. Add a new entry to RN_INTERNAL_LOADERS
 * alongside any new path — keeps Metro's static analyser happy.
 */
export type RNInternalPath =
  | 'Libraries/Core/Devtools/getDevServer'
  | 'Libraries/LogBox/Data/LogBoxData';

/**
 * Try-load a private RN sub-module by path. RN doesn't promise these paths
 * are stable across versions, so consumers must tolerate `null`. Result is
 * memoised per-path so repeated calls don't re-require.
 *
 * Add new paths to `RN_INTERNAL_LOADERS` above — Metro requires literal
 * `require('react-native/...')` strings to bundle the dependency.
 */
export const loadRNInternal = (subPath: RNInternalPath): unknown => {
  if (cachedInternals.has(subPath)) return cachedInternals.get(subPath) ?? null;
  const loader = RN_INTERNAL_LOADERS[subPath];
  if (!loader) {
    cachedInternals.set(subPath, null);
    return null;
  }
  try {
    const mod = loader() as { default?: unknown } | undefined;
    const unwrapped = mod?.default ?? mod ?? null;
    cachedInternals.set(subPath, unwrapped);
    return unwrapped;
  } catch {
    cachedInternals.set(subPath, null);
    return null;
  }
};

/** Test-only: drop memoised modules so the next call re-requires. */
export const __resetRNCache = (): void => {
  cachedRN = undefined;
  cachedInternals.clear();
};
