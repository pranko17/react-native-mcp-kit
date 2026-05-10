/**
 * Hook introspection — pairs a fiber's `memoizedState` chain with the
 * `__mcp_hooks` metadata array emitted by the test-id-plugin. The metadata
 * holds the source-level identity of each hook call (`kind` + variable
 * name); React itself only stores the runtime slot. Walking both in
 * lockstep recovers names like `useState count` instead of `State[0]`.
 *
 * Two cross-cutting concerns live alongside the walker:
 *   - Slot-count estimation for unannotated library hooks (`countHookSlots`)
 *     so a custom hook that internally consumes 3 slots advances the walker
 *     by 3, not 1 — keeps trailing metadata aligned.
 *   - Custom-hook recursion (`flattenHookMeta`) so nested `__mcp_hooks` on
 *     a custom hook's `fn` get inlined into the metadata stream, with the
 *     parent emitted as an `expanded: true` synthetic record.
 *
 * Inputs come through `extractHooks` as a single `filter` bag — kinds /
 * names / withValues / projection knobs / compiled redact patterns. The
 * walker emits a flat array of `{ kind, name, hook?, via?, expanded?,
 * value? }`; `format: "tree"` post-processes into a nested shape by
 * tracking the `expanded` parents on a small stack.
 */

import { matchesAnyRedactPattern, REDACTED_VALUE } from './redact';
import { type Fiber } from './types';
import { projectFiberValue } from './utils';

export interface HookMeta {
  kind: string;
  name: string;
  /**
   * For Custom-kind entries: reference to the custom-hook function. If that
   * function was also processed by the test-id-plugin (which runs on all
   * files including node_modules by default), it will have its own
   * `__mcp_hooks` array. At read time we recursively expand these so the
   * flattened metadata mirrors the real hook-slot sequence React allocated.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn?: any;
  /**
   * Source-level hook function name (`useState`, `useAnimatedStyle`, etc.).
   * Surfaced to the agent alongside `name` so it can disambiguate variables
   * holding the same kind from different hooks (e.g. `count (useState)` vs
   * `count (useReducer)`). Optional for forward-compatibility — entries
   * from older library bundles compiled before this field was added still
   * parse cleanly.
   */
  hook?: string;
}

// Flattened entry adds the resolved `via` chain plus an `expanded` flag.
// `expanded: true` marks a parent custom-hook entry that we synthesised so
// the agent can see the call (`wrapperAnimStyle = useAnimatedStyle(...)`)
// alongside its sub-hooks; the slot-walker treats those as 0-slot, emitting
// without advancing the fiber chain.
export interface FlattenedHook extends HookMeta {
  via: string[];
  expanded?: boolean;
}

/**
 * Parsed select.hooks options used by `extractHooks`. Built from the
 * raw user-supplied object via `buildHooksOptions` in projection.ts.
 */
export interface HooksOptions {
  expansionDepth: number;
  format: 'flat' | 'tree';
  kindsSet: Set<string> | null;
  nameMatchers: Array<(n: string) => boolean> | null;
  withValues: boolean;
  // Projection of each hook value when withValues:true. depth/path/maxBytes
  // apply to the resolved hook value (e.g. useState's stored value, useRef's
  // .current). Without overrides — depth=1, no path, default maxBytes.
  valueDepth?: number;
  valueMaxBytes?: number;
  valuePath?: string;
}

/**
 * Raw shape of `select.hooks` from the agent's call. Normalised into
 * `HooksOptions` by `buildHooksOptions` in projection.ts before extraction
 * runs.
 */
export interface HooksRawOptions {
  depth?: number;
  expansionDepth?: number;
  format?: 'flat' | 'tree';
  kinds?: string[];
  maxBytes?: number;
  names?: string[];
  path?: string;
  withValues?: boolean;
}

// Parse a name pattern: `/regex/flags` → RegExp matcher; anything else →
// exact-string matcher. Same convention as log_box__ignore.
export const parseNamePattern = (raw: string): ((n: string) => boolean) => {
  const m = raw.match(/^\/(.+)\/([gimsuy]*)$/);
  if (m && m[1] !== undefined) {
    try {
      const rx = new RegExp(m[1], m[2] ?? '');
      return (n) => {
        return rx.test(n);
      };
    } catch {
      return (n) => {
        return n === raw;
      };
    }
  }
  return (n) => {
    return n === raw;
  };
};

