import {
  type Bounds,
  type ComponentQuery,
  type ComponentType,
  type SerializedComponent,
} from './types';

// Fiber tag constants
const HOST_COMPONENT = 5;
const HOST_TEXT = 6;
const FUNCTION_COMPONENT = 0;
const CLASS_COMPONENT = 1;
const FORWARD_REF = 11;
const MEMO = 14;
const SIMPLE_MEMO = 15;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fiber = any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let rootRefStore: any = null;

export const setRootRef = (ref: unknown): void => {
  rootRefStore = ref;
};

const getFiberFromRef = (ref: unknown): Fiber | null => {
  if (!ref) return null;
  const r = ref as Record<string, unknown>;
  const fiber = r._internalInstanceHandle ?? r.__internalInstanceHandle ?? r._reactInternals;
  if (!fiber) return null;

  let current = fiber as Fiber;
  while (current.return) {
    current = current.return;
  }
  return current;
};

export const getFiberRoot = (): Fiber | null => {
  if (rootRefStore?.current) {
    return getFiberFromRef(rootRefStore.current);
  }
  return null;
};

export const getComponentName = (fiber: Fiber): string => {
  if (!fiber.type) return 'Unknown';

  if (typeof fiber.type === 'string') {
    return fiber.type;
  }

  if (typeof fiber.type === 'function') {
    return fiber.type.displayName || fiber.type.name || 'Anonymous';
  }

  if (typeof fiber.type === 'object') {
    // ForwardRef
    if (fiber.type.render) {
      return (
        fiber.type.displayName ||
        fiber.type.render.displayName ||
        fiber.type.render.name ||
        'ForwardRef'
      );
    }
    // Memo
    if (fiber.type.type) {
      return (
        fiber.type.displayName || fiber.type.type.displayName || fiber.type.type.name || 'Memo'
      );
    }
    return fiber.type.displayName || 'Unknown';
  }

  return 'Unknown';
};

const getComponentType = (fiber: Fiber): ComponentType => {
  if (fiber.tag === HOST_TEXT) return 'text';
  if (fiber.tag === HOST_COMPONENT) return 'host';
  if (
    fiber.tag === FUNCTION_COMPONENT ||
    fiber.tag === CLASS_COMPONENT ||
    fiber.tag === FORWARD_REF ||
    fiber.tag === MEMO ||
    fiber.tag === SIMPLE_MEMO
  ) {
    return 'composite';
  }
  return 'other';
};

const MAX_VALUE_DEPTH = 3;

const serializeValue = (value: unknown, seen = new WeakSet<object>(), depth = 0): unknown => {
  if (value === null || value === undefined) return value;
  if (depth > MAX_VALUE_DEPTH) return '[...]';

  if (typeof value === 'function') {
    return `[Function: ${value.name || 'anonymous'}]`;
  }

  if (typeof value === 'symbol') {
    return value.toString();
  }

  if (typeof value !== 'object') return value;

  // React element
  if (value && typeof value === 'object' && '$$typeof' in value) {
    return '[ReactElement]';
  }

  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  // Skip objects that look like fiber nodes or native instances
  if (
    value &&
    typeof value === 'object' &&
    ('stateNode' in value || 'memoizedProps' in value || '__nativeTag' in value)
  ) {
    return '[InternalObject]';
  }

  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => {
      return serializeValue(item, seen, depth + 1);
    });
  }

  const result: Record<string, unknown> = {};
  try {
    const keys = Object.keys(value);
    for (const key of keys.slice(0, 20)) {
      if (key.startsWith('__')) continue;
      try {
        result[key] = serializeValue((value as Record<string, unknown>)[key], seen, depth + 1);
      } catch {
        result[key] = '[Error]';
      }
    }
  } catch {
    return '[Object]';
  }
  return result;
};

// Props to skip — internal React/RN properties that bloat output
const SKIP_PROPS = new Set([
  '__internalInstanceHandle',
  '__nativeTag',
  'children',
  'collapsableChildren',
  'ref',
]);

export const serializeProps = (props: Record<string, unknown> | null): Record<string, unknown> => {
  if (!props) return {};

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(props)) {
    if (SKIP_PROPS.has(key)) continue;
    if (key.startsWith('__')) continue;
    try {
      result[key] = serializeValue(props[key]);
    } catch {
      result[key] = '[Error reading prop]';
    }
  }
  return result;
};

const getTextContent = (fiber: Fiber): string | undefined => {
  if (fiber.tag === HOST_TEXT) {
    return fiber.memoizedProps;
  }

  // Check children for text
  let text = '';
  let child = fiber.child;
  while (child) {
    if (child.tag === HOST_TEXT && typeof child.memoizedProps === 'string') {
      text += child.memoizedProps;
    }
    child = child.sibling;
  }

  return text || undefined;
};

