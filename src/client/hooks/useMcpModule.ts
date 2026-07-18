import { useEffect, useMemo, type DependencyList } from 'react';

import { McpClient } from '@/client/core/McpClient';
import { type McpModule } from '@/client/models/types';

export const useMcpModule = (factory: () => McpModule, deps: DependencyList): void => {
  const client = useMemo(() => {
    return McpClient.getInstance();
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/use-memo
  const module = useMemo(factory, deps);

  useEffect(() => {
    return client.registerModule(module);
  }, [client, module]);
};
