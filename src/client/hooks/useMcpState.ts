import { useContext, useEffect, useMemo, type DependencyList } from 'react';

import { McpContext } from '../McpContext';

const noop = () => {};

export const useMcpState: (key: string, factory: () => unknown, deps: DependencyList) => void =
  typeof __DEV__ !== 'undefined' && __DEV__
    ? (key: string, factory: () => unknown, deps: DependencyList) => {
        const ctx = useContext(McpContext);
        // eslint-disable-next-line react-hooks/exhaustive-deps
        const value = useMemo(factory, deps);

        useEffect(() => {
          if (!ctx) return;
          ctx.setState(key, value);
          return () => {
            ctx.removeState(key);
          };
        }, [ctx, key, value]);
      }
    : noop;