export const serializeFiber = (
  fiber: Fiber,
  maxDepth: number,
  currentDepth = 0
): SerializedComponent | null => {
  if (!fiber || currentDepth > maxDepth) return null;

  try {
    return serializeFiberUnsafe(fiber, maxDepth, currentDepth);
  } catch {
    return {
      children: [],
      name: getComponentName(fiber),
      props: { __error: 'Failed to serialize' },
      type: getComponentType(fiber),
    };
  }
};

// Host components that are just native mirrors of composite wrappers (e.g. RCTView for View)
const HOST_PASSTHROUGH = new Set(['RCTView', 'RCTText', 'RCTScrollView', 'RCTSafeAreaView']);

const shouldSkipFiber = (fiber: Fiber): boolean => {
  const componentType = getComponentType(fiber);

  // Skip internal React wrapper nodes (providers, contexts, etc.)
  if (componentType === 'other' && fiber.tag !== HOST_TEXT) return true;

  // Skip native host mirrors — their composite parent already represents the same component
  if (componentType === 'host' && HOST_PASSTHROUGH.has(getComponentName(fiber))) return true;

  return false;
};

const collectChildren = (
  fiber: Fiber,
  maxDepth: number,
  currentDepth: number
): SerializedComponent[] => {
  const children: SerializedComponent[] = [];
  let child = fiber.child;
  while (child) {
    if (shouldSkipFiber(child)) {
      // Skip this node but collect its children at the same depth
      children.push(...collectChildren(child, maxDepth, currentDepth));
    } else {
      const serialized = serializeFiber(child, maxDepth, currentDepth + 1);
      if (serialized) {
        children.push(serialized);
      }
    }
    child = child.sibling;
  }
  return children;
};

const serializeFiberUnsafe = (
  fiber: Fiber,
  maxDepth: number,
  currentDepth: number
): SerializedComponent | null => {
  if (shouldSkipFiber(fiber)) {
    const children = collectChildren(fiber, maxDepth, currentDepth);
    if (children.length === 1) return children[0]!;
    if (children.length > 1) {
      return {
        children,
        name: 'Fragment',
        props: {},
        type: 'other',
      };
    }
    return null;
  }

  const name = getComponentName(fiber);
  const props = serializeProps(fiber.memoizedProps);
  const mcpId = fiber.memoizedProps?.['data-mcp-id'] as string | undefined;
  const testID = fiber.memoizedProps?.testID as string | undefined;
  const text = getTextContent(fiber);
  const children = collectChildren(fiber, maxDepth, currentDepth);

  return {
    children,
    mcpId,
    name,
    props,
    testID,
    text,
    type: getComponentType(fiber),
  };
};

export const findFiber = (root: Fiber, predicate: (fiber: Fiber) => boolean): Fiber | null => {
  if (predicate(root)) return root;

  let child = root.child;
  while (child) {
    const found = findFiber(child, predicate);
    if (found) return found;
    child = child.sibling;
  }

  return null;
};

export const findAllFibers = (root: Fiber, predicate: (fiber: Fiber) => boolean): Fiber[] => {
  const results: Fiber[] = [];

  const walk = (fiber: Fiber) => {
    if (predicate(fiber)) {
      results.push(fiber);
    }
    let child = fiber.child;
    while (child) {
      walk(child);
      child = child.sibling;
    }
  };

  walk(root);
  return results;
};

export const findByMcpId = (root: Fiber, mcpId: string): Fiber | null => {
  return findFiber(root, (fiber) => {
    return fiber.memoizedProps?.['data-mcp-id'] === mcpId;
  });
};

export const findByTestID = (root: Fiber, testID: string): Fiber | null => {
  return findFiber(root, (fiber) => {
    return fiber.memoizedProps?.testID === testID;
  });
};

export const findByName = (root: Fiber, name: string): Fiber | null => {
  return findFiber(root, (fiber) => {
    return getComponentName(fiber) === name;
  });
};

export const findByText = (root: Fiber, text: string): Fiber | null => {
  return findFiber(root, (fiber) => {
    const content = getTextContent(fiber);
    return content !== undefined && content.includes(text);
  });
};

