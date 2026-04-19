import { type RefObject } from 'react';

import { type McpModule } from '@/client/models/types';

import { type Bounds, type ComponentQuery } from './types';
import {
  findAllByQuery,
  findByMcpId,
  findByName,
  findByTestID,
  findByText,
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
  serializeFiber,
  serializeProps,
  setRootRef,
} from './utils';

const DEFAULT_DEPTH = 10;

const QUERY_LIMIT_DEFAULT = 50;
const QUERY_LIMIT_MAX = 500;
const QUERY_DEFAULT_FIELDS = ['mcpId', 'name', 'testID'];

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

// Kept deliberately loose: the module only calls getCurrentRoute at query
// time and gracefully no-ops when the shape is unexpected. This avoids
// dragging in the full React Navigation ref surface.
interface FiberTreeNavigationRef {
  getCurrentRoute?: () => unknown;
}

interface FiberTreeModuleOptions {
  navigationRef?: FiberTreeNavigationRef | null;
  rootRef?: RefObject<unknown>;
}

type QueryScope =
  | 'ancestors'
  | 'children'
  | 'descendants'
  | 'nearest_host'
  | 'parent'
  | 'screen'
  | 'self'
  | 'siblings';

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
  / screen / nearest_host.
    · screen — descendants of the currently focused React Navigation
      screen fiber. Available when the library was initialized with a
      navigationRef. Lets a first step skip "find current screen first".
    · nearest_host — walks down to the first mounted HOST_COMPONENT
      fiber. Useful before call_ref (focus/blur/measure) which require
      a host instance.

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
  index — pick N-th match from this step; otherwise all matches fan out into the next step.

