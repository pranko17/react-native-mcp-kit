import { type Fiber } from '@/modules/fiberTree/types';
import {
  type CollapseRule,
  projectValue,
  type ProjectOptions,
} from '@/shared/projection/projectValue';

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
