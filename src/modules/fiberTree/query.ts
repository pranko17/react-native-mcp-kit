/**
 * Query primitive — chained `steps`, each step a `scope` + criteria pair.
 * Each step's matches fan out into the next step's scope (so a 2-step
 * `[{ name: 'List' }, { scope: 'children', name: 'Item' }]` reads as
 * "find all Lists, then for each List collect its Item children").
 *
 * Scopes (`QueryScope`) control which fibers a step *considers*; criteria
 * (from `ComponentQuery`) filter that set. Validation rejects unknown
 * scope strings at the entry point so typos surface as a structured
 * error instead of silently degrading to the default `descendants`.
 */

import { type ComponentQuery, type Fiber } from './types';
import {
  findAllByQuery,
  findHostFiber,
  findScreenFiberByRouteKey,
  getAncestors,
  getDirectChildren,
  getSiblings,
  matchesQuery,
} from './utils';

// Kept deliberately loose: the module only calls getCurrentRoute at query
// time and gracefully no-ops when the shape is unexpected. This avoids
// dragging in the full React Navigation ref surface.
export interface FiberTreeNavigationRef {
  getCurrentRoute?: () => unknown;
}

export type QueryScope =
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

export interface QueryStep extends ComponentQuery {
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

export interface QueryRuntime {
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

/**
 * Up-front validation of every step's `scope`. Returns a human-readable
 * error string on a bad scope (with the valid set listed for the agent),
 * or null when all steps look sane. Keeps unknown scopes from silently
 * collapsing to the default 'descendants' inside `collectByScope`.
 */
export const validateSteps = (steps: QueryStep[]): string | null => {
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

/**
 * Walk the chain of steps starting from the fiber root. Each iteration
 * collects candidates via `collectByScope`, then filters with
 * `matchesQuery`. `step.index` picks one match; otherwise all matches
 * fan out as the input set for the next step.
 */
export const runQueryChain = (runtime: QueryRuntime, steps: QueryStep[]): Fiber[] => {
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

/**
 * Keep only fibers whose ancestor chain contains no other match. Removes
 * wrapper cascades (PressableView → Pressable → View → RCTView) while
 * keeping independent siblings with overlapping bounds (e.g.
 * absolute-positioned overlays). Preserves original DFS order.
 */
export const dedupAncestors = (matches: Fiber[]): Fiber[] => {
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
