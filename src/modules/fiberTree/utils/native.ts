import { type Bounds, type Fiber } from '@/modules/fiberTree/types';
import { getRN } from '@/shared/rn/core';

import { findHostFiber } from './traverse';

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

  const RN = getRN();
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
