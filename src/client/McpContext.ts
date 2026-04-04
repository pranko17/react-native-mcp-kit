import { createContext } from 'react';

import type { McpContextValue } from './types';

export const McpContext = createContext<McpContextValue | null>(null);
