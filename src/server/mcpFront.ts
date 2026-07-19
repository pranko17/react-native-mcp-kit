// The low-level `Server` is deprecated only as a default choice ("Only use
// `Server` for advanced use cases") — a passthrough front is that use case:
// tools/list here serves a catalog owned elsewhere (the daemon's registry),
// which the high-level McpServer cannot express — it owns its catalog via
// registerTool. Don't migrate this to McpServer.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { type Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { PACKAGE_NAME } from '@/shared/protocol';
import { type WireCallResult, type WireToolDescriptor } from '@/shared/proxyProtocol';

import { type DaemonCore } from './daemonCore';
import { BASE_INSTRUCTIONS } from './instructions';

/**
 * What an MCP front needs from whoever owns the tool catalog. Implemented by
 * `localBackend` (in-process DaemonCore — daemonless embedding and tests) and
 * by the session proxy's remote backend (WS connection to the shared daemon).
 */
export interface FrontBackend {
  callTool(name: string, args: Record<string, unknown> | undefined): Promise<WireCallResult>;
  listTools(): Promise<WireToolDescriptor[]>;
  /** Subscribe to catalog changes; returns an unsubscribe function. */
  onToolsChanged(listener: () => void): () => void;
}

export const localBackend = (core: DaemonCore): FrontBackend => {
  return {
    callTool: (name, args) => {
      return core.registry.call(name, args);
    },
    listTools: () => {
      return Promise.resolve(core.registry.list());
    },
    onToolsChanged: (listener) => {
      core.registry.on('changed', listener);
      return () => {
        core.registry.off('changed', listener);
      };
    },
  };
};

/**
 * One MCP session endpoint: a low-level SDK Server whose tools/list and
 * tools/call are served from a `FrontBackend`. Catalog changes propagate as
 * `notifications/tools/list_changed`. Validation errors re-raise as MCP
 * InvalidParams protocol errors — the same shape the high-level SDK produced
 * when it owned tool registration.
 */
export class McpFront {
  private server: Server;

  constructor(backend: FrontBackend, version: string) {
    this.server = new Server(
      { name: PACKAGE_NAME, version },
      { capabilities: { tools: { listChanged: true } }, instructions: BASE_INSTRUCTIONS }
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: await backend.listTools() };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const result = await backend.callTool(
        params.name,
        params.arguments as Record<string, unknown> | undefined
      );
      if (result.unknownTool) {
        throw new McpError(ErrorCode.MethodNotFound, result.unknownTool);
      }
      if (result.invalidParams) {
        return {
          content: [{ text: result.invalidParams, type: 'text' as const }],
          isError: true,
        };
      }
      return result.isError
        ? { content: result.content, isError: true }
        : { content: result.content };
    });

    backend.onToolsChanged(() => {
      this.sendToolListChanged();
    });
  }

  sendToolListChanged(): void {
    // The low-level Server returns a promise here (unlike the high-level
    // wrapper) — a closed transport rejects asynchronously, so both the sync
    // throw and the rejection must be swallowed or vitest/node report an
    // unhandled rejection.
    try {
      void Promise.resolve(this.server.sendToolListChanged()).catch(() => {
        // Pre-handshake or transport gone — the next change re-broadcasts.
      });
    } catch {
      // Same, synchronous flavor.
    }
  }

  async connectTransport(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }
}
