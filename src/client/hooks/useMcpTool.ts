import { useContext, useEffect, useMemo, type DependencyList } from 'react';

import { McpContext } from '@/client/contexts/McpContext';
import { type ToolHandler } from '@/client/models/types';

/**
 * Rules of Hooks forbid calling the hook conditionally, so optional
 * registration goes through the factory instead: pass `null` / `undefined`,
 * or return it from the factory, and nothing registers (a tool registered on
 * a previous render is unregistered).
 */
export const useMcpTool = (
  name: string,
  factory: (() => ToolHandler | null | undefined) | null | undefined,
  deps: DependencyList
): void => {
  const ctx = useContext(McpContext);
  const tool = useMemo(() => {
    return factory ? factory() : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/use-memo
  }, deps);

  useEffect(() => {
    if (!ctx || !tool) return;
    ctx.registerTool(name, tool);
    return () => {
      ctx.unregisterTool(name);
    };
  }, [ctx, name, tool]);
};
