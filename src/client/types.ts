export interface ToolHandler {
  description: string;
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
  inputSchema?: Record<string, unknown>;
}

export interface McpModule {
  name: string;
  tools: Record<string, ToolHandler>;
}

export interface McpContextValue {
  registerTool: (name: string, tool: ToolHandler) => void;
  removeState: (key: string) => void;
  setState: (key: string, value: unknown) => void;
  unregisterTool: (name: string) => void;
}

export interface McpProviderProps {
  children: React.ReactNode;
  modules?: McpModule[];
  port?: number;
}
