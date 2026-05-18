import { type Fiber } from '@/modules/fiberTree/types';

import { HOST_COMPONENT } from './constants';
import { getComponentName } from './naming';
import { getTextContent } from './serialize';

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
