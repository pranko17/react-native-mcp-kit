import { type Fiber, type SerializedComponent } from '@/modules/fiberTree/types';

import { HOST_TEXT } from './constants';
import { getComponentName, getComponentType } from './naming';

export const getTextContent = (fiber: Fiber): string | undefined => {
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
