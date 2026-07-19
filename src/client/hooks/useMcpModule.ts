import { useEffect, useMemo, type DependencyList } from 'react';

import { McpClient } from '@/client/core/McpClient';
import { type McpModule } from '@/client/models/types';

/**
 * Rules of Hooks forbid calling the hook conditionally, so optional
 * registration goes through the factory instead: pass `null` / `undefined`,
 * or return it from the factory, and nothing registers (a module registered
 * on a previous render is disposed).
 */
export const useMcpModule = (
  factory: (() => McpModule | null | undefined) | null | undefined,
  deps: DependencyList
): void => {
  const client = useMemo(() => {
    return McpClient.getInstance();
  }, []);
  const module = useMemo(() => {
    return factory ? factory() : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/use-memo
  }, deps);

  useEffect(() => {
    if (!module) return;
    return client.registerModule(module);
  }, [client, module]);
};
