import { type Fiber } from '@/modules/fiberTree/types';

// Try to treat `current` as a React component / native view instance and
// collapse it to a compact identifier. Native views expose
// `_internalFiberInstanceHandleDEV` / `_reactInternals`; class instances
// expose `_reactInternals`. If we find a fiber, we surface its mcpId /
// testID / component name so the agent can follow up via `query` if needed.
// If it doesn't look like a component, return null to signal "serialize
// normally".
const resolveComponentRef = (current: unknown): Record<string, unknown> | null => {
  if (current === null || current === undefined) return null;
  if (typeof current !== 'object') return null;
  const obj = current as Record<string, unknown>;

  // Pick up a fiber from the typical internal fields used by RN / React.
  const fiber =
    (obj._reactInternals as Fiber | undefined) ??
    (obj._reactInternalFiber as Fiber | undefined) ??
    (obj._internalFiberInstanceHandleDEV as Fiber | undefined) ??
    (obj._internalInstanceHandle as Fiber | undefined);

  const hasNativeTag = '_nativeTag' in obj;
  if (!fiber && !hasNativeTag) return null;

  const out: Record<string, unknown> = { __componentRef: true };

  if (fiber) {
    const props = fiber.memoizedProps as Record<string, unknown> | null | undefined;
    const mcpId = props?.['data-mcp-id'];
    const testID = props?.testID;
    if (mcpId) out.mcpId = mcpId;
    if (testID) out.testID = testID;
    const typeName =
      (fiber.type as { displayName?: string; name?: string } | null | undefined)?.displayName ??
      (fiber.type as { displayName?: string; name?: string } | null | undefined)?.name;
    if (typeName) out.componentName = typeName;
  }

  if (hasNativeTag) {
    out.nativeTag = obj._nativeTag;
    const viewConfig = obj.viewConfig as { uiViewClassName?: string } | undefined;
    if (viewConfig?.uiViewClassName) out.viewClass = viewConfig.uiViewClassName;
  }

  return out;
};

// Pull a "useful" raw value out of a hook's memoizedState by kind. Does NOT
// project — leaves the result raw so the final `applyProjection` sees the
// real value tree (so `path` drill into hook values works). The shape here
// is purely about *which slot field* to expose for each kind (e.g. Ref's
// `.current`, Memo/Callback's first element of `[value, deps]`).
export const serializeHookValue = (raw: unknown, kind: string): unknown => {
  const walk = (v: unknown): unknown => {
    return v;
  };
  switch (kind) {
    case 'Ref': {
      if (!raw || typeof raw !== 'object' || !('current' in (raw as object))) {
        return walk(raw);
      }
      const current = (raw as { current: unknown }).current;
      const componentRef = resolveComponentRef(current);
      if (componentRef) {
        return { current: componentRef };
      }
      return { current: walk(current) };
    }
    case 'Memo':
    case 'Callback':
      if (Array.isArray(raw) && raw.length === 2) {
        return { deps: raw[1], value: walk(raw[0]) };
      }
      return walk(raw);
    case 'Effect':
    case 'LayoutEffect':
    case 'InsertionEffect': {
      // React's hook slot for effects holds { tag, create, destroy, deps, next }.
      // Only `deps` is safe and useful to surface.
      const effect = raw as { deps?: unknown } | null | undefined;
      return effect && typeof effect === 'object' && 'deps' in effect
        ? { deps: effect.deps ?? null }
        : null;
    }
    default:
      return walk(raw);
  }
};
