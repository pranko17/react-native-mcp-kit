import { type McpModule } from '@/client/models/types';

import {
  findAllByQuery,
  findByName,
  findByMcpId,
  findByTestID,
  findByText,
  getAvailableMethods,
  getFiberRoot,
  getComponentName,
  getNativeInstance,
  initFiberRootCapture,
  serializeFiber,
  serializeProps,
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

export const componentsModule = (): McpModule => {
  initFiberRootCapture();

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
    name: 'components',
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
      find_all: {
        description:
          'Find all components matching a query (by testID, name, text, or props presence). Supports within for scoped search.',
        handler: (args) => {
          const rootError = requireRoot();
          if (rootError) return rootError;
          let root = getFiberRoot()!;

          if (args.within) {
            const path = (args.within as string).split('/');
            for (const segment of path) {
              root = findInRoot(root, segment);
              if (!root) return { error: `Parent "${args.within}" not found` };
            }
          }

          const query = {
            hasProps: args.hasProps as string[] | undefined,
            mcpId: args.mcpId as string | undefined,
            name: args.name as string | undefined,
            testID: args.testID as string | undefined,
            text: args.text as string | undefined,
          };

          const fibers = findAllByQuery(root, query);
          return fibers.map((fiber) => {
            return {
              mcpId: fiber.memoizedProps?.['data-mcp-id'],
              name: getComponentName(fiber),
              props: serializeProps(fiber.memoizedProps),
              testID: fiber.memoizedProps?.testID,
            };
          });
        },
        inputSchema: {
          hasProps: {
            description: 'Filter by props presence (array of prop names)',
            type: 'array',
          },
          mcpId: { description: 'data-mcp-id to match', type: 'string' },
          name: { description: 'Component name to match', type: 'string' },
          testID: { description: 'testID to match', type: 'string' },
          text: { description: 'Text content to match (substring)', type: 'string' },
          within: FIND_SCHEMA.within,
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
        description: 'Find a component by testID, name, or text and return its details',
        handler: (args) => {
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
          return serializeFiber(fiber, depth);
        },
        inputSchema: {
          depth: { description: 'Max depth to traverse children (default: 3)', type: 'number' },
          mcpId: { description: 'data-mcp-id to search for', type: 'string' },
          name: { description: 'Component name to search for', type: 'string' },
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
          'Call any callback prop on a component found by testID, name, or text. Use this to simulate press, scroll, text input, or any other interaction.',
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
    },
  };
};
