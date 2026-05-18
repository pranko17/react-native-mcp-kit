import { matchesAnyRedactPattern, REDACTED_VALUE } from '@/modules/fiberTree/redact';
import { type Fiber } from '@/modules/fiberTree/types';
import { projectFiberValue } from '@/modules/fiberTree/utils';

import { flatHooksToTree, flattenHookMeta } from './flatten';
import { shapeMatchesKind } from './shape';
import { countHookSlots } from './slotCount';
import {
  type FlatHookEntry,
  type FlattenedHook,
  type HookMeta,
  type HooksOptions,
  type HookTreeNode,
} from './types';
import { serializeHookValue } from './value';

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
    const { hook, kind, mcpId, name, via } = entry;
    const passesKind = !filter.kindsSet || filter.kindsSet.has(kind);
    const passesName =
      !filter.nameMatchers ||
      filter.nameMatchers.some((m) => {
        return m(name);
      });
    const passesMcpId =
      !filter.mcpIdMatchers ||
      (mcpId !== undefined &&
        filter.mcpIdMatchers.some((m) => {
          return m(mcpId);
        }));
    if (!(passesKind && passesName && passesMcpId)) return;
    const record: {
      kind: string;
      name: string;
      expanded?: boolean;
      hook?: string;
      mcpId?: string;
      value?: unknown;
      via?: string[];
    } = { kind, name };
    // Prefer the babel-emitted hook name; fall back to fn.name for entries
    // produced by older bundles that predate the `hook` field.
    const resolvedHook =
      hook ?? (typeof entry.fn === 'function' ? (entry.fn.name as string | undefined) : undefined);
    if (resolvedHook) record.hook = resolvedHook;
    if (mcpId) record.mcpId = mcpId;
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
