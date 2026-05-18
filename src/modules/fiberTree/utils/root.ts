import { type Fiber } from '@/modules/fiberTree/types';

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
