import { type FlatHookEntry, type FlattenedHook, type HookMeta, type HookTreeNode } from './types';

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
export const flattenHookMeta = (
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
export const flatHooksToTree = (flat: FlatHookEntry[]): HookTreeNode[] => {
  const root: HookTreeNode[] = [];
  // Stack of currently-open parents, indexed by their depth (= via.length
  // of THEIR own entry, since their children sit at via.length + 1).
  const parents: HookTreeNode[] = [];
  for (const entry of flat) {
    const depth = entry.via?.length ?? 0;
    while (parents.length > depth) parents.pop();
    const node: HookTreeNode = { kind: entry.kind, name: entry.name };
    if (entry.hook !== undefined) node.hook = entry.hook;
    if (entry.mcpId !== undefined) node.mcpId = entry.mcpId;
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
