import { useContext, useEffect, useMemo, type DependencyList } from 'react';

import { McpContext } from '@/client/contexts/McpContext';
import { type ToolHandler } from '@/client/models/types';

export const useMcpTool = (
  name: string,
  factory: () => ToolHandler,
  deps: DependencyList
): void => {
  const ctx = useContext(McpContext);
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/use-memo
  const tool = useMemo(factory, deps);

  useEffect(() => {
    if (!ctx) return;
    ctx.registerTool(name, tool);
    return () => {
      ctx.unregisterTool(name);
    };
  }, [ctx, name, tool]);
};