export const matchesQuery = (fiber: Fiber, query: ComponentQuery): boolean => {
  try {
    if (query.mcpId && fiber.memoizedProps?.['data-mcp-id'] !== query.mcpId) return false;
    if (query.testID && fiber.memoizedProps?.testID !== query.testID) return false;
    if (query.name && getComponentName(fiber) !== query.name) return false;
    if (query.text) {
      const content = getTextContent(fiber);
      if (!content || !content.includes(query.text)) return false;
    }
    if (query.hasProps && Array.isArray(query.hasProps)) {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== 'object') return false;
      for (const prop of query.hasProps) {
        if (!(prop in props)) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
};

export const findAllByQuery = (root: Fiber, query: ComponentQuery): Fiber[] => {
  return findAllFibers(root, (fiber) => {
    return matchesQuery(fiber, query);
  });
};

// Direct children of a fiber (one level down, not descendants).
export const getDirectChildren = (fiber: Fiber): Fiber[] => {
  const out: Fiber[] = [];
  let child = fiber.child;
  while (child) {
    out.push(child);
    child = child.sibling;
  }
  return out;
};

// Sibling fibers at the same level, excluding `fiber` itself.
export const getSiblings = (fiber: Fiber): Fiber[] => {
  const parent = fiber.return;
  if (!parent) return [];
  return getDirectChildren(parent).filter((f) => {
    return f !== fiber;
  });
};

// Ancestors walked upward via `fiber.return`, nearest first.
export const getAncestors = (fiber: Fiber): Fiber[] => {
  const out: Fiber[] = [];
  let current = fiber.return;
  while (current) {
    out.push(current);
    current = current.return;
  }
  return out;
};

// Find the nearest host fiber (native component) from a given fiber
const findHostFiber = (fiber: Fiber): Fiber | null => {
  if (fiber.tag === HOST_COMPONENT) return fiber;

  let child = fiber.child;
  while (child) {
    const found = findHostFiber(child);
    if (found) return found;
    child = child.sibling;
  }
  return null;
};

// Get the native instance (stateNode) or ref from a fiber
export const getNativeInstance = (fiber: Fiber): unknown => {
  // For host components, stateNode has the native instance
  const hostFiber = findHostFiber(fiber);
  if (hostFiber?.stateNode) {
    // Fabric (new architecture): stateNode.canonical.publicInstance
    const canonical = hostFiber.stateNode.canonical;
    if (canonical?.publicInstance) {
      return canonical.publicInstance;
    }
    // Old architecture: stateNode directly
    return hostFiber.stateNode;
  }

  // Check for ref on the fiber
  if (fiber.ref) {
    if (typeof fiber.ref === 'function') return null;
    if (fiber.ref.current) return fiber.ref.current;
  }

  return null;
};

// Measure the on-screen rect of the host view backing a fiber, in PHYSICAL
// pixels (top-left origin). Uses `UIManager.measure(node, cb)` which yields
// `pageX/pageY` — coordinates relative to the React root view, mapped to
// `View.getLocationOnScreen` on Android. This is what `adb shell input tap`
// expects (and `xcrun simctl io ... tap` on iOS), unlike `measureInWindow`
// whose origin is the visible window and shifts depending on translucent
// status-bar / SafeArea insets.
//
// Returns null when the fiber has no mounted host view (unmounted, virtualized
// off-screen, etc.) or when measure throws.
export const measureFiber = async (fiber: Fiber): Promise<Bounds | null> => {
  const hostFiber = findHostFiber(fiber);
  if (!hostFiber?.stateNode) return null;

  // Mirror the Fabric / old-arch fork from getNativeInstance.
  const canonical = hostFiber.stateNode.canonical;
  const instance = canonical?.publicInstance ?? hostFiber.stateNode;
  if (!instance) return null;

  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const RN = require('react-native');
  const { PixelRatio, UIManager, findNodeHandle } = RN;
  const handle: number | null =
    typeof findNodeHandle === 'function' ? findNodeHandle(instance) : null;
  if (handle == null) return null;

  return new Promise((resolve) => {
    try {
      UIManager.measure(
        handle,
        (_x: number, _y: number, width: number, height: number, pageX: number, pageY: number) => {
          if (
            !Number.isFinite(pageX) ||
            !Number.isFinite(pageY) ||
            !Number.isFinite(width) ||
            !Number.isFinite(height)
          ) {
            resolve(null);
            return;
          }
          const ratio = PixelRatio.get();
          const px = Math.round(pageX * ratio);
          const py = Math.round(pageY * ratio);
          const pw = Math.round(width * ratio);
          const ph = Math.round(height * ratio);
          resolve({
            centerX: Math.round(px + pw / 2),
            centerY: Math.round(py + ph / 2),
            height: ph,
            width: pw,
            x: px,
            y: py,
          });
        }
      );
    } catch {
      resolve(null);
    }
  });
};

export const getAvailableMethods = (instance: unknown): string[] => {
  if (!instance || typeof instance !== 'object') return [];

  const methods: string[] = [];
  let proto = Object.getPrototypeOf(instance);
  while (proto && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (
        key !== 'constructor' &&
        typeof (instance as Record<string, unknown>)[key] === 'function'
      ) {
        methods.push(key);
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  return [...new Set(methods)].sort();
};
