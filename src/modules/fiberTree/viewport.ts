/**
 * Viewport helpers used by `query`'s `onlyVisible` filter. Read window
 * dimensions via RN's Dimensions / PixelRatio and check whether a
 * fiber's measured bounds intersect the visible rectangle. Both work in
 * physical pixels so they line up with `host__tap` / fiber `bounds`.
 */

import { loadRN } from '@/shared/rn/core';

import { type Bounds } from './types';

/**
 * Window dimensions → physical-pixel `{ width, height }` rectangle. Returns
 * null when RN isn't available (SDK / server tooling) or when Dimensions
 * surfaces an unusable value. Wraps every step in defensive checks because
 * `Dimensions.get('window')` can throw on cold-start before the native
 * module is ready.
 */
export const getVisibleRect = (): { height: number; width: number } | null => {
  const RN = loadRN();
  if (!RN) return null;
  try {
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

/**
 * AABB intersection check — a fiber's `bounds` overlaps the visible rect
 * when its left edge is before the rect's right edge AND its bottom edge
 * is below the rect's top edge (and vice versa).
 */
export const intersectsRect = (
  bounds: Bounds,
  rect: { height: number; width: number }
): boolean => {
  return (
    bounds.x + bounds.width > 0 &&
    bounds.y + bounds.height > 0 &&
    bounds.x < rect.width &&
    bounds.y < rect.height
  );
};