SELECT (output fields)
  Default ["mcpId", "name", "testID"] — props and bounds are opt-in.
  bounds: { x, y, width, height, centerX, centerY } in PHYSICAL pixels,
  top-left origin. null when the fiber has no mounted host view. centerX/
  centerY feed straight into host__tap.
  props: full serialized props (heavy). Pair with propsInclude:
  ["key1","key2"] to keep only the props you actually need and avoid
  pulling large style maps, data arrays, or nested element trees.

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
  Use query to locate, then invoke (bypasses gesture pipeline) or host__tap
  with bounds (real OS touch) to act.`,
    name: 'fiber_tree',
    tools: {
      call_ref: {
        description:
          "Call a method on a component's native ref (focus, blur, measure, …). Use get_ref_methods first to see what's available.",
        handler: (args) => {
          const rootError = requireRoot();
          if (rootError) return rootError;

          const fiber = findComponent(args);
          if (!fiber) return { error: 'Component not found' };

          const instance = getNativeInstance(fiber);
          if (!instance) {
            return { error: `Component "${getComponentName(fiber)}" has no native instance` };
          }

          const methodName = args.method as string;
          const methodArgs = args.args as unknown[] | undefined;
          const method = (instance as Record<string, unknown>)[methodName];

          if (typeof method !== 'function') {
            return {
              availableMethods: getAvailableMethods(instance),
              error: `No method "${methodName}" on native instance`,
            };
          }

          try {
            const bound = (method as (...a: unknown[]) => unknown).bind(instance);
            const result = bound(...(methodArgs ?? []));
            return {
              component: getComponentName(fiber),
              method: methodName,
              result,
              success: true,
            };
          } catch (e) {
            return {
              error: `Method "${methodName}" threw: ${e instanceof Error ? e.message : String(e)}`,
            };
          }
        },
        inputSchema: {
          ...FIND_SCHEMA,
          args: { description: 'Arguments passed to the method.', type: 'array' },
          method: {
            description: 'Method name to call.',
            examples: ['focus', 'blur', 'measure'],
            type: 'string',
          },
        },
      },
      get_children: {
        description: 'Get the children subtree of a single component.',
        handler: (args) => {
          const rootError = requireRoot();
          if (rootError) return rootError;

          const fiber = findComponent(args);
          if (!fiber) return { error: 'Component not found' };

          const depth = (args.depth as number) || DEFAULT_DEPTH;
          const serialized = serializeFiber(fiber, depth);
          return serialized?.children ?? [];
        },
        inputSchema: {
          ...FIND_SCHEMA,
          depth: { description: 'Max traversal depth (default: 10).', type: 'number' },
        },
      },
      get_component: {
        description:
          'Find one component and return its details with children subtree (deep inspection). Use `query` for a flat list of matches.',
        handler: async (args) => {
          const rootError = requireRoot();
          if (rootError) return rootError;
          const root = getFiberRoot()!;

          let fiber = null;
          if (args.mcpId) {
            fiber = findByMcpId(root, args.mcpId as string);
          } else if (args.testID) {
            fiber = findByTestID(root, args.testID as string);
          } else if (args.name) {
            fiber = findByName(root, args.name as string);
          } else if (args.text) {
            fiber = findByText(root, args.text as string);
          }

          if (!fiber) return { error: 'Component not found' };

          const depth = (args.depth as number) || DEFAULT_DEPTH;
          const serialized = serializeFiber(fiber, depth);
          if (serialized && Array.isArray(args.select)) {
            const fields = new Set(args.select as string[]);
            if (fields.has('bounds')) {
              const bounds = await measureFiber(fiber);
              if (bounds) {
                serialized.bounds = bounds;
              }
            }
            if (!fields.has('props')) {
              serialized.props = {};
            }
          }
          return serialized;
        },
        inputSchema: {
          depth: { description: 'Max child traversal depth (default: 10).', type: 'number' },
          mcpId: { description: 'Stable data-mcp-id to match.', type: 'string' },
          name: { description: 'Component name to match.', type: 'string' },
          select: {
            description:
              'Fields to include on the root node. Available: name, props, bounds. Children are always included.',
            examples: [['name', 'bounds']],
            type: 'array',
          },
          testID: { description: 'testID to match.', type: 'string' },
          text: { description: 'Rendered text substring.', type: 'string' },
        },
      },
      get_props: {
        description: 'Get all props of one component.',
        handler: (args) => {
          const rootError = requireRoot();
          if (rootError) return rootError;

          const fiber = findComponent(args);
          if (!fiber) return { error: 'Component not found' };

          return {
            name: getComponentName(fiber),
            props: serializeProps(fiber.memoizedProps),
          };
        },
        inputSchema: FIND_SCHEMA,
      },
      get_ref_methods: {
        description: "List available methods on a component's native ref.",
        handler: (args) => {
          const rootError = requireRoot();
          if (rootError) return rootError;

          const fiber = findComponent(args);
          if (!fiber) return { error: 'Component not found' };

          const instance = getNativeInstance(fiber);
          if (!instance) {
            return { error: `Component "${getComponentName(fiber)}" has no native instance` };
          }

          return {
            component: getComponentName(fiber),
            methods: getAvailableMethods(instance),
          };
        },
        inputSchema: FIND_SCHEMA,
      },
      get_tree: {
        description: 'Dump the full React component tree from the root fiber.',
        handler: (args) => {
          const rootError = requireRoot();
          if (rootError) return rootError;
          const root = getFiberRoot()!;

          const depth = (args.depth as number) || DEFAULT_DEPTH;
          return serializeFiber(root, depth);
        },
        inputSchema: {
          depth: { description: 'Max traversal depth (default: 10).', type: 'number' },
        },
      },
      invoke: {
        description:
          'Call a callback prop on a component (onPress, onChangeText, onValueChange, …). Bypasses the OS gesture pipeline — for real touch testing use host__tap with query bounds.',
        handler: (args) => {
          const rootError = requireRoot();
          if (rootError) return rootError;

          const fiber = findComponent(args);
          if (!fiber) return { error: 'Component not found' };

          const callbackName = args.callback as string;
          const callbackArgs = args.args as unknown[] | undefined;
          const callback = fiber.memoizedProps?.[callbackName];

          if (typeof callback !== 'function') {
            const availableCallbacks = Object.keys(fiber.memoizedProps ?? {}).filter((key) => {
              return typeof fiber.memoizedProps[key] === 'function';
            });
            return {
              availableCallbacks,
              error: `Component "${getComponentName(fiber)}" has no "${callbackName}" callback`,
            };
          }

          const result = callback(...(callbackArgs ?? []));
          return { component: getComponentName(fiber), result, success: true };
        },
        inputSchema: {
          ...FIND_SCHEMA,
          args: {
            description: 'Arguments passed to the callback.',
            examples: [[true], ['text']],
            type: 'array',
          },
          callback: {
            description: 'Callback prop name.',
            examples: ['onPress', 'onChangeText', 'onValueChange'],
            type: 'string',
          },
        },
      },
      query: {
        description:
          'Chain-based fiber search. Each step narrows the result set via `scope` + criteria; multiple matches fan out into the next step. Returns { matches, total, truncated? }. See the module description for scope, criteria, select and response reference.',
        handler: async (args) => {
          const rootError = requireRoot();
          if (rootError) return rootError;
          const root = getFiberRoot()!;

          const steps = args.steps as QueryStep[] | undefined;
          if (!Array.isArray(steps) || steps.length === 0) {
            return { error: 'query requires a non-empty `steps` array' };
          }

          const limit =
            typeof args.limit === 'number' && args.limit > 0
              ? Math.min(Math.floor(args.limit), QUERY_LIMIT_MAX)
              : QUERY_LIMIT_DEFAULT;
          const dedup = args.dedup !== false;
          const useCache = args.cache !== false;
          const onlyVisible = args.onlyVisible === true;

          const runtime: QueryRuntime = { navigationRef, root };
          const rawMatches = runCachedQuery(runtime, steps, useCache);
          let all = dedup ? dedupAncestors(rawMatches) : rawMatches;

          let visibleRect: { height: number; width: number } | null = null;
          const boundsCache = new Map<Fiber, Bounds | null>();
          const measure = async (fiber: Fiber): Promise<Bounds | null> => {
            if (boundsCache.has(fiber)) return boundsCache.get(fiber) ?? null;
            const b = await measureFiber(fiber);
            boundsCache.set(fiber, b);
            return b;
          };

          if (onlyVisible) {
            visibleRect = getVisibleRect();
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

          const fields = new Set(
            Array.isArray(args.select) ? (args.select as string[]) : QUERY_DEFAULT_FIELDS
          );
          const propsInclude = Array.isArray(args.propsInclude)
            ? new Set(args.propsInclude as string[])
            : null;

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
                const full = serializeProps(fiber.memoizedProps);
                if (propsInclude) {
                  const filtered: Record<string, unknown> = {};
                  for (const key of propsInclude) {
                    if (key in full) filtered[key] = full[key];
                  }
                  result.props = filtered;
                } else {
                  result.props = full;
                }
              }
              if (fields.has('testID')) {
                result.testID = fiber.memoizedProps?.testID;
              }
              return result;
            })
          );

          const response: Record<string, unknown> = { matches, total };
          if (truncated) response.truncated = true;
          return response;
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
          propsInclude: {
            description:
              'When select includes "props", keep only these prop names. Unknown keys are silently dropped. Omit for full serialization.',
            examples: [
              ['placeholder', 'value'],
              ['title', 'disabled'],
            ],
            type: 'array',
          },
          select: {
            description: `Output fields: mcpId, name, testID, props, bounds. Default ${JSON.stringify(QUERY_DEFAULT_FIELDS)}.`,
            examples: [
              ['mcpId', 'name', 'bounds'],
              ['mcpId', 'name', 'props'],
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
        },
      },
    },
  };
};
