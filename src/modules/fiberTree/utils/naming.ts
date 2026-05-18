import { type ComponentType, type Fiber } from '@/modules/fiberTree/types';

import {
  CLASS_COMPONENT,
  FORWARD_REF,
  FUNCTION_COMPONENT,
  HOST_COMPONENT,
  HOST_TEXT,
  MEMO,
  SIMPLE_MEMO,
} from './constants';

export const getComponentName = (fiber: Fiber): string => {
  // Host root has no `type` and no `return` parent. Surface it as
  // "FiberRoot" instead of "Unknown" so dumps via scope:'root' read
  // sensibly (and the name doesn't collide with a real component).
  if (!fiber.type) {
    if (!fiber.return) return 'FiberRoot';
    return 'Unknown';
  }

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

export const getComponentType = (fiber: Fiber): ComponentType => {
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
