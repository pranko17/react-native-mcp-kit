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
    description: 'Zero-based index when multiple components match (default: 0, i.e. first match)',
    type: 'number',
  },
  mcpId: { description: 'data-mcp-id to search for', type: 'string' },
  name: { description: 'Component name to search for', type: 'string' },
  testID: { description: 'testID to search for', type: 'string' },
  text: { description: 'Text content to search for', type: 'string' },
  within: {
    description:
      'Search within a parent component path. Use "/" for nesting, ":N" for index. E.g. "Checkbox/Pressable", "Button:1/View"',
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
    description: `React component tree inspection and interaction.

## Finding components — \`query\`
Chain-based search. Each step filters the fibers forwarded from the
previous step via a \`scope\` (descendants / children / parent / ancestors
/ siblings / self) and the usual criteria (name / mcpId / testID / text /
hasProps). First step defaults to scope 'descendants' from the root, so
\`query({ steps: [{ hasProps: ["onPress"] }] })\` is "all pressables in the
tree". Multi-match friendly — if a step matches many fibers, all of them
fan out into the next step; use \`index\` on a step to pick just one.

Examples:
- [{ name: "HomeScreen" }, { name: "ProductCard" }, { testID: "favorite" }]
    → every "favorite" testID inside every ProductCard inside HomeScreen.
- [{ testID: "favorite-icon" }, { scope: "ancestors", name: "ProductCard", index: 0 }]
    → the nearest enclosing ProductCard for each favorite icon.

\`get_component\` still exists when you want a single match plus its full
children subtree (for deep inspection rather than flat lists).

## Interacting
- invoke with callback: "onPress" — press a button
- invoke with callback: "onChangeText", args: ["text"] — type into input
- invoke with callback: "onPress", args: [true] — toggle checkbox
- call_ref with method: "focus" — focus an input

## Coordinates (host__tap targets)
- Pass \`select: ["mcpId", "name", "bounds"]\` to \`query\` to get tap
  coordinates without heavy props.
- bounds = {x, y, width, height, centerX, centerY} in PHYSICAL PIXELS.
- Use bounds.centerX/centerY directly with host__tap — no scaling needed.
- bounds is null only when the component has no host view (unmounted,
  virtualized off-screen).

## Saving tokens with select
- \`select\` controls which fields appear in each result: mcpId, name,
  testID, props, bounds. Default (no select): all except bounds. Omit
  "props" to cut response size ~90% when you only need names/IDs.

## Tips
- mcpId is stable across renders (format: ComponentName:file:line).
- Use \`query\` first to discover available components, then invoke or
  host__tap them by mcpId/testID.
- host__tap with bounds.centerX/centerY tests the real OS gesture
  pipeline; invoke bypasses it and calls the prop directly (faster, immune
  to overlay/gesture-arbitration issues, but doesn't exercise touch
  handlers).
- Use screenshot after interactions to verify results.`,
    name: 'fiber_tree',
    tools: {
      call_ref: {
        description:
          'Call a method on the native ref/instance of a component (e.g. focus, blur, measure). Use get_ref_methods first to see available methods.',
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
          args: { description: 'Arguments to pass to the method as array', type: 'array' },
          method: {
            description: 'Method name to call (e.g. "focus", "blur", "measure")',
            type: 'string',
          },
        },
      },
      get_children: {
        description: 'Get children of a component found by testID, name, or text',
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
          depth: { description: 'Max depth to traverse (default: 10)', type: 'number' },
        },
      },
      get_component: {
        description:
          'Find a component by testID, name, or text and return its details. Use select to control root-level fields — e.g. select: ["name", "bounds"] to include tap coordinates without props.',
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
          depth: { description: 'Max depth to traverse children (default: 3)', type: 'number' },
          mcpId: { description: 'data-mcp-id to search for', type: 'string' },
          name: { description: 'Component name to search for', type: 'string' },
          select: {
            description:
              'Fields to include on root node. Available: name, props, bounds. Include "bounds" for tap coordinates. Omit "props" to save tokens. Children are always included.',
            type: 'array',
          },
          testID: { description: 'testID to search for', type: 'string' },
          text: { description: 'Text content to search for', type: 'string' },
        },
      },
      get_props: {
        description: 'Get all props of a component found by testID, name, or text',
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
        description: 'List available methods on the native ref/instance of a component',
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
        description:
          'Get the React component tree. Returns component names, types, props, and testIDs.',
        handler: (args) => {
          const rootError = requireRoot();
          if (rootError) return rootError;
          const root = getFiberRoot()!;

          const depth = (args.depth as number) || DEFAULT_DEPTH;
          return serializeFiber(root, depth);
        },
        inputSchema: {
          depth: { description: 'Max depth to traverse (default: 3)', type: 'number' },
        },
      },
      invoke: {
        description:
          'Call any callback prop on a component found by testID, name, or text. Use this to simulate press, scroll, text input, or any other interaction. Bypasses the OS gesture pipeline — faster and immune to overlay/gesture-arbitration issues, but does not exercise touch handlers. Prefer host__tap (with fiber_tree bounds) when you want to test the real user touch path.',
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
            description: 'Arguments to pass to the callback as array (e.g. [true] or ["text"])',
            type: 'array',
          },
          callback: {
            description: 'Name of the callback prop to call (e.g. "onPress", "onChangeText")',
            type: 'string',
          },
        },
      },
      query: {
        description: `Chain-based component search. Each step narrows the set of
matching fibers, starting from the fiber root. A step has a \`scope\`
(default 'descendants' — walks the whole subtree; other values: 'children',
'parent', 'ancestors', 'siblings', 'self') and the usual criteria
(mcpId / testID / name / text / hasProps). If a step matches more than one
fiber, every match is forwarded to the next step; set \`index\` on a step to
pick just the N-th. The last step's matches are returned as a list.

Examples:
- [{ name: "HomeScreen" }, { name: "ProductCard" }]
    → every ProductCard inside HomeScreen
- [{ testID: "favorite-icon" }, { scope: "ancestors", name: "ProductCard", index: 0 }]
    → the nearest enclosing ProductCard around each favorite icon
- [{ name: "Button" }, { scope: "siblings", hasProps: ["onPress"] }]
    → every pressable sibling of every Button

Use \`select\` to control which fields come back on each match (mcpId / name /
testID / props / bounds); default omits bounds, include "bounds" for
host__tap coordinates, omit "props" to cut response size.`,
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
            description:
              'Fields to include in each result. Available: mcpId, name, testID, props, bounds. Default: all except bounds. Include "bounds" for physical-pixel tap coordinates, omit "props" to save tokens.',
            type: 'array',
          },
          steps: {
            description:
              'Ordered list of query steps. Each step: { scope?, name?, mcpId?, testID?, text?, hasProps?, index? }. scope defaults to "descendants" on the first step (walks the whole tree) and on subsequent steps. See the tool description for end-to-end examples.',
            type: 'array',
          },
        },
      },
    },
  };
};
