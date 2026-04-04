import { useContext, useEffect, useMemo, type DependencyList } from 'react';

import { McpContext } from '../McpContext';
import type { ToolHandler } from '../types';

const noop = () => {};

export const useMcpTool: (name: string, factory: () => ToolHandler, deps: DependencyList) => void =
  typeof __DEV__ !== 'undefined' && __DEV__
    ? (name: string, factory: () => ToolHandler, deps: DependencyList) => {
        const ctx = useContext(McpContext);
        // eslint-disable-next-line react-hooks/exhaustive-deps
        const tool = useMemo(factory, deps);

        useEffect(() => {
          if (!ctx) return;
          ctx.registerTool(name, tool);
          return () => {
            ctx.unregisterTool(name);
          };
        }, [ctx, name, tool]);
      }
    : noop;
