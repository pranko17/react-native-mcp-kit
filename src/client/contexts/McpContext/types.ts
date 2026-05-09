import { type ReactNode } from 'react';

import { type McpModule, type ToolHandler } from '@/client/models/types';
import { type I18nLike } from '@/modules/i18next/types';
import { type NavigationRef } from '@/modules/navigation/types';
import { type QueryClientLike } from '@/modules/reactQuery/types';
import { type NamedStorage } from '@/modules/storage/types';

export interface McpContextValue {
  registerTool: (name: string, tool: ToolHandler) => void;
  unregisterTool: (name: string) => void;
}

export interface McpProviderProps {
  children: ReactNode;
  // Forwarded to McpClient.initialize.
  debug?: boolean;
  // Any of these props, when supplied, causes the corresponding module to be
  // registered automatically. Apps that own the dependency at some deeper
  // level can instead register the module via useMcpModule — both paths are
  // equivalent.
  i18n?: I18nLike;
  modules?: McpModule[];
  navigationRef?: NavigationRef;
  queryClient?: QueryClientLike;
  storages?: NamedStorage[];
}
