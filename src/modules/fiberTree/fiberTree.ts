import { type RefObject } from 'react';

import { type McpModule } from '@/client/models/types';

import { type ComponentQuery } from './types';
import {
  findAllByQuery,
  findByMcpId,
  findByName,
  findByTestID,
  findByText,
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

interface FiberTreeModuleOptions {
  rootRef?: RefObject<unknown>;
}

type QueryScope = 'ancestors' | 'children' | 'descendants' | 'parent' | 'self' | 'siblings';

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

const collectByScope = (fiber: Fiber, scope: QueryScope): Fiber[] => {
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
    case 'descendants':
    default:
      return findAllByQuery(fiber, {}).filter((f) => {
        return f !== fiber;
      });
  }
};

const runQueryChain = (root: Fiber, steps: QueryStep[]): Fiber[] => {
  let current: Fiber[] = [root];
  for (const step of steps) {
    const scope: QueryScope = step.scope ?? 'descendants';
    const seen = new Set<Fiber>();
    const collected: Fiber[] = [];
    for (const fiber of current) {
      for (const candidate of collectByScope(fiber, scope)) {
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

export const fiberTreeModule = (options?: FiberTreeModuleOptions): McpModule => {
  if (options?.rootRef) {
    setRootRef(options.rootRef);
  }

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
  descendants (default) / children / parent / ancestors / siblings / self.

STEP CRITERIA
  name / mcpId / testID — strict equality.
  text — substring match in RENDERED text only (not prop values).
  hasProps — array of prop names that must exist.
  props — map of prop → matcher:
    · primitive → strict equality.
    · { contains: "X" } / { regex: "Y" } → match via String(value); primitives only by default.
    · add deep: true → also JSON-serialize objects/arrays and match inside.
  index — pick N-th match from this step; otherwise all matches fan out into the next step.

SELECT (output fields)
  ["mcpId", "name", "testID", "props", "bounds"] — default omits bounds.
  bounds is { x, y, width, height, centerX, centerY } in PHYSICAL pixels,
  top-left origin. Null when the fiber has no mounted host view. centerX/
  centerY feed straight into host__tap.
  Omit "props" to cut response size ~90%.

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
          'Chain-based fiber search. Each step narrows the result set via `scope` + criteria; multiple matches fan out into the next step. See the module description for scope, criteria and select reference.',
        handler: async (args) => {
          const rootError = requireRoot();
          if (rootError) return rootError;
          const root = getFiberRoot()!;

          const steps = args.steps as QueryStep[] | undefined;
          if (!Array.isArray(steps) || steps.length === 0) {
            return { error: 'query requires a non-empty `steps` array' };
          }

          const matches = runQueryChain(root, steps);

          const defaultFields = ['mcpId', 'name', 'props', 'testID'];
          const fields = new Set(
            Array.isArray(args.select) ? (args.select as string[]) : defaultFields
          );

          return Promise.all(
            matches.map(async (fiber) => {
              const result: Record<string, unknown> = {};
              if (fields.has('bounds')) {
                result.bounds = await measureFiber(fiber);
              }
              if (fields.has('mcpId')) {
                result.mcpId = fiber.memoizedProps?.['data-mcp-id'];
              }
              if (fields.has('name')) {
                result.name = getComponentName(fiber);
              }
              if (fields.has('props')) {
                result.props = serializeProps(fiber.memoizedProps);
              }
              if (fields.has('testID')) {
                result.testID = fiber.memoizedProps?.testID;
              }
              return result;
            })
          );
        },
        inputSchema: {
          select: {
            description: 'Output fields: mcpId, name, testID, props, bounds.',
            examples: [
              ['mcpId', 'name', 'bounds'],
              ['mcpId', 'testID'],
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
