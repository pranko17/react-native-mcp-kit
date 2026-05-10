import { type CollapseRule, projectValue, type ProjectOptions } from '@/shared/projectValue';

import {
  type Bounds,
  type ComponentQuery,
  type ComponentType,
  type PropMatcher,
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

// Props/values to drop — internal React/RN bookkeeping that bloats output.
// Used by `projectFiberValue` below as `skipKeys`. Anything matching the
// `__`-prefix regex is also dropped (covers `__nativeTag`, `__reactProps$...`,
// react-refresh internal markers, etc.).
const SKIP_KEYS_FIBER: Array<string | RegExp> = [
  '__internalInstanceHandle',
  '__nativeTag',
  'children',
  'collapsableChildren',
  'ref',
  /^__/,
];

// Collapse rule: detect React elements / fiber nodes / native instances and
// replace them with compact `${...}`-keyed marker objects. Stops projectValue
// from descending into ~unbounded React internals graph and emits something
// the agent can act on (mcpId / componentName).
const fiberCollapseRule: CollapseRule = (value: unknown) => {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;

  // React element — has `$$typeof` symbol
  if ('$$typeof' in obj) {
    return { ['${ReactElement}']: true };
  }

  // Fiber-like or native-instance — try to extract a compact ref
  const looksLikeFiberOrNative =
    'stateNode' in obj || 'memoizedProps' in obj || '__nativeTag' in obj;
  if (!looksLikeFiberOrNative) return undefined;

  // pull a fiber out — direct, or via internal handle on a native view
  const fiber: Fiber =
    (obj._reactInternals as Fiber | undefined) ??
    (obj._reactInternalFiber as Fiber | undefined) ??
    (obj._internalFiberInstanceHandleDEV as Fiber | undefined) ??
    (obj._internalInstanceHandle as Fiber | undefined) ??
    ('memoizedProps' in obj ? (obj as Fiber) : undefined);

  const meta: Record<string, unknown> = {};
  if (fiber) {
    const props = fiber.memoizedProps as Record<string, unknown> | null | undefined;
    const mcpId = props?.['data-mcp-id'];
    const testID = props?.testID;
    if (mcpId) meta.mcpId = mcpId;
    if (testID) meta.testID = testID;
    const typeName =
      (fiber.type as { displayName?: string; name?: string } | null | undefined)?.displayName ??
      (fiber.type as { displayName?: string; name?: string } | null | undefined)?.name;
    if (typeName) meta.name = typeName;
  }
  if ('__nativeTag' in obj) {
    meta.nativeTag = obj.__nativeTag;
    const viewConfig = obj.viewConfig as { uiViewClassName?: string } | undefined;
    if (viewConfig?.uiViewClassName) meta.viewClass = viewConfig.uiViewClassName;
  }

  return { ['${ref}']: Object.keys(meta).length > 0 ? meta : true };
};

/**
 * Projection helper used everywhere fiber values are serialised (props, hook
 * values, fiber refs). Pre-applies the fiber-aware collapse rule + skip list
 * over the shared `projectValue`. Callers can pass `path` / `depth` / etc.
 * through `options` like with `projectValue` directly.
 */
export const projectFiberValue = (value: unknown, options: ProjectOptions = {}): unknown => {
  return projectValue(value, {
    ...options,
    collapse: [fiberCollapseRule, ...(options.collapse ?? [])],
    skipKeys: [...SKIP_KEYS_FIBER, ...(options.skipKeys ?? [])],
  }).value;
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
  // Pass raw memoizedProps through — handler-level `applyProjection` runs the
  // single canonical projectValue walk on the final response, including this
  // tree. Projecting here would cause double-projection and break path drill.
  const props = (fiber.memoizedProps ?? {}) as Record<string, unknown>;
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

// Cap for object/array serialization used by contains/regex matchers.
// Large fiber props (e.g. deep Redux state, Reanimated shared values) would
// otherwise turn into megabyte-strings per fiber.
const MATCH_STRING_CAP = 10_000;

/**
 * Turn any prop value into a string usable by `contains` / `regex` matchers.
 * - Primitives and functions/symbols go through String(), preserving the
 *   "substring on text props" intuition (e.g. placeholder = "Search" stays
 *   "Search", not '"Search"').
 * - Objects and arrays are JSON-serialized with circular refs replaced, so a
 *   regex like `"title":"Hello"` or `\\bonPress\\b` can still land. Functions
 *   and symbols become placeholders; bigint becomes its decimal string.
 * - Output is capped at MATCH_STRING_CAP characters to keep response costs
 *   bounded on large prop graphs.
 */
const stringifyForMatching = (value: unknown): string => {
  if (value === null || value === undefined) return String(value);
  const type = typeof value;
  if (type !== 'object') return String(value);

  try {
    const seen = new WeakSet<object>();
    const serialized = JSON.stringify(value, (_key, v) => {
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      if (typeof v === 'function') return '[Function]';
      if (typeof v === 'symbol') return v.toString();
      if (typeof v === 'bigint') return v.toString();
      return v;
    });
    if (typeof serialized !== 'string') return String(value);
    return serialized.length > MATCH_STRING_CAP
      ? serialized.slice(0, MATCH_STRING_CAP)
      : serialized;
  } catch {
    return String(value);
  }
};

const matchPropValue = (actual: unknown, matcher: PropMatcher): boolean => {
  if (matcher !== null && typeof matcher === 'object') {
    if (actual === undefined || actual === null) return false;
    const isPrimitive = typeof actual !== 'object';
    const deep = (matcher as { deep?: boolean }).deep === true;
    // Non-primitive values only participate when the caller opts in with
    // `deep: true`. This keeps naive placeholder/testID matchers from
    // accidentally hitting stringified objects.
    if (!isPrimitive && !deep) return false;
    const asString = isPrimitive ? String(actual) : stringifyForMatching(actual);
    if ('contains' in matcher && typeof matcher.contains === 'string') {
      return asString.includes(matcher.contains);
    }
    if ('regex' in matcher && typeof matcher.regex === 'string') {
      try {
        return new RegExp(matcher.regex).test(asString);
      } catch {
        return false;
      }
    }
    return false;
  }
  return actual === matcher;
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
    if (query.props && typeof query.props === 'object') {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== 'object') return false;
      for (const key of Object.keys(query.props)) {
        if (!matchPropValue(props[key], query.props[key]!)) return false;
      }
    }
    if (Array.isArray(query.any) && query.any.length > 0) {
      const anyMatched = query.any.some((sub) => {
        return matchesQuery(fiber, sub);
      });
      if (!anyMatched) return false;
    }
    if (query.not) {
      if (Array.isArray(query.not)) {
        for (const sub of query.not) {
          if (matchesQuery(fiber, sub)) return false;
        }
      } else if (typeof query.not === 'object') {
        if (matchesQuery(fiber, query.not)) return false;
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

// Find the nearest host fiber (native component) from a given fiber.
export const findHostFiber = (fiber: Fiber): Fiber | null => {
  if (fiber.tag === HOST_COMPONENT) return fiber;

  let child = fiber.child;
  while (child) {
    const found = findHostFiber(child);
    if (found) return found;
    child = child.sibling;
  }
  return null;
};

// React Navigation internals that appear in the route.key match chain but
// are not the user's screen component — we walk past them to the real leaf.
const RN_NAV_WRAPPERS = new Set([
  'Anonymous',
  'ForwardRef',
  'Memo',
  'SceneView',
  'Screen',
  'StaticContainer',
]);

/**
 * Locate the screen fiber rendering the given React Navigation route key.
 * Route keys are unique per mounted screen; React Navigation forwards the
 * `route` prop down a short wrapper chain (SceneView → StaticContainer → …→
 * user component). Returns the deepest non-wrapper match so queries land on
 * the developer's screen component, not on a generated wrapper.
 */
export const findScreenFiberByRouteKey = (root: Fiber, routeKey: string): Fiber | null => {
  const matches = findAllFibers(root, (f) => {
    const props = f.memoizedProps as { route?: { key?: string } } | null | undefined;
    return props?.route?.key === routeKey;
  });
  if (matches.length === 0) return null;
  for (let i = matches.length - 1; i >= 0; i--) {
    const candidate = matches[i]!;
    if (!RN_NAV_WRAPPERS.has(getComponentName(candidate))) {
      return candidate;
    }
  }
  return matches[matches.length - 1]!;
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
