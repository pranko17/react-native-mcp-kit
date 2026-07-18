import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { MODULE_SEPARATOR, type ModuleDescriptor, PACKAGE_NAME } from '@/shared/protocol';

import { type Bridge, type ClientEntry, type DynamicToolEntry } from './bridge';
import { buildHostToolMap, createDispatcher } from './dispatch';
import {
  type BroadcastDispatch,
  buildBroadcastContent,
  formatResult,
  jsonError,
  parseClientIds,
  type ServerContext,
} from './helpers';
import { type HostModule } from './host/types';
import { convertInputSchema, hashInputSchema } from './inputSchemaToZod';
import { BASE_INSTRUCTIONS } from './instructions';
import { registerAssertTool } from './tools/assert';
import { registerWaitUntilTool } from './tools/waitUntil';

// Read the shipped package.json so the MCP handshake reports an accurate
// server version — keeps clients' connection logs in sync with the installed
// package without a parallel constant to maintain. __dirname at runtime is
// dist/server, so the relative walk lands on the package root.
export const PACKAGE_VERSION = ((): string => {
  try {
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();

interface ModuleToolDescriptor {
  description: string;
  inputSchema?: Record<string, unknown>;
}

interface ModuleToolRegistryEntry {
  refCount: number;
  registered: RegisteredTool;
  schemaHash: string;
}

export class McpServerWrapper {
  private mcp: McpServer;
  private moduleTools = new Map<string, ModuleToolRegistryEntry>();
  private hostToolNames: Set<string>;
  private listChangedTimer: ReturnType<typeof setImmediate> | null = null;

  private readonly dispatchTool: ServerContext['dispatchTool'];

  constructor(
    private readonly bridge: Bridge,
    hostModules: HostModule[] = []
  ) {
    const hostToolMap = buildHostToolMap(hostModules);
    this.hostToolNames = new Set(hostToolMap.keys());
    this.dispatchTool = createDispatcher(bridge, hostToolMap);

    this.mcp = new McpServer(
      { name: PACKAGE_NAME, version: PACKAGE_VERSION },
      { instructions: BASE_INSTRUCTIONS }
    );

    // Host tools are static for the server's lifetime — register them once at
    // startup. No refcount: they don't depend on any RN client being
    // connected. `clientId` is still injected (optional) because host handlers
    // use it as a device-resolution hint (host__screenshot, host__launch_app).
    for (const mod of hostModules) {
      for (const [toolName, tool] of Object.entries(mod.tools)) {
        const fullName = `${mod.name}${MODULE_SEPARATOR}${toolName}`;
        this.mcp.registerTool(
          fullName,
          {
            description: tool.description,
            inputSchema: convertInputSchema(tool.inputSchema),
          },
          this.makeToolHandler(fullName)
        );
      }
    }

    const ctx: ServerContext = { bridge, dispatchTool: this.dispatchTool };
    registerWaitUntilTool(this.mcp, ctx);
    registerAssertTool(this.mcp, ctx);

    this.subscribeToBridge();
  }

  async start(): Promise<void> {
    // Give RN clients a short window to connect to the bridge BEFORE the MCP
    // transport opens: the typical "app was already running" case then lands
    // module tools in the very first tools/list, sparing the agent a
    // list_changed round-trip (and covering MCP clients that don't honour the
    // notification at all).
    await this.waitForFirstClient(2000);
    const transport = new StdioServerTransport();
    await this.mcp.connect(transport);
    // Re-broadcast for clients that connected between the wait window closing
    // and the transport opening.
    this.mcp.sendToolListChanged();
  }

  private async waitForFirstClient(timeoutMs: number): Promise<void> {
    if (this.bridge.isAnyClientConnected()) return;
    return new Promise((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.bridge.off('clientAdded', onClient);
        resolve();
      };
      const onClient = (): void => {
        // Tool registrations happen synchronously inside the clientAdded
        // listener installed by subscribeToBridge; resolve on the next
        // macrotask so they land before mcp.connect runs.
        setImmediate(settle);
      };
      const timer = setTimeout(settle, timeoutMs);
      this.bridge.on('clientAdded', onClient);
    });
  }

  private subscribeToBridge(): void {
    this.bridge.on('clientAdded', (client) => {
      this.acquireClientTools(client);
      this.flushToolListChanged();
    });

    this.bridge.on('clientRemoved', (_clientId, modules, dynamics) => {
      this.releaseClientTools(modules, dynamics);
      this.flushToolListChanged();
    });

    this.bridge.on('clientReregistered', (client, prevModules) => {
      // Diff old vs new (module, tool) pairs — release what's gone, acquire
      // what's new, leave the stable intersection untouched.
      const before = new Set<string>();
      for (const mod of prevModules) {
        for (const t of mod.tools) {
          before.add(`${mod.name}${MODULE_SEPARATOR}${t.name}`);
        }
      }
      const after = new Map<string, ModuleToolDescriptor>();
      for (const mod of client.modules) {
        for (const t of mod.tools) {
          after.set(`${mod.name}${MODULE_SEPARATOR}${t.name}`, {
            description: t.description,
            inputSchema: t.inputSchema,
          });
        }
      }
      for (const fullName of before) {
        if (!after.has(fullName)) this.releaseTool(fullName);
      }
      for (const [fullName, descriptor] of after) {
        if (!before.has(fullName)) this.acquireTool(fullName, descriptor);
      }
      this.flushToolListChanged();
    });

    this.bridge.on('dynamicToolAdded', (_client, fullName, entry) => {
      this.acquireTool(fullName, {
        description: entry.description,
        inputSchema: entry.inputSchema,
      });
      this.flushToolListChanged();
    });

    this.bridge.on('dynamicToolRemoved', (_client, fullName) => {
      this.releaseTool(fullName);
      this.flushToolListChanged();
    });

    this.bridge.on('bridgeStopping', () => {
      // Drain — release every still-registered module tool. The connection is
      // on its way down, so the per-remove listChanged storm doesn't matter.
      for (const fullName of [...this.moduleTools.keys()]) {
        const entry = this.moduleTools.get(fullName);
        if (entry) {
          try {
            entry.registered.remove();
          } catch {
            // SDK may throw if already removed — safe to ignore at shutdown.
          }
          this.moduleTools.delete(fullName);
        }
      }
    });
  }

  /**
   * Coalesce tool-list-changed notifications across a batch of acquire/release
   * calls within the same tick. The SDK auto-emits per registerTool/remove;
   * an explicit post-batch broadcast keeps agents that debounce (or drop
   * pre-handshake notifications) in sync with one final signal.
   */
  private flushToolListChanged(): void {
    if (this.listChangedTimer) return;
    this.listChangedTimer = setImmediate(() => {
      this.listChangedTimer = null;
      try {
        this.mcp.sendToolListChanged();
      } catch {
        // Pre-handshake or transport gone — the next event re-broadcasts, and
        // start() re-broadcasts after connect.
      }
    });
  }

  private acquireClientTools(client: ClientEntry): void {
    for (const mod of client.modules) {
      for (const t of mod.tools) {
        this.acquireTool(`${mod.name}${MODULE_SEPARATOR}${t.name}`, {
          description: t.description,
          inputSchema: t.inputSchema,
        });
      }
    }
    for (const [fullName, entry] of client.dynamicTools) {
      this.acquireTool(fullName, {
        description: entry.description,
        inputSchema: entry.inputSchema,
      });
    }
  }

  private releaseClientTools(
    modules: ModuleDescriptor[],
    dynamics: Map<string, DynamicToolEntry>
  ): void {
    for (const mod of modules) {
      for (const t of mod.tools) {
        this.releaseTool(`${mod.name}${MODULE_SEPARATOR}${t.name}`);
      }
    }
    for (const fullName of dynamics.keys()) {
      this.releaseTool(fullName);
    }
  }

  /**
   * Increment refcount or register fresh. Two clients shipping the same tool
   * with matching schema share one MCP-level tool — the handler dispatches to
   * the right client via the optional `clientId` arg. A schema mismatch (e.g.
   * rolling upgrade with version skew) skips the new registration with a
   * warning instead of namespacing.
   */
  private acquireTool(fullName: string, descriptor: ModuleToolDescriptor): void {
    if (this.hostToolNames.has(fullName)) {
      process.stderr.write(
        `[mcp-kit] Module tool "${fullName}" collides with a host tool of the same name — module registration skipped.\n`
      );
      return;
    }
    const schemaHash = hashInputSchema(descriptor.description, descriptor.inputSchema);
    const existing = this.moduleTools.get(fullName);
    if (existing) {
      if (existing.schemaHash === schemaHash) {
        existing.refCount += 1;
        return;
      }
      process.stderr.write(
        `[mcp-kit] Tool "${fullName}" schema differs across clients — keeping the first registration.\n`
      );
      return;
    }
    const registered = this.mcp.registerTool(
      fullName,
      {
        description: descriptor.description,
        inputSchema: convertInputSchema(descriptor.inputSchema),
      },
      this.makeToolHandler(fullName)
    );
    this.moduleTools.set(fullName, { refCount: 1, registered, schemaHash });
  }

  private releaseTool(fullName: string): void {
    const entry = this.moduleTools.get(fullName);
    if (!entry) return;
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      try {
        entry.registered.remove();
      } catch {
        // SDK may throw if already removed — safe to ignore.
      }
      this.moduleTools.delete(fullName);
    }
  }

  /**
   * Per-tool handler for both host and client-module registrations. `clientId`
   * accepts the same forms the legacy `call` meta-tool did — literal string,
   * `/regex/` literal, or array — so single-target and broadcast dispatch both
   * work on every directly-registered tool.
   */
  private makeToolHandler(fullName: string) {
    return async (rawArgs: unknown) => {
      const args = { ...((rawArgs as Record<string, unknown> | undefined) ?? {}) };
      const rawClientId = args.clientId;
      delete args.clientId;

      const clients = parseClientIds(rawClientId, this.bridge);
      if (!clients.ok) return jsonError(clients.error);

      if (clients.mode === 'single') {
        const dispatch = await this.dispatchTool(fullName, args, clients.clientId);
        if (!dispatch.ok) return jsonError(dispatch.error);
        return { content: formatResult(dispatch.result) };
      }

      const results: BroadcastDispatch[] = await Promise.all(
        clients.ids.map(async (id) => {
          const result = await this.dispatchTool(fullName, args, id);
          return { clientId: id, result };
        })
      );
      return { content: buildBroadcastContent(results, formatResult) };
    };
  }
}
