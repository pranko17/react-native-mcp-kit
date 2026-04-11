import { type Bridge } from '@/server/bridge';

export interface HostContext {
  bridge: Bridge;
  requestedClientId?: string;
}

export interface HostToolHandler {
  description: string;
  handler: (args: Record<string, unknown>, ctx: HostContext) => unknown | Promise<unknown>;
  inputSchema?: Record<string, unknown>;
  timeout?: number;
}

export interface HostModule {
  name: string;
  tools: Record<string, HostToolHandler>;
  description?: string;
}
