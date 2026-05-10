import { type RefObject } from 'react';

import { type McpModule } from '@/client/models/types';
import {
  applyProjection as applyProjectionCore,
  makeProjectionSchema,
  type ProjectionArgs,
} from '@/shared/projectValue';

import { type Bounds, type ComponentQuery } from './types';
import {
  findAllByQuery,
  findHostFiber,
  findScreenFiberByRouteKey,
  getAncestors,
  getAvailableMethods,
  getComponentName,
  getDirectChildren,
  getFiberRoot,
  getNativeInstance,
  getSiblings,
  matchesQuery,
  measureFiber,
  projectFiberValue,
  setRootRef,
} from './utils';

const QUERY_LIMIT_DEFAULT = 50;
const QUERY_LIMIT_MAX = 500;
const QUERY_DEFAULT_FIELDS = ['mcpId', 'name', 'testID'];

const WAIT_TIMEOUT_DEFAULT = 10_000;
const WAIT_TIMEOUT_MAX = 60_000;
const WAIT_INTERVAL_DEFAULT = 300;
const WAIT_INTERVAL_MIN = 100;

type WaitUntil = 'appear' | 'disappear';

interface HookMeta {
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
interface FlattenedHook extends HookMeta {
  via: string[];
  expanded?: boolean;
}

// Parse a name pattern: `/regex/flags` → RegExp matcher; anything else →
// exact-string matcher. Same convention as log_box__ignore.
const parseNamePattern = (raw: string): ((n: string) => boolean) => {
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
interface HookTreeNode {
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

type FlatHookEntry = {
  kind: string;
  name: string;
  expanded?: boolean;
  hook?: string;
  value?: unknown;
  via?: string[];
};

const extractHooks = (
  fiber: Fiber,
  filter: {
    expansionDepth: number;
    format: 'flat' | 'tree';
    kindsSet: Set<string> | null;
    nameMatchers: Array<(n: string) => boolean> | null;
    redactPatterns: RegExp[];
    withValues: boolean;
    valueDepth?: number;
    valueMaxBytes?: number;
    valuePath?: string;
  }
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

interface PropsOptions {
  depth?: number;
  maxBytes?: number;
  path?: string;
}

interface HooksOptions {
  expansionDepth: number;
  format: 'flat' | 'tree';
  kindsSet: Set<string> | null;
  nameMatchers: ReturnType<typeof parseNamePattern>[] | null;
  withValues: boolean;
  // Projection of each hook value when withValues:true. depth/path/maxBytes
  // apply to the resolved hook value (e.g. useState's stored value, useRef's
  // .current). Without overrides — depth=1, no path, default maxBytes.
  valueDepth?: number;
  valueMaxBytes?: number;
  valuePath?: string;
}

// `select.children` walker options — recursive shallow tree of fiber nodes.
// Strict light-only fields: heavy projection (props/hooks) is rejected at
// parse time so the walker can never blow up the response on wide trees.
const CHILDREN_DEFAULT_TREE_DEPTH = 4;
const CHILDREN_MAX_TREE_DEPTH = 16;
const CHILDREN_DEFAULT_ITEMS_CAP = 50;
const LIGHT_FIELDS = new Set(['mcpId', 'name', 'testID', 'bounds']);

interface ChildrenOptions {
  itemsCap: number;
  // Recursive: sub-children walker for next level. null = stop expanding.
  select: ChildrenSelect;
  treeDepth: number;
}

interface ChildrenSelect {
  children: ChildrenOptions | null;
  fields: Set<string>;
}

interface Projection {
  children: ChildrenOptions | null;
  fields: Set<string>;
  hooks: HooksOptions;
  props: PropsOptions;
}

interface HooksRawOptions {
  depth?: number;
  expansionDepth?: number;
  format?: 'flat' | 'tree';
  kinds?: string[];
  maxBytes?: number;
  names?: string[];
  path?: string;
  withValues?: boolean;
}

const buildHooksOptions = (raw: HooksRawOptions | undefined): HooksOptions => {
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

/**
 * Parse `select.children.select` — recursive but strictly light-only.
 *
 * Walker is meant for "map of the tree" navigation, not data extraction. So
 * `props`/`hooks` are explicitly rejected with an error: if you need a
 * fiber's props/hooks, run a second `query` against its mcpId. This caps the
 * worst-case response at treeDepth × itemsCap × ~30 bytes (≈24KB) without
 * needing per-field projection inside the walker.
 */
const parseChildrenSelect = (selectArg: unknown): ChildrenSelect => {
  const fields = new Set<string>();
  let nestedChildren: ChildrenOptions | null = null;

  if (Array.isArray(selectArg)) {
    for (const entry of selectArg) {
      if (typeof entry === 'string') {
        if (entry === 'props' || entry === 'hooks') {
          throw new Error(
            `select.children.select cannot include "${entry}" — heavy fields are not supported inside the walker. Run a second query({ steps: [{ mcpId: '<child-mcpId>' }], select: ['${entry}'] }) on the specific node instead.`
          );
        }
        if (!LIGHT_FIELDS.has(entry) && entry !== 'children') {
          throw new Error(
            `select.children.select: unknown field "${entry}". Allowed: mcpId / name / testID / bounds / { children }`
          );
        }
        if (entry !== 'children') fields.add(entry);
        continue;
      }
      if (entry && typeof entry === 'object') {
        for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
          if (value === false) continue;
          if (key === 'props' || key === 'hooks') {
            throw new Error(
              `select.children.select cannot include "${key}" — heavy fields are not supported inside the walker. Run a second query({ steps: [{ mcpId: '<child-mcpId>' }], select: ['${key}'] }) on the specific node instead.`
            );
          }
          if (key === 'children') {
            nestedChildren = parseChildrenOptions(value);
            continue;
          }
          if (!LIGHT_FIELDS.has(key)) {
            throw new Error(
              `select.children.select: unknown field "${key}". Allowed: mcpId / name / testID / bounds / { children }`
            );
          }
          fields.add(key);
        }
      }
    }
  }

  if (fields.size === 0) {
    fields.add('mcpId');
    fields.add('name');
  }

  return { children: nestedChildren, fields };
};

/**
 * Parse `{ children: N }` short form or `{ children: { treeDepth, select?,
 * itemsCap? } }` object form into a normalized ChildrenOptions.
 */
const parseChildrenOptions = (raw: unknown): ChildrenOptions => {
  // Short form: { children: 5 } → treeDepth 5, defaults
  if (typeof raw === 'number') {
    return {
      itemsCap: CHILDREN_DEFAULT_ITEMS_CAP,
      select: { children: null, fields: new Set(['mcpId', 'name']) },
      treeDepth: clampTreeDepth(raw),
    };
  }
  if (raw === true) {
    return {
      itemsCap: CHILDREN_DEFAULT_ITEMS_CAP,
      select: { children: null, fields: new Set(['mcpId', 'name']) },
      treeDepth: CHILDREN_DEFAULT_TREE_DEPTH,
    };
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as { itemsCap?: unknown; select?: unknown; treeDepth?: unknown };
    const treeDepth =
      typeof obj.treeDepth === 'number' && obj.treeDepth >= 0
        ? clampTreeDepth(obj.treeDepth)
        : CHILDREN_DEFAULT_TREE_DEPTH;
    const itemsCap =
      typeof obj.itemsCap === 'number' && obj.itemsCap >= 0
        ? Math.floor(obj.itemsCap)
        : CHILDREN_DEFAULT_ITEMS_CAP;
    const select = parseChildrenSelect(obj.select);
    return { itemsCap, select, treeDepth };
  }
  return {
    itemsCap: CHILDREN_DEFAULT_ITEMS_CAP,
    select: { children: null, fields: new Set(['mcpId', 'name']) },
    treeDepth: CHILDREN_DEFAULT_TREE_DEPTH,
  };
};

const clampTreeDepth = (n: number): number => {
  if (!Number.isFinite(n) || n < 0) return CHILDREN_DEFAULT_TREE_DEPTH;
  return Math.min(Math.floor(n), CHILDREN_MAX_TREE_DEPTH);
};

/**
 * Parse the `select` arg into a flat Projection. Each element of `select` may
 * be either a string (include the named field with default options) or an
 * object whose keys are field names and whose values are `true` / `false` /
 * per-field projection options.
 *
 * Per-field options:
 *   props: { path?, depth?, maxBytes? }   — projection of the props object
 *   hooks: HooksRawOptions                — kinds/names filters + withValues
 *                                           + path/depth/maxBytes for hook
 *                                           values
 *   children: number | { treeDepth?, select?, itemsCap? }
 *                                         — recursive light-only walker; see
 *                                           parseChildrenSelect for limits.
 *
 * Heavy fields (props, hooks) are projected handler-side with these per-field
 * options so the rest of the response (mcpId, name, total, ...) stays raw and
 * always visible.
 */
const parseProjection = (selectArg: unknown): Projection => {
  const fields = new Set<string>();
  let propsRaw: PropsOptions = {};
  let hooksRaw: HooksRawOptions | undefined;
  let childrenOpts: ChildrenOptions | null = null;

  if (Array.isArray(selectArg)) {
    for (const entry of selectArg) {
      if (typeof entry === 'string') {
        fields.add(entry);
        continue;
      }
      if (entry && typeof entry === 'object') {
        for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
          if (value === false) continue;
          if (key === 'children') {
            childrenOpts = parseChildrenOptions(value);
            continue;
          }
          fields.add(key);
          if (key === 'props' && value && typeof value === 'object') {
            propsRaw = value as PropsOptions;
          } else if (key === 'hooks' && value && typeof value === 'object') {
            hooksRaw = value as HooksRawOptions;
          }
        }
      }
    }
  }

  if (fields.size === 0) {
    for (const f of QUERY_DEFAULT_FIELDS) fields.add(f);
  }

  return {
    children: childrenOpts,
    fields,
    hooks: buildHooksOptions(hooksRaw),
    props: propsRaw,
  };
};

const FIND_SCHEMA = {
  index: {
    description: '0-based index when several components match (default: 0).',
    type: 'number',
  },
  mcpId: { description: 'Stable data-mcp-id to match.', type: 'string' },
  name: { description: 'Component name to match.', type: 'string' },
  testID: { description: 'testID to match.', type: 'string' },
  text: { description: 'Rendered text substring (not prop values).', type: 'string' },
  within: {
    description: 'Parent component path. "/" nests, ":N" picks index.',
    examples: ['LoginForm', 'Button:1/Pressable', 'TabBar/TabBarItem:2'],
    type: 'string',
  },
};

// Default depth for fiberTree handlers. Their typical response shape has
// 3 nesting layers before the heavy values start (e.g. query: response →
// matches array → match object → match fields → props content). depth=4
// shows all match-level fields with heavy nested values (props.style etc.)
// already collapsed into markers — useful balance of visibility vs lean.
const FIBER_DEFAULT_DEPTH = 4;

// Per-tool inputSchema — uses fiberTree's depth=2 default so the description
// matches reality.
const PROJECTION_SCHEMA = makeProjectionSchema(FIBER_DEFAULT_DEPTH);

// Module-local 2-arg wrapper around the shared `applyProjection` so handlers
// don't have to repeat `projectFiberValue` + default-depth on every call.
const applyProjection = (result: unknown, args: ProjectionArgs): unknown => {
  return applyProjectionCore(result, args, projectFiberValue, FIBER_DEFAULT_DEPTH);
};

// Kept deliberately loose: the module only calls getCurrentRoute at query
// time and gracefully no-ops when the shape is unexpected. This avoids
// dragging in the full React Navigation ref surface.
interface FiberTreeNavigationRef {
  getCurrentRoute?: () => unknown;
}

interface FiberTreeModuleOptions {
  /**
   * Extend the default redact list with additional patterns. Strings are
   * matched as case-insensitive substrings (so `"password"` catches
   * `password`, `oldPassword`, `passwordHash`); RegExp values are matched
   * verbatim. Use this when you want defaults plus your own.
   */
  additionalRedactHookNames?: Array<string | RegExp>;
  navigationRef?: FiberTreeNavigationRef | null;
  /**
   * Replace the default redact list entirely. Names matching any pattern
   * have their `value` masked as `"[redacted]"` in `withValues: true`
   * responses. Strings = case-insensitive substring; RegExp = literal.
   * Default list (when this option is omitted) catches the common
   * security-sensitive names: `password`, `token`, `jwt`, `secret`,
   * `credential`, `apiKey`, plus `/Pin$/` and `/passcode/i`. Pass `[]` to
   * disable redaction entirely.
   */
  redactHookNames?: Array<string | RegExp>;
  rootRef?: RefObject<unknown>;
}

// Default redact patterns — applied to a hook's `name` AND every entry in
// its `via` chain so values stay masked even when nested under a sensitive
// custom hook (e.g. a leaf `value` inside a `useAuth()` expansion). Tuned
// to match real-world variable names without over-matching innocent ones:
// `Pin$` is anchored so it doesn't catch "Spinner"; broad terms like
// `auth` are deliberately omitted (would catch `isAuthenticated`).
const DEFAULT_REDACT_HOOK_NAMES: Array<string | RegExp> = [
  /password/i,
  /token/i,
  /jwt/i,
  /secret/i,
  /Pin$/,
  /credential/i,
  /apiKey/i,
  /authorization/i,
];

const REDACTED_VALUE = '[redacted]';

const escapeRegExp = (s: string): string => {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const compileRedactPatterns = (raw: Array<string | RegExp>): RegExp[] => {
  return raw.map((p) => {
    return typeof p === 'string' ? new RegExp(escapeRegExp(p), 'i') : p;
  });
};

const matchesAnyRedactPattern = (name: string, patterns: RegExp[]): boolean => {
  for (const p of patterns) {
    if (p.test(name)) return true;
  }
  return false;
};

type QueryScope =
  | 'ancestors'
  | 'children'
  | 'descendants'
  | 'nearest_host'
  | 'parent'
  | 'root'
  | 'screen'
  | 'self'
  | 'siblings';

const VALID_SCOPES: ReadonlySet<QueryScope> = new Set([
  'ancestors',
  'children',
  'descendants',
  'nearest_host',
  'parent',
  'root',
  'screen',
  'self',
  'siblings',
]);

interface QueryStep extends ComponentQuery {
  /**
   * If provided, only the N-th match survives into the next step. Omit to
   * forward every match along (fan-out across scopes on the next step).
   */
  index?: number;
  /**
   * Which fibers relative to the previous step's result are considered for this
   * step. Defaults to 'descendants' (so the first step walks the whole tree
   * from the fiber root). Other values walk 'parent'/'ancestors'/'siblings'/
   * 'children'/'self'.
   */
  scope?: QueryScope;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fiber = any;

interface QueryRuntime {
  root: Fiber;
  navigationRef?: FiberTreeNavigationRef | null;
}

const resolveScreenFiber = (runtime: QueryRuntime): Fiber | null => {
  const nav = runtime.navigationRef;
  if (!nav || typeof nav.getCurrentRoute !== 'function') return null;
  const route = nav.getCurrentRoute() as { key?: unknown } | null | undefined;
  const key = route && typeof route.key === 'string' ? route.key : undefined;
  if (!key) return null;
  return findScreenFiberByRouteKey(runtime.root, key);
};

const collectByScope = (fiber: Fiber, scope: QueryScope, runtime: QueryRuntime): Fiber[] => {
  switch (scope) {
    case 'self':
      return [fiber];
    case 'parent':
      return fiber.return ? [fiber.return] : [];
    case 'ancestors':
      return getAncestors(fiber);
    case 'children':
      return getDirectChildren(fiber);
    case 'siblings':
      return getSiblings(fiber);
    case 'nearest_host': {
      const host = findHostFiber(fiber);
      return host ? [host] : [];
    }
    case 'root':
      // Top of the fiber tree, regardless of the previous step's match. Use
      // as the first step (e.g. `query({ steps: [{ scope: 'root' }], select:
      // [{ children: 5 }] })` to dump the whole tree). Criteria on this step
      // are matched against the root fiber itself; if you want descendants
      // of root, follow with another step using scope:'descendants'.
      return [runtime.root];
    case 'screen': {
      const screen = resolveScreenFiber(runtime);
      if (!screen) return [];
      return findAllByQuery(screen, {}).filter((f) => {
        return f !== screen;
      });
    }
    case 'descendants':
    default:
      return findAllByQuery(fiber, {}).filter((f) => {
        return f !== fiber;
      });
  }
};

const validateSteps = (steps: QueryStep[]): string | null => {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    if (step.scope !== undefined && !VALID_SCOPES.has(step.scope as QueryScope)) {
      const valid = Array.from(VALID_SCOPES).sort().join(' / ');
      return `steps[${i}].scope: unknown scope "${step.scope}". Valid: ${valid}.`;
    }
  }
  return null;
};

const runQueryChain = (runtime: QueryRuntime, steps: QueryStep[]): Fiber[] => {
  let current: Fiber[] = [runtime.root];
  for (const step of steps) {
    const scope: QueryScope = step.scope ?? 'descendants';
    const seen = new Set<Fiber>();
    const collected: Fiber[] = [];
    for (const fiber of current) {
      for (const candidate of collectByScope(fiber, scope, runtime)) {
        if (!seen.has(candidate)) {
          seen.add(candidate);
          collected.push(candidate);
        }
      }
    }
    const filtered = collected.filter((f) => {
      return matchesQuery(f, step);
    });
    if (typeof step.index === 'number') {
      const picked = filtered[step.index];
      current = picked ? [picked] : [];
    } else {
      current = filtered;
    }
    if (current.length === 0) return [];
  }
  return current;
};

// Keep only fibers whose ancestor chain contains no other match. Removes
// wrapper cascades (PressableView → Pressable → View → RCTView) while keeping
// independent siblings with overlapping bounds (e.g. absolute-positioned
// overlays). Preserves original DFS order.
const dedupAncestors = (matches: Fiber[]): Fiber[] => {
  if (matches.length < 2) return matches;
  const matchSet = new Set<Fiber>(matches);
  return matches.filter((fiber) => {
    let p = fiber.return;
    while (p) {
      if (matchSet.has(p)) return false;
      p = p.return;
    }
    return true;
  });
};

/**
 * Light projector for nodes inside the `select.children` walker. Returns one
 * of the four allowed fields per node (mcpId / name / testID / bounds);
 * `bounds` is async because it reads native layout via UIManager. Heavy
 * fields (props/hooks) are not handled here on purpose — see
 * `parseChildrenSelect` for the rationale.
 */
const projectChildLightFields = async (
  fiber: Fiber,
  fields: Set<string>,
  measure: (fiber: Fiber) => Promise<Bounds | null>
): Promise<Record<string, unknown>> => {
  const out: Record<string, unknown> = {};
  if (fields.has('mcpId')) {
    out.mcpId = fiber.memoizedProps?.['data-mcp-id'];
  }
  if (fields.has('name')) {
    out.name = getComponentName(fiber);
  }
  if (fields.has('testID')) {
    out.testID = fiber.memoizedProps?.testID;
  }
  if (fields.has('bounds')) {
    out.bounds = await measure(fiber);
  }
  return out;
};

/**
 * Recursive walker for `select.children`. Walks the fiber tree from `fiber`
 * up to `depthLeft` levels of direct children, applying the per-level light
 * field projection from `options.select`. Each level is width-capped at
 * `options.itemsCap`; overflow inserts a `${truncated}` sentinel as the
 * first item of the array.
 *
 * Stops when depthLeft reaches 0. Returned shape: array of nodes, each with
 * the selected light fields plus optional `children: [...]` if the next
 * level was requested.
 */
const walkChildren = async (
  fiber: Fiber,
  options: ChildrenOptions,
  depthLeft: number,
  measure: (fiber: Fiber) => Promise<Bounds | null>
): Promise<unknown[]> => {
  if (depthLeft <= 0) return [];
  const kids = getDirectChildren(fiber);
  const cap = options.itemsCap;
  const sliced = kids.slice(0, cap);
  const out: unknown[] = [];
  if (kids.length > cap) {
    out.push({ ['${truncated}']: { slice: [0, cap], total: kids.length } });
  }
  // If the user supplied an explicit nested `select.children` — use it for
  // the next level. Otherwise self-recur with the same `options`, so
  // `{ children: 5 }` means "5 levels deep, light fields all the way".
  const nextOptions = options.select.children ?? options;
  for (const kid of sliced) {
    const node = await projectChildLightFields(kid, options.select.fields, measure);
    if (depthLeft > 1) {
      node.children = await walkChildren(kid, nextOptions, depthLeft - 1, measure);
    } else {
      // Last level — instead of dropping the `children` field entirely,
      // surface the descendant count as an `${arr}` marker so the agent
      // sees "there's N more children below; drill separately if needed".
      // Empty children → omit the field altogether (true leaf).
      const subCount = getDirectChildren(kid).length;
      if (subCount > 0) {
        node.children = { ['${arr}']: subCount };
      }
    }
    out.push(node);
  }
  return out;
};

// Window dimensions → physical-pixel bounds rectangle for `onlyVisible` filter.
const getVisibleRect = (): { height: number; width: number } | null => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const RN = require('react-native');
    const { Dimensions, PixelRatio } = RN;
    const window = Dimensions?.get?.('window');
    const ratio = PixelRatio?.get?.() ?? 1;
    if (!window || !Number.isFinite(window.width) || !Number.isFinite(window.height)) return null;
    return {
      height: window.height * ratio,
      width: window.width * ratio,
    };
  } catch {
    return null;
  }
};

const intersectsRect = (bounds: Bounds, rect: { height: number; width: number }): boolean => {
  return (
    bounds.x + bounds.width > 0 &&
    bounds.y + bounds.height > 0 &&
    bounds.x < rect.width &&
    bounds.y < rect.height
  );
};

export const fiberTreeModule = (options?: FiberTreeModuleOptions): McpModule => {
  if (options?.rootRef) {
    setRootRef(options.rootRef);
  }
  const navigationRef = options?.navigationRef;

  // Compile the redact pattern list once at module init. Precedence:
  //   - `redactHookNames` provided → use it verbatim (replace mode).
  //   - `additionalRedactHookNames` provided → defaults + user's.
  //   - Neither → defaults.
  // Pass `redactHookNames: []` to disable redaction entirely.
  const redactPatterns: RegExp[] = compileRedactPatterns(
    options?.redactHookNames !== undefined
      ? options.redactHookNames
      : [...DEFAULT_REDACT_HOOK_NAMES, ...(options?.additionalRedactHookNames ?? [])]
  );

  // Root-version keyed cache for `runQueryChain`. When React commits, the
  // HostRoot fiber swaps — so a mismatched pointer is proof the tree changed
  // and the cached match set for the same steps is no longer valid.
  // Enabled by default (cache: true); `cache: false` bypasses lookup + write.
  let cacheRoot: Fiber | null = null;
  const cacheEntries = new Map<string, Fiber[]>();

  const runCachedQuery = (runtime: QueryRuntime, steps: QueryStep[], useCache: boolean) => {
    if (!useCache) return runQueryChain(runtime, steps);
    if (cacheRoot !== runtime.root) {
      cacheRoot = runtime.root;
      cacheEntries.clear();
    }
    const key = JSON.stringify(steps);
    const hit = cacheEntries.get(key);
    if (hit) return hit;
    const result = runQueryChain(runtime, steps);
    cacheEntries.set(key, result);
    return result;
  };

  const findInRoot = (root: ReturnType<typeof getFiberRoot>, segment: string) => {
    if (!root) return null;
    // Support "Name:index" format, e.g. "Button:1"
    const [name, indexStr] = segment.split(':');
    if (!name) return null;
    const idx = indexStr ? parseInt(indexStr, 10) : 0;

    const allByMcpId = findAllByQuery(root, { mcpId: name });
    if (allByMcpId.length > 0) return allByMcpId[idx] ?? null;

    const allByTestID = findAllByQuery(root, { testID: name });
    if (allByTestID.length > 0) return allByTestID[idx] ?? null;

    const allByName = findAllByQuery(root, { name });
    return allByName[idx] ?? null;
  };

  const findComponent = (args: Record<string, unknown>) => {
    let root = getFiberRoot();
    if (!root) return null;

    // "within" supports recursive path with index: "Parent/Child:1/GrandChild"
    if (args.within) {
      const path = (args.within as string).split('/');
      for (const segment of path) {
        root = findInRoot(root, segment);
        if (!root) return null;
      }
    }

    const index = (args.index as number) ?? 0;

    if (args.mcpId) {
      const all = findAllByQuery(root, { mcpId: args.mcpId as string });
      return all[index] ?? null;
    }
    if (args.testID) {
      const all = findAllByQuery(root, { testID: args.testID as string });
      return all[index] ?? null;
    }
    if (args.name) {
      const all = findAllByQuery(root, { name: args.name as string });
      return all[index] ?? null;
    }
    if (args.text) {
      const all = findAllByQuery(root, { text: args.text as string });
      return all[index] ?? null;
    }
    return null;
  };

  const requireRoot = () => {
    const root = getFiberRoot();
    if (!root) {
      return { error: 'Fiber root not available. The app may not have rendered yet.' };
    }
    return null;
  };

  return {
    description: `React fiber tree inspection and interaction.

SCOPES (query steps)
  descendants (default) / children / parent / ancestors / siblings / self
  / root / screen / nearest_host.
    · root — the React fiber root, regardless of the previous step's
      match. Use as the first step to start from the top of the tree
      (e.g. dump the whole tree via select: [{ children: 5 }]).
    · screen — descendants of the currently focused React Navigation
      screen fiber. Available when the library was initialized with a
      navigationRef. Lets a first step skip "find current screen first".
    · nearest_host — walks down to the first mounted HOST_COMPONENT
      fiber. Useful before \`call({ method })\` (focus/blur/measure)
      which requires a host instance.

STEP CRITERIA
  name / mcpId / testID — strict equality.
  text — substring match in RENDERED text only (not prop values).
  hasProps — array of prop names that must exist.
  props — map of prop → matcher:
    · primitive → strict equality.
    · { contains: "X" } / { regex: "Y" } → match via String(value); primitives only by default.
    · add deep: true → also JSON-serialize objects/arrays and match inside.
  any — array of sub-criteria; OR semantics.
    Example: { any: [{ name: "Pressable" }, { name: "TouchableOpacity" }] }.
  not — nested criteria; excludes fibers that match the inner query.
    Composes with the others: { hasProps: ["onPress"], not: { testID: "loading" } }.
    Accepts an array for multi-pattern exclusion:
    { not: [{ name: "Pressable" }, { testID: "loading" }] }.
  index — pick N-th match from this step; otherwise all matches fan out into the next step.

SELECT (output fields)
  Default ["mcpId", "name", "testID"] — props, bounds, hooks,
  refMethods, children are opt-in.
  bounds: { x, y, width, height, centerX, centerY } in PHYSICAL pixels,
  top-left origin. null when the fiber has no mounted host view. centerX/
  centerY feed straight into host__tap.
  refMethods: list of native-ref method names (focus, blur, measure,
  scrollTo, ...) available on the fiber's host instance. null when
  there is no native instance (composite wrapper, unmounted,
  virtualized). Feeds directly into fiber_tree__call({ method }).
  props: per-field projection — \`{ props: { path?, depth?, maxBytes? } }\`.
  hooks: filtered + projected — \`{ hooks: { kinds?, names?, withValues?,
  expansionDepth?, format?, path?, depth?, maxBytes? } }\`. Each entry
  { kind, name, hook?, via?, expanded?, value? }.
  children: recursive light-only walker for tree-of-tree navigation —
  short form { children: 5 } (treeDepth=5) or object form
  { children: { treeDepth, select?, itemsCap? } }. select inside
  children may include only mcpId / name / testID / bounds / nested
  children — props/hooks throw at parse time. Use a second query against
  a child mcpId to inspect its props/hooks. treeDepth max 16, itemsCap
  default 50; overflow inserts a \`\${truncated}\` sentinel as the first
  array item.

RESPONSE
  { matches: [...], total, truncated? } — total is the unrestricted match
  count; when the result exceeds limit (default 50, max 500) truncated:
  true is added and matches contains the first limit items in DFS order.
  Narrow the query rather than cranking limit.

  By default wrapper cascades are deduped: a fiber is hidden when any of
  its ancestors is also a match, so PressableView → Pressable → View →
  RCTView collapses to the topmost PressableView. Independent siblings
  are kept. Pass dedup: false to see every layer.

TIPS
  mcpId format "ComponentName:file:line" — stable across renders.
  Use query to locate, then call({ prop } or { method }) (bypasses gesture
  pipeline) or host__tap with bounds (real OS touch) to act. For one-shot
  real taps, tap_fiber collapses both steps into a single call.
  When stepping up via scope: "ancestors", prefer filtering by name (or
  testID/mcpId) over guessing an index — ancestors count is brittle and
  varies across RN versions.
  \`text\` matches RENDERED text only — Text children content, not prop
  values. To match "placeholder: Search" use \`props: { placeholder:
  { contains: "Search" } }\`.`,
    name: 'fiber_tree',
    tools: {
      call: {
        description:
          "Imperative action on a fiber — invoke a prop callback OR a native-ref method. Pass `prop: 'onPress'` to call a callback prop, or `method: 'focus'` to call a method on the host instance's native ref. For simulating user taps, prefer `host__tap_fiber` — it goes through the real OS gesture pipeline so Pressable feedback / gesture responders / hit-test all behave as under a real finger. `call` is for non-gesture callbacks, off-screen / virtualised components, or imperative ref methods (focus / blur / measure / scrollTo / ...). Use `query` with `select: ['refMethods']` first to see what methods are available on a fiber.",
        handler: (args) => {
          const rootError = requireRoot();
          if (rootError) return rootError;

          const fiber = findComponent(args);
          if (!fiber) return { error: 'Component not found' };

          const propName = typeof args.prop === 'string' ? args.prop : undefined;
          const methodName = typeof args.method === 'string' ? args.method : undefined;

          if ((propName && methodName) || (!propName && !methodName)) {
            return {
              error:
                'call requires exactly one of `prop` (callback name) or `method` (ref method name).',
            };
          }

          const callArgs = (args.args as unknown[] | undefined) ?? [];

          // Prop-callback path: read prop from memoizedProps, call directly.
          if (propName) {
            const callback = fiber.memoizedProps?.[propName];
            if (typeof callback !== 'function') {
              const availableProps = Object.keys(fiber.memoizedProps ?? {}).filter((key) => {
                return typeof fiber.memoizedProps[key] === 'function';
              });
              return {
                availableProps,
                error: `Component "${getComponentName(fiber)}" has no "${propName}" callback prop`,
              };
            }
            const result = callback(...callArgs);
            return applyProjection(
              { component: getComponentName(fiber), prop: propName, result, success: true },
              args as ProjectionArgs
            );
          }

          // Ref-method path: resolve native instance, call method on it.
          const instance = getNativeInstance(fiber);
          if (!instance) {
            return { error: `Component "${getComponentName(fiber)}" has no native instance` };
          }
          const method = (instance as Record<string, unknown>)[methodName!];
          if (typeof method !== 'function') {
            return {
              availableMethods: getAvailableMethods(instance),
              error: `No method "${methodName}" on native instance of "${getComponentName(fiber)}"`,
            };
          }
          try {
            const bound = (method as (...a: unknown[]) => unknown).bind(instance);
            const result = bound(...callArgs);
            return applyProjection(
              { component: getComponentName(fiber), method: methodName, result, success: true },
              args as ProjectionArgs
            );
          } catch (e) {
            return {
              error: `Method "${methodName}" threw: ${e instanceof Error ? e.message : String(e)}`,
            };
          }
        },
        inputSchema: {
          ...FIND_SCHEMA,
          ...PROJECTION_SCHEMA,
          args: {
            description: 'Arguments passed to the callback / method.',
            examples: [[true], ['text']],
            type: 'array',
          },
          method: {
            description: 'Native-ref method name. Mutually exclusive with `prop`.',
            examples: ['focus', 'blur', 'measure', 'scrollTo'],
            type: 'string',
          },
          prop: {
            description: 'Callback prop name. Mutually exclusive with `method`.',
            examples: ['onPress', 'onSkip', 'onChangeText'],
            type: 'string',
          },
        },
      },
      query: {
        description:
          'Chain-based fiber search. Each step narrows the result set via `scope` + criteria; multiple matches fan out into the next step. Returns { matches, total, truncated? }. Pass `waitFor` to poll until an element appears or disappears (optionally requiring stability for N ms) instead of a single-shot read. See the module description for scope, criteria, select and response reference.',
        handler: async (args) => {
          const inner = async (): Promise<unknown> => {
            const rootError = requireRoot();
            if (rootError) return rootError;
            const root = getFiberRoot()!;

            const steps = args.steps as QueryStep[] | undefined;
            if (!Array.isArray(steps) || steps.length === 0) {
              return { error: 'query requires a non-empty `steps` array' };
            }
            const stepError = validateSteps(steps);
            if (stepError) return { error: stepError };

            const limit =
              typeof args.limit === 'number' && args.limit > 0
                ? Math.min(Math.floor(args.limit), QUERY_LIMIT_MAX)
                : QUERY_LIMIT_DEFAULT;
            const dedup = args.dedup !== false;
            const useCacheDefault = args.cache !== false;
            const onlyVisible = args.onlyVisible === true;
            let projection: Projection;
            try {
              projection = parseProjection(args.select);
            } catch (e) {
              return { error: e instanceof Error ? e.message : String(e) };
            }
            const {
              children: childrenOpts,
              fields,
              hooks: hookOpts,
              props: propsOpts,
            } = projection;

            const runtime: QueryRuntime = { navigationRef, root };

            const runOnce = async (
              useCache: boolean
            ): Promise<{ matches: Record<string, unknown>[]; total: number; truncated?: true }> => {
              const rawMatches = runCachedQuery(runtime, steps, useCache);
              let all = dedup ? dedupAncestors(rawMatches) : rawMatches;

              const boundsCache = new Map<Fiber, Bounds | null>();
              const measure = async (fiber: Fiber): Promise<Bounds | null> => {
                if (boundsCache.has(fiber)) return boundsCache.get(fiber) ?? null;
                const b = await measureFiber(fiber);
                boundsCache.set(fiber, b);
                return b;
              };

              if (onlyVisible) {
                const visibleRect = getVisibleRect();
                if (visibleRect) {
                  const rect = visibleRect;
                  const measured = await Promise.all(
                    all.map(async (fiber) => {
                      return { bounds: await measure(fiber), fiber };
                    })
                  );
                  all = measured
                    .filter(({ bounds }) => {
                      return bounds && intersectsRect(bounds, rect);
                    })
                    .map(({ fiber }) => {
                      return fiber;
                    });
                }
              }

              const total = all.length;
              const truncated = total > limit;
              const picked = truncated ? all.slice(0, limit) : all;

              const matches = await Promise.all(
                picked.map(async (fiber) => {
                  const result: Record<string, unknown> = {};
                  if (fields.has('bounds')) {
                    result.bounds = await measure(fiber);
                  }
                  if (fields.has('mcpId')) {
                    result.mcpId = fiber.memoizedProps?.['data-mcp-id'];
                  }
                  if (fields.has('name')) {
                    result.name = getComponentName(fiber);
                  }
                  if (fields.has('props')) {
                    // Heavy field — projected here via select.props options
                    // (path/depth/maxBytes). Top-level response stays raw
                    // so mcpId/name/etc are always visible without
                    // projection.
                    result.props = projectFiberValue(fiber.memoizedProps ?? {}, {
                      depth: propsOpts.depth ?? 1,
                      maxBytes: propsOpts.maxBytes,
                      path: propsOpts.path,
                    });
                  }
                  if (fields.has('refMethods')) {
                    // List of native-ref methods available on the fiber's
                    // host instance (focus, blur, measure, scrollTo, ...).
                    // null when the fiber has no native instance (composite
                    // wrappers, unmounted, virtualized). Feeds directly into
                    // `fiber_tree__call({ method })`.
                    const instance = getNativeInstance(fiber);
                    result.refMethods = instance ? getAvailableMethods(instance) : null;
                  }
                  if (fields.has('testID')) {
                    result.testID = fiber.memoizedProps?.testID;
                  }
                  if (fields.has('hooks')) {
                    result.hooks = extractHooks(fiber, {
                      ...hookOpts,
                      redactPatterns,
                    });
                  }
                  if (childrenOpts) {
                    result.children = await walkChildren(
                      fiber,
                      childrenOpts,
                      childrenOpts.treeDepth,
                      measure
                    );
                  }
                  return result;
                })
              );

              return truncated ? { matches, total, truncated: true } : { matches, total };
            };

            const waitForRaw = args.waitFor as
              | { interval?: number; stable?: number; timeout?: number; until?: unknown }
              | undefined;

            if (!waitForRaw || typeof waitForRaw !== 'object') {
              return runOnce(useCacheDefault);
            }

            const until = waitForRaw.until;
            if (until !== 'appear' && until !== 'disappear') {
              return { error: 'waitFor.until must be "appear" or "disappear"' };
            }
            const waitUntil: WaitUntil = until;
            const timeout = Math.min(
              WAIT_TIMEOUT_MAX,
              Math.max(0, waitForRaw.timeout ?? WAIT_TIMEOUT_DEFAULT)
            );
            const interval = Math.max(
              WAIT_INTERVAL_MIN,
              waitForRaw.interval ?? WAIT_INTERVAL_DEFAULT
            );
            const stable = Math.max(0, waitForRaw.stable ?? 0);
            const predicate = (total: number): boolean => {
              return waitUntil === 'appear' ? total >= 1 : total === 0;
            };

            const startedAt = Date.now();
            const deadline = startedAt + timeout;
            let attempts = 0;
            let stableSince: number | null = null;
            let lastResult = await runOnce(false);
            attempts++;

            // eslint-disable-next-line no-constant-condition
            while (true) {
              const now = Date.now();
              const elapsedMs = now - startedAt;
              const met = predicate(lastResult.total);

              if (met) {
                if (stable === 0) {
                  return {
                    ...lastResult,
                    attempts,
                    elapsedMs,
                    timedOut: false,
                    until: waitUntil,
                    waited: true,
                  };
                }
                if (stableSince === null) stableSince = now;
                if (now - stableSince >= stable) {
                  return {
                    ...lastResult,
                    attempts,
                    elapsedMs,
                    stableFor: now - stableSince,
                    timedOut: false,
                    until: waitUntil,
                    waited: true,
                  };
                }
              } else {
                stableSince = null;
              }

              if (now >= deadline) {
                return {
                  ...lastResult,
                  attempts,
                  elapsedMs,
                  timedOut: true,
                  until: waitUntil,
                  waited: true,
                };
              }

              const remaining = deadline - now;
              const sleepMs = Math.min(interval, Math.max(0, remaining));
              await new Promise<void>((resolve) => {
                return setTimeout(resolve, sleepMs);
              });
              lastResult = await runOnce(false);
              attempts++;
            }
          };
          // No top-level projection on the query response — the response
          // shell ({ matches, total, ... }) is light by construction;
          // heavy values inside `props` / `hooks` are already collapsed to
          // markers by per-field projection in `inner`, and the
          // `select.children` walker self-bounds via treeDepth/itemsCap.
          // Top-level path/depth/maxBytes are not exposed on `query` —
          // drill happens via `select.props.path` / `select.hooks.path`,
          // and tree-shape navigation via `select.children`.
          return inner();
        },
        inputSchema: {
          cache: {
            description:
              'Reuse the match set when the React tree has not committed since the previous identical steps — detected via fiber root pointer equality. Default true; pass false to force a fresh traversal.',
            type: 'boolean',
          },
          dedup: {
            description:
              'Drop wrapper cascades — a fiber is removed when any of its ancestors is also in the match set (PressableView → Pressable → View → RCTView collapses to the topmost). Independent siblings with overlapping bounds are kept. Default true; pass false to keep every match.',
            type: 'boolean',
          },
          limit: {
            description: `Max matches to return (default ${QUERY_LIMIT_DEFAULT}, max ${QUERY_LIMIT_MAX}). truncated: true is added when total exceeds limit.`,
            type: 'number',
          },
          onlyVisible: {
            description:
              'Drop matches whose measured bounds do not intersect the current window rectangle (physical pixels). Also drops fibers with no measurable host view — usually virtualized or unmounted. Halves results on long lists.',
            type: 'boolean',
          },
          select: {
            description: `Output fields: mcpId, name, testID, props, bounds, hooks, refMethods, children. Default ${JSON.stringify(QUERY_DEFAULT_FIELDS)}. Each entry is either a string ("mcpId" — include with defaults) or an object whose keys are field names. Object values are \`true\` / \`false\` / per-field options.\n\nLight fields (mcpId, name, testID, bounds, refMethods) — no options, just toggle. refMethods is the list of native-ref methods (focus, blur, measure, scrollTo, ...) available on the fiber's host instance; null when the fiber has no native instance. Feeds directly into \`fiber_tree__call({ method })\`.\n\nHeavy fields (props, hooks) — per-field projection via shared \`projectValue\` so nested heavy values become \`\${...}\`-keyed markers. Each takes its own \`path\` / \`depth\` / \`maxBytes\`.\n\nprops options: \`{ path?, depth?, maxBytes? }\`.\n\nhooks options: \`{ kinds?, names?, withValues?, expansionDepth?, format?, path?, depth?, maxBytes? }\`. \`kinds\`: State | Reducer | Memo | Callback | Ref | Effect | LayoutEffect | InsertionEffect | Context | Transition | DeferredValue | Id | SyncExternalStore | ImperativeHandle | Custom. \`names\`: exact or \`/regex/flags\`. \`withValues:true\` adds resolved values. \`expansionDepth\` caps custom-hook recursion (default Infinity). \`format:"tree"\` returns nested children instead of flat \`via\`.\n\nchildren — recursive light-only walker for tree-of-tree dumps.\n  Short form: \`{ children: 5 }\` → treeDepth=5, default fields ['mcpId','name'].\n  Object form: \`{ children: { treeDepth?, select?, itemsCap? } }\`.\n  treeDepth max 16; itemsCap default 50; overflow inserts \`\${truncated}\` as the first item.\n  select inside children may include only mcpId / name / testID / bounds / nested children. props/hooks throw at parse time — run a second query against a child's mcpId to inspect them.\n\nEach hook entry carries \`{ kind, name, hook?, via?, expanded? }\`.`,
            examples: [
              ['mcpId', 'name', 'bounds'],
              ['mcpId', 'refMethods'],
              ['mcpId', { props: { path: 'style' } }],
              ['mcpId', { props: { depth: 3 } }],
              [{ hooks: { kinds: ['State'], withValues: true }, mcpId: true }],
              [{ children: 5 }],
              [
                'mcpId',
                'name',
                { children: { select: ['mcpId', 'name', 'testID'], treeDepth: 3 } },
              ],
            ],
            type: 'array',
          },
          steps: {
            description:
              'Ordered steps: [{ scope?, name?, mcpId?, testID?, text?, hasProps?, props?, index? }]. See module description for full semantics.',
            examples: [
              [{ hasProps: ['onPress'] }],
              [{ name: 'HomeScreen' }, { name: 'ProductCard' }],
              [{ testID: 'favorite-icon' }, { index: 0, name: 'ProductCard', scope: 'ancestors' }],
              [{ props: { placeholder: { contains: 'Search' } } }],
            ],
            type: 'array',
          },
          waitFor: {
            description: `Poll the query until a predicate holds, instead of reading once. \`until\` selects the target state: "appear" waits for \`total >= 1\`, "disappear" waits for \`total === 0\`. \`timeout\` (default ${WAIT_TIMEOUT_DEFAULT}ms, max ${WAIT_TIMEOUT_MAX}ms) caps the wait. \`interval\` (default ${WAIT_INTERVAL_DEFAULT}ms, min ${WAIT_INTERVAL_MIN}ms) is the gap between polls. \`stable\` (default 0) requires the predicate to hold continuously for this many ms before returning — useful to ignore transient matches during screen transitions. Cache is always bypassed while polling. On success the response carries the usual query fields plus \`{ waited: true, until, attempts, elapsedMs, timedOut: false, stableFor? }\`; on timeout \`timedOut: true\` with the last observed matches.`,
            examples: [
              { until: 'appear' },
              { timeout: 5000, until: 'disappear' },
              { interval: 200, stable: 500, until: 'appear' },
            ],
            type: 'object',
          },
        },
      },
    },
  };
};
