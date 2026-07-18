import { type ZodType } from 'zod';

export interface ToolHandler {
  description: string;
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
  inputSchema?: ZodType;
  timeout?: number;
}

export interface McpModule {
  name: string;
  tools: Record<string, ToolHandler>;
  description?: string;
}
