import { type Bridge } from '@/server/bridge';

/**
 * Dispatch another tool (host or client module) by full name. Host tools like
 * tap_fiber use it to chain fiber_tree__query + host__tap without the agent
 * needing a round-trip. Returns raw handler result on success or a reason on
 * failure — the caller decides how to surface it.
 */
export type HostDispatch = (
  tool: string,
  args: Record<string, unknown>,
  clientId?: string
) => Promise<{ ok: true; result: unknown } | { error: string; ok: false }>;

export interface HostContext {
  bridge: Bridge;
  dispatch: HostDispatch;
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
