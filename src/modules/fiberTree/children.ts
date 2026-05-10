/**
 * `select.children` walker — recursive shallow tree of fiber nodes used by
 * `query` to surface subtree shape without the cost of inspecting every
 * fiber's props/hooks. The walker is intentionally light-only: heavy
 * fields (`props`, `hooks`) are rejected at parse time so the worst-case
 * response stays bounded at `treeDepth × itemsCap × ~30 bytes` (~24KB
 * with the default caps).
 *
 * For drilling into a specific child's props or hooks, the agent should
 * run a second `query` against the child's mcpId.
 */

import { type Bounds, type Fiber } from './types';
import { getComponentName, getDirectChildren } from './utils';

const CHILDREN_DEFAULT_TREE_DEPTH = 4;
const CHILDREN_MAX_TREE_DEPTH = 16;
const CHILDREN_DEFAULT_ITEMS_CAP = 50;
const LIGHT_FIELDS = new Set(['mcpId', 'name', 'testID', 'bounds']);

export interface ChildrenOptions {
  itemsCap: number;
  // Recursive: sub-children walker for next level. null = stop expanding.
  select: ChildrenSelect;
  treeDepth: number;
}

export interface ChildrenSelect {
  children: ChildrenOptions | null;
  fields: Set<string>;
}

/**
 * Parse `select.children.select` — recursive but strictly light-only.
 *
 * Walker is meant for "map of the tree" navigation, not data extraction.
 * `props`/`hooks` are explicitly rejected with an error: if you need a
 * fiber's props/hooks, run a second `query` against its mcpId.
 */
export const parseChildrenSelect = (selectArg: unknown): ChildrenSelect => {
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
 * Parse `{ children: N }` short form or
 * `{ children: { treeDepth, select?, itemsCap? } }` object form into a
 * normalised `ChildrenOptions`.
 */
export const parseChildrenOptions = (raw: unknown): ChildrenOptions => {
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
 * Light projector for nodes inside the `select.children` walker. Returns
 * one of the four allowed fields per node (mcpId / name / testID /
 * bounds); `bounds` is async because it reads native layout via UIManager.
 * Heavy fields (props/hooks) are not handled here on purpose — see
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
 * Recursive walker for `select.children`. Walks the fiber tree from
 * `fiber` up to `depthLeft` levels of direct children, applying the
 * per-level light field projection from `options.select`. Each level is
 * width-capped at `options.itemsCap`; overflow inserts a `${truncated}`
 * sentinel as the first item of the array.
 *
 * Stops when `depthLeft` reaches 0. Returned shape: array of nodes, each
 * with the selected light fields plus optional `children: [...]` if the
 * next level was requested. On the last level, the field becomes a
 * `{ "${arr}": N }` marker carrying the count of un-walked sub-children.
 */
export const walkChildren = async (
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
