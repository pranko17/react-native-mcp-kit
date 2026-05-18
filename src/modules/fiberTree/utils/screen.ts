import { type Fiber } from '@/modules/fiberTree/types';

import { getComponentName } from './naming';
import { findAllFibers } from './traverse';

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