// Try to treat `current` as a React component / native view instance and
// collapse it to a compact identifier. Native views expose
// `_internalFiberInstanceHandleDEV` / `_reactInternals`; class instances
// expose `_reactInternals`. If we find a fiber, we surface its mcpId /
// testID / component name so the agent can follow up via `query` if needed.
// If it doesn't look like a component, return null to signal "serialize
// normally".
const resolveComponentRef = (current: unknown): Record<string, unknown> | null => {
  if (current === null || current === undefined) return null;
  if (typeof current !== 'object') return null;
  const obj = current as Record<string, unknown>;

  // Pick up a fiber from the typical internal fields used by RN / React.
  const fiber =
    (obj._reactInternals as Fiber | undefined) ??
    (obj._reactInternalFiber as Fiber | undefined) ??
    (obj._internalFiberInstanceHandleDEV as Fiber | undefined) ??
    (obj._internalInstanceHandle as Fiber | undefined);

  const hasNativeTag = '_nativeTag' in obj;
  if (!fiber && !hasNativeTag) return null;

  const out: Record<string, unknown> = { __componentRef: true };

  if (fiber) {
    const props = fiber.memoizedProps as Record<string, unknown> | null | undefined;
    const mcpId = props?.['data-mcp-id'];
    const testID = props?.testID;
    if (mcpId) out.mcpId = mcpId;
    if (testID) out.testID = testID;
    const typeName =
      (fiber.type as { displayName?: string; name?: string } | null | undefined)?.displayName ??
      (fiber.type as { displayName?: string; name?: string } | null | undefined)?.name;
    if (typeName) out.componentName = typeName;
  }

  if (hasNativeTag) {
    out.nativeTag = obj._nativeTag;
    const viewConfig = obj.viewConfig as { uiViewClassName?: string } | undefined;
    if (viewConfig?.uiViewClassName) out.viewClass = viewConfig.uiViewClassName;
  }

  return out;
};

// Recognise React's effect-record shape: `{ tag: number, create: function,
// deps: null | unknown[] }` with optional `inst` / `destroy` / `next`.
// useState / useReducer / useContext memoizedState values of this exact
// shape in real user code are astronomically unlikely, so we treat this as
// a reliable "definitely not a state slot" signal.
const looksLikeEffectRecord = (raw: unknown): boolean => {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.tag === 'number' &&
    typeof r.create === 'function' &&
    (r.deps === null || r.deps === undefined || Array.isArray(r.deps))
  );
};

// Recognise the useRef shape: `{ current: X }` with NO other keys. A useState
// value that is literally an object whose sole own-key is "current" is so
// improbable in real code that we treat it as a reliable "this slot is a
// ref, not a state" signal — lets State/Custom skip ref slots that leaked in
// through custom-hook internals.
const looksLikeRefShape = (raw: unknown): boolean => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const keys = Object.keys(raw as object);
  return keys.length === 1 && keys[0] === 'current';
};

// Shape-verify a hook slot's memoizedState against its expected kind. When
// a custom hook internally uses multiple built-in hooks, our static metadata
// understates the number of slots — every subsequent pairing drifts. By
// requiring a structural match before consuming a metadata entry we can
// swallow "internal" slots and keep the rest aligned. Permissive kinds
// (State / Reducer / Context / Custom) reject only obvious mis-matches
// (currently: the effect-record shape).
const shapeMatchesKind = (raw: unknown, kind: string): boolean => {
  switch (kind) {
    case 'Ref':
      return !!raw && typeof raw === 'object' && 'current' in (raw as object);
    case 'Memo':
    case 'Callback':
      return Array.isArray(raw) && raw.length === 2 && (raw[1] === null || Array.isArray(raw[1]));
    case 'Effect':
    case 'LayoutEffect':
    case 'InsertionEffect':
      return looksLikeEffectRecord(raw);
    case 'Transition':
      return Array.isArray(raw) && raw.length === 2;
    case 'State':
    case 'Reducer':
    case 'Context':
    case 'Custom':
      // Permissive but not blind — drop obvious effect-node and ref-shape
      // slots so State/Custom metadata doesn't swallow internals of
      // preceding custom hooks.
      return !looksLikeEffectRecord(raw) && !looksLikeRefShape(raw);
    default:
      return true;
  }
};

