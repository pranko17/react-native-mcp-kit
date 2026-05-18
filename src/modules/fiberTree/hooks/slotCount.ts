import { type HookMeta } from './types';

// Estimate how many slots in fiber.memoizedState a hook function consumes.
// Used by the slot-walker to advance past unannotated black-box library
// hooks (e.g. `useSelector` from react-redux) which our babel plugin couldn't
// expand statically — without this they'd consume only one fiber slot during
// alignment, drifting the rest of the metadata out of sync.
//
// Three cascading strategies, falling through on miss:
//   1. `fn.__mcp_hooks` recursive — accurate for any hook our plugin saw.
//      Custom sub-entries recurse; built-in entries count as 1.
//   2. `fn.toString()` regex — counts `useXxx(` calls in the source. Works
//      even after Metro bundling because hook references survive as
//      property accesses (`(0, _react.useState)(...)`) — property names
//      aren't mangled. Underestimates when nested customs themselves expand
//      to multiple slots, but better than 1.
//   3. Default 1 — native functions, bound functions, or sources we can't
//      parse. Same as the original behavior.
//
// Cached per-function via WeakMap so cost is paid once per hook fn per
// session.
const HOOK_SLOTS_CACHE = new WeakMap<object, number>();

// Counts hook-call occurrences inside a function's source text. Matches
// `useXxx(` (classic) and bare `use(` (React 19's `use`). Negative
// lookbehind on the bare-`use` arm filters out `.use(` method calls so
// `database.use(middleware)` / `app.use(...)` don't inflate the count.
const HOOK_NAME_RE = /\b(?<!\.)use(?:[A-Z]\w*)?\s*\(/g;
const STRING_LITERAL_RE = /(['"`])(?:\\.|(?!\1).)*\1/g;
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /\/\/[^\n]*/g;

export const countHookSlots = (fn: unknown, depth = 0, seen?: WeakSet<object>): number => {
  if (depth > 8) return 1;
  if (typeof fn !== 'function') return 1;
  const fnObj = fn as object;
  const cached = HOOK_SLOTS_CACHE.get(fnObj);
  if (cached !== undefined) return cached;

  const localSeen = seen ?? new WeakSet<object>();
  if (localSeen.has(fnObj)) return 1;
  localSeen.add(fnObj);

  // (1) Annotated metadata: recurse into sub-entries, summing their slot
  // counts. Each built-in entry contributes 1; each Custom contributes
  // however many its own fn does (recurse).
  const annotated = (fn as { __mcp_hooks?: HookMeta[] }).__mcp_hooks;
  if (Array.isArray(annotated)) {
    let total = 0;
    for (const entry of annotated) {
      if (entry && entry.kind === 'Custom' && typeof entry.fn === 'function') {
        total += countHookSlots(entry.fn, depth + 1, localSeen);
      } else {
        total += 1;
      }
    }
    const result = Math.max(total, 1);
    HOOK_SLOTS_CACHE.set(fnObj, result);
    return result;
  }

  // (2) toString-based parsing. Strip strings/comments first to avoid
  // matching `'useState'` inside literals. Each `useXxx(` occurrence in
  // remaining source counts as one hook call (≥ 1 slot). Custom hook calls
  // we encounter here can't be resolved further (no scope binding from the
  // outer function), so we bottom out at 1 slot per occurrence — still
  // beats the original constant-1 fallback when the source has multiple
  // hook calls (e.g. `useSyncExternalStoreWithSelector` internals).
  let src: string;
  try {
    src = Function.prototype.toString.call(fn);
  } catch {
    HOOK_SLOTS_CACHE.set(fnObj, 1);
    return 1;
  }
  if (!src || src.includes('[native code]')) {
    HOOK_SLOTS_CACHE.set(fnObj, 1);
    return 1;
  }
  const stripped = src
    .replace(STRING_LITERAL_RE, '""')
    .replace(BLOCK_COMMENT_RE, '')
    .replace(LINE_COMMENT_RE, '');
  HOOK_NAME_RE.lastIndex = 0;
  const matches = stripped.match(HOOK_NAME_RE);
  const result = matches ? matches.length : 1;
  HOOK_SLOTS_CACHE.set(fnObj, result);
  return result;
};
