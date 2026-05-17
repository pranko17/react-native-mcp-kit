/**
 * Single-fiber lookup used by the imperative `call` handler. Walks the
 * fiber root by mcpId / testID / name / text — the same criteria a
 * top-level `query` step accepts, but with a single match contract and
 * an optional `within` path expression for nested disambiguation.
 *
 * The `within` argument supports `"Parent/Child:1/GrandChild"` syntax:
 * each `/`-separated segment narrows the search scope to that fiber's
 * subtree, and `Name:N` picks the N-th match for that name (also works
 * with mcpId / testID).
 */

import { type Fiber } from './types';
import { findAllByQuery, getFiberRoot } from './utils';

/**
 * Standard finder-arg shape mixed into every imperative tool's
 * inputSchema. Re-spread (`...FIND_SCHEMA`) alongside tool-specific
 * args.
 */
export const FIND_SCHEMA = {
  index: {
    default: 0,
    description: '0-based index when several components match.',
    minimum: 0,
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

// Resolve a single `Name:N` segment of a `within` path. Tries mcpId →
// testID → name in that order; first non-empty match-set wins.
const findInRoot = (root: Fiber | null, segment: string): Fiber | null => {
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

/**
 * Resolve a single fiber from the standard finder args (mcpId / testID /
 * name / text + optional `within`). Returns null when nothing matches —
 * the caller decides whether that's an error or a soft miss.
 */
export const findComponent = (args: Record<string, unknown>): Fiber | null => {
  let root: Fiber | null = getFiberRoot();
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

/**
 * Guard for handlers that need a fiber root but can't usefully proceed
 * without one. Returns `{ error }` when the app hasn't rendered yet (or
 * the rootRef wasn't wired up), otherwise `null` — call sites do
 * `if (rootError) return rootError;` at the top.
 */
export const requireRoot = (): { error: string } | null => {
  const root = getFiberRoot();
  if (!root) {
    return { error: 'Fiber root not available. The app may not have rendered yet.' };
  }
  return null;
};