// Pull a "useful" raw value out of a hook's memoizedState by kind. Does NOT
// project — leaves the result raw so the final `applyProjection` sees the
// real value tree (so `path` drill into hook values works). The shape here
// is purely about *which slot field* to expose for each kind (e.g. Ref's
// `.current`, Memo/Callback's first element of `[value, deps]`).
const serializeHookValue = (raw: unknown, kind: string): unknown => {
  const walk = (v: unknown): unknown => {
    return v;
  };
  switch (kind) {
    case 'Ref': {
      if (!raw || typeof raw !== 'object' || !('current' in (raw as object))) {
        return walk(raw);
      }
      const current = (raw as { current: unknown }).current;
      const componentRef = resolveComponentRef(current);
      if (componentRef) {
        return { current: componentRef };
      }
      return { current: walk(current) };
    }
    case 'Memo':
    case 'Callback':
      if (Array.isArray(raw) && raw.length === 2) {
        return { deps: raw[1], value: walk(raw[0]) };
      }
      return walk(raw);
    case 'Effect':
    case 'LayoutEffect':
    case 'InsertionEffect': {
      // React's hook slot for effects holds { tag, create, destroy, deps, next }.
      // Only `deps` is safe and useful to surface.
      const effect = raw as { deps?: unknown } | null | undefined;
      return effect && typeof effect === 'object' && 'deps' in effect
        ? { deps: effect.deps ?? null }
        : null;
    }
    default:
      return walk(raw);
  }
};

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
const HOOK_NAME_RE = /\buse[A-Z]\w*\s*\(/g;
const STRING_LITERAL_RE = /(['"`])(?:\\.|(?!\1).)*\1/g;
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /\/\/[^\n]*/g;

const countHookSlots = (fn: unknown, depth = 0, seen?: WeakSet<object>): number => {
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

// Flatten a metadata array by recursively inlining custom-hook sub-metadata.
// Stops on cycles (hook references itself) and on Custom entries whose `fn`
// isn't annotated (library hooks that bypassed the babel plugin — usually
// pre-compiled node_modules). Such unannotated entries stay as single
// records and rely on shape-check for alignment.
//
// Custom entries with annotated `fn` produce TWO records: a parent (marked
// `expanded: true`, no slot consumption) followed by all flattened
// children. This keeps the call-site visible in the output — without it
// the agent would see e.g. `wrapperAnimStyle.areAnimationsActive` deep
// in `via:` but never the `wrapperAnimStyle = useAnimatedStyle(...)`
// invocation that owns those slots.
const flattenHookMeta = (
  meta: HookMeta[],
  via: string[] = [],
  seen: WeakSet<object> = new WeakSet(),
  maxDepth = Infinity
): FlattenedHook[] => {
  const out: FlattenedHook[] = [];
  for (const entry of meta) {
    const fn = entry.fn;
    const sub: HookMeta[] | undefined =
      fn && typeof fn === 'function' && Array.isArray(fn.__mcp_hooks) ? fn.__mcp_hooks : undefined;
    // Stop expanding once `via.length` would reach the cap — at that point
    // the current entry is treated as a leaf (Custom record without
    // children). The slot-walker still pairs it with one slot, so output
    // stays internally consistent.
    if (sub && !seen.has(fn as object) && via.length < maxDepth) {
      seen.add(fn as object);
      out.push({ ...entry, expanded: true, via });
      out.push(...flattenHookMeta(sub, [...via, entry.name], seen, maxDepth));
      seen.delete(fn as object);
    } else {
      out.push({ ...entry, via });
    }
  }
  return out;
};

// Convert the flat output of the slot walker into a nested tree using the
// `via` prefix as the parent chain. Each `expanded: true` entry becomes a
// node that owns subsequent entries whose `via` extends the parent's path.
// Stack-based single pass — no recursion. Strips `expanded` from the
// returned shape since structure makes the parent obvious.
export interface HookTreeNode {
  kind: string;
  name: string;
  children?: HookTreeNode[];
  hook?: string;
  value?: unknown;
}

const flatHooksToTree = (
  flat: Array<{
    kind: string;
    name: string;
    expanded?: boolean;
    hook?: string;
    value?: unknown;
    via?: string[];
  }>
): HookTreeNode[] => {
  const root: HookTreeNode[] = [];
  // Stack of currently-open parents, indexed by their depth (= via.length
  // of THEIR own entry, since their children sit at via.length + 1).
  const parents: HookTreeNode[] = [];
  for (const entry of flat) {
    const depth = entry.via?.length ?? 0;
    while (parents.length > depth) parents.pop();
    const node: HookTreeNode = { kind: entry.kind, name: entry.name };
    if (entry.hook !== undefined) node.hook = entry.hook;
    if (entry.value !== undefined) node.value = entry.value;
    if (parents.length === 0) {
      root.push(node);
    } else {
      const parent = parents[parents.length - 1];
      if (parent) {
        parent.children = parent.children ?? [];
        parent.children.push(node);
      } else {
        root.push(node);
      }
    }
    if (entry.expanded) {
      // Push as the new active parent at this depth. Subsequent entries
      // with via.length > depth become this node's descendants.
      parents.push(node);
    }
  }
  return root;
};

export type FlatHookEntry = {
  kind: string;
  name: string;
  expanded?: boolean;
  hook?: string;
  value?: unknown;
  via?: string[];
};

export const extractHooks = (
  fiber: Fiber,
  filter: HooksOptions & { redactPatterns: RegExp[] }
): FlatHookEntry[] | HookTreeNode[] | null => {
  // React's wrapper machinery makes "where does metadata live" depend on
  // the exact HOC chain. We try the most likely homes in order:
  //
  //   1. `fiber.type.__mcp_hooks` — bare components, FunctionDeclarations,
  //      and the outer memo fiber when the chain is just memo(fn).
  //   2. `fiber.elementType.__mcp_hooks` — memo(fn) without compare.
  //      React converts the fiber to SimpleMemoComponent and rewrites
  //      `fiber.type` to the inner function (see `updateMemoComponent` in
  //      ReactFabric); our metadata sits on the outer memo wrapper, which
  //      survives only on `elementType`.
  //   3. `fiber.type.render.__mcp_hooks` — forwardRef wrapper. React lays
  //      out memo(forwardRef(fn)) as three fibers (memo → forwardRef →
  //      function). When the user queries by displayName they tend to
  //      match the middle ForwardRef fiber (whose displayName resolves
  //      via `render.displayName`); fiber.type there is the forwardRef
  //      wrapper, which holds the inner fn at `.render`. The babel plugin
  //      put plain metadata on that fn via the FunctionDecl visitor.
  //   4. `fiber.type.type.__mcp_hooks` — memo wrapper around forwardRef
  //      (or any non-function inner). Not the SimpleMemoComponent path,
  //      so `fiber.type` stays as the memo wrapper and `.type` is the
  //      inner forwardRef / class / etc. This catches getter installations
  //      on the wrapper layer too.
  const candidates: Array<unknown> = [
    fiber.type,
    fiber.elementType,
    (fiber.type as { render?: unknown } | null | undefined)?.render,
    (fiber.type as { type?: unknown } | null | undefined)?.type,
  ];
  let rawMeta: HookMeta[] | undefined;
  for (const c of candidates) {
    const m = (c as { __mcp_hooks?: HookMeta[] } | null | undefined)?.__mcp_hooks;
    if (Array.isArray(m)) {
      rawMeta = m;
      break;
    }
  }
  if (!Array.isArray(rawMeta)) return null;

  const meta = flattenHookMeta(rawMeta, [], new WeakSet(), filter.expansionDepth);

  const out: FlatHookEntry[] = [];
  let state = fiber.memoizedState;
  let metaIdx = 0;

  // Walk the fiber's hook chain and pair each slot with the next metadata
  // entry whose `kind` is shape-compatible with the slot. Strongly-shaped
  // kinds (Ref / Memo / Callback / Effect) match only the corresponding
  // React hook shape. Permissive kinds (State / Reducer / Context / Custom)
  // reject obvious mismatches (effect-record, ref-shape) so they don't
  // swallow slots belonging to preceding custom hooks.
  //
  // For Custom-leaf entries — typically black-box library hooks
  // (`useSelector`, `useQuery`, etc.) where flattenHookMeta couldn't expand
  // because `fn.__mcp_hooks` was missing — we estimate slot count via
  // `countHookSlots` and advance the fiber chain by that many slots in one
  // step. Without this, a hook that consumes 3 internal slots only
  // advances by 1 in the walker, drifting all trailing entries off the end
  // of the chain.
  const emitEntry = (entry: FlattenedHook, rawValueSlot: unknown): void => {
    const { hook, kind, name, via } = entry;
    const passesKind = !filter.kindsSet || filter.kindsSet.has(kind);
    const passesName =
      !filter.nameMatchers ||
      filter.nameMatchers.some((m) => {
        return m(name);
      });
    if (!(passesKind && passesName)) return;
    const record: {
      kind: string;
      name: string;
      expanded?: boolean;
      hook?: string;
      value?: unknown;
      via?: string[];
    } = { kind, name };
    // Prefer the babel-emitted hook name; fall back to fn.name for entries
    // produced by older bundles that predate the `hook` field.
    const resolvedHook =
      hook ?? (typeof entry.fn === 'function' ? (entry.fn.name as string | undefined) : undefined);
    if (resolvedHook) record.hook = resolvedHook;
    if (filter.withValues && rawValueSlot !== undefined) {
      // Redaction guard: mask the value (but keep kind/name/hook visible)
      // when the entry's name OR any ancestor in `via` matches a redact
      // pattern. Catches both direct sensitive hooks (`password` State)
      // and leaves nested under sensitive customs (a `value` field of
      // `useCredentials()` won't slip through).
      const isRedacted =
        matchesAnyRedactPattern(name, filter.redactPatterns) ||
        (via?.some((v) => {
          return matchesAnyRedactPattern(v, filter.redactPatterns);
        }) ??
          false);
      if (isRedacted) {
        record.value = REDACTED_VALUE;
      } else {
        let value: unknown;
        try {
          // Kind-aware extraction (Ref's .current, Memo's first slot, ...)
          // returns RAW. Then project with the user-given hook-value options
          // (path / depth / maxBytes from select.hooks). Default depth=1 so
          // each hook value stays compact even when withValues:true.
          const extracted = serializeHookValue(rawValueSlot, kind);
          value = projectFiberValue(extracted, {
            depth: filter.valueDepth ?? 1,
            maxBytes: filter.valueMaxBytes,
            path: filter.valuePath,
          });
          // Final cycle / non-serialisable check — the MCP bridge will
          // stringify this for transport, so bail now rather than killing
          // the whole response if one stray value carries a cycle past our
          // WeakSet (e.g. Proxy, lazy getter, native-bridged object).
          JSON.stringify(value);
        } catch {
          value = '[Unserialisable value]';
        }
        record.value = value;
      }
    }
    if (via && via.length > 0) record.via = via;
    if (entry.expanded) record.expanded = true;
    out.push(record);
  };

  const advanceState = (steps: number): void => {
    for (let i = 0; i < steps && state; i++) state = state.next;
  };

  while (state && metaIdx < meta.length) {
    const entry = meta[metaIdx];
    if (!entry) {
      metaIdx++;
      continue;
    }

    // Expanded parent (synthetic, marks the call-site of a recursively
    // expanded custom hook). Emit without consuming any fiber slot — the
    // children that follow are the real slot-bearing entries.
    if (entry.expanded) {
      emitEntry(entry, undefined);
      metaIdx++;
      continue;
    }

    // Custom-leaf with a known fn → recurse into source to estimate slot
    // count, then consume that many slots at once. The first slot's value
    // is exposed (best approximation of "this hook's value"); the rest are
    // skipped silently as internals of the library hook.
    if (entry.kind === 'Custom' && typeof entry.fn === 'function') {
      const slots = countHookSlots(entry.fn);
      if (slots > 1) {
        emitEntry(entry, state.memoizedState);
        advanceState(slots);
        metaIdx++;
        continue;
      }
    }

    if (!shapeMatchesKind(state.memoizedState, entry.kind)) {
      state = state.next;
      continue;
    }

    emitEntry(entry, state.memoizedState);
    metaIdx++;
    state = state.next;
  }

  // Any metadata entries left after the fiber chain ran dry didn't get a
  // slot match. Emit them anyway (without value) so the agent at least
  // sees the hook exists — this is strictly better than silently dropping,
  // and helps debug alignment issues. Common cause: a preceding Custom
  // hook consumed more slots than countHookSlots estimated.
  while (metaIdx < meta.length) {
    const entry = meta[metaIdx];
    if (entry) emitEntry(entry, undefined);
    metaIdx++;
  }
  return filter.format === 'tree' ? flatHooksToTree(out) : out;
};

/**
 * Normalise a raw `select.hooks` object into the strict `HooksOptions`
 * shape the extractor walks against. Splits ambiguous fields (`depth` →
 * `valueDepth`, etc.) and compiles name-pattern strings via
 * `parseNamePattern`. Used by `parseProjection`.
 */
export const buildHooksOptions = (raw: HooksRawOptions | undefined): HooksOptions => {
  return {
    expansionDepth:
      typeof raw?.expansionDepth === 'number' && raw.expansionDepth >= 0
        ? Math.floor(raw.expansionDepth)
        : Infinity,
    format: raw?.format === 'tree' ? 'tree' : 'flat',
    kindsSet: Array.isArray(raw?.kinds) ? new Set(raw.kinds) : null,
    nameMatchers: Array.isArray(raw?.names) ? raw.names.map(parseNamePattern) : null,
    valueDepth: typeof raw?.depth === 'number' && raw.depth >= 0 ? raw.depth : undefined,
    valueMaxBytes:
      typeof raw?.maxBytes === 'number' && raw.maxBytes >= 0 ? raw.maxBytes : undefined,
    valuePath: typeof raw?.path === 'string' ? raw.path : undefined,
    withValues: raw?.withValues === true,
  };
};
