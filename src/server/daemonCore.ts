import { MODULE_SEPARATOR, type ModuleDescriptor } from '@/shared/protocol';

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
import { type ToolCallContent, ToolRegistry } from './toolRegistry';
import { assertToolDef } from './tools/assert';
import { waitUntilToolDef } from './tools/waitUntil';

interface ModuleToolDescriptor {
  description: string;
  inputSchema?: Record<string, unknown>;
}

interface ModuleToolRefEntry {
  refCount: number;
  schemaHash: string;
}

/**
 * The server's engine, independent of any MCP transport: owns the tool
 * registry, subscribes to bridge lifecycle events to keep client-module and
 * dynamic tools in sync, and provides the dispatch pipeline every front
 * (in-process stdio, or remote session proxies) serves `tools/call` through.
 *
 * Extracted from the former McpServerWrapper so several MCP sessions can share
 * one engine: fronts consume `registry` (list/call/changed), nothing here
 * knows how many sessions are attached.
 */
export class DaemonCore {
  readonly registry = new ToolRegistry();
  private moduleTools = new Map<string, ModuleToolRefEntry>();
  private hostToolNames: Set<string>;

  private readonly dispatchTool: ServerContext['dispatchTool'];

  constructor(
    private readonly bridge: Bridge,
    hostModules: HostModule[] = []
  ) {
    const hostToolMap = buildHostToolMap(hostModules);
    this.hostToolNames = new Set(hostToolMap.keys());
    this.dispatchTool = createDispatcher(bridge, hostToolMap);

    // Host tools are static for the server's lifetime — register them once at
    // startup. No refcount: they don't depend on any RN client being
    // connected. `clientId` is still injected (optional) because host handlers
    // use it as a device-resolution hint (host__screenshot, host__launch_app).
    for (const mod of hostModules) {
      for (const [toolName, tool] of Object.entries(mod.tools)) {
        const fullName = `${mod.name}${MODULE_SEPARATOR}${toolName}`;
        this.registry.set(fullName, {
          description: tool.description,
          handler: this.makeToolHandler(fullName),
          schema: convertInputSchema(tool.inputSchema),
        });
      }
    }

    const ctx: ServerContext = { bridge, dispatchTool: this.dispatchTool };
    for (const def of [waitUntilToolDef(ctx), assertToolDef(ctx)]) {
      const { name, ...entry } = def;
      this.registry.set(name, entry);
    }

    this.subscribeToBridge();
  }

  /**
   * Resolves once a first RN client has connected (or the timeout passes).
   * Lets the "app was already running" case land module tools in the very
   * first tools/list, sparing the agent a list_changed round-trip.
   */
  async waitForFirstClient(timeoutMs: number): Promise<void> {
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
        // macrotask so they land before the first tools/list is answered.
        setImmediate(settle);
      };
      const timer = setTimeout(settle, timeoutMs);
      this.bridge.on('clientAdded', onClient);
    });
  }

  private subscribeToBridge(): void {
    this.bridge.on('clientAdded', (client) => {
      this.acquireClientTools(client);
    });

    this.bridge.on('clientRemoved', (_clientId, modules, dynamics) => {
      this.releaseClientTools(modules, dynamics);
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
    });

    this.bridge.on('dynamicToolAdded', (_client, fullName, entry) => {
      this.acquireTool(fullName, {
        description: entry.description,
        inputSchema: entry.inputSchema,
      });
    });

    this.bridge.on('dynamicToolRemoved', (_client, fullName) => {
      this.releaseTool(fullName);
    });

    this.bridge.on('bridgeStopping', () => {
      // Drain — release every still-registered module tool. The server is on
      // its way down, so per-remove change events don't matter.
      for (const fullName of [...this.moduleTools.keys()]) {
        this.registry.delete(fullName);
        this.moduleTools.delete(fullName);
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
   * with matching schema share one registry entry — the handler dispatches to
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
    this.registry.set(fullName, {
      description: descriptor.description,
      handler: this.makeToolHandler(fullName),
      schema: convertInputSchema(descriptor.inputSchema),
    });
    this.moduleTools.set(fullName, { refCount: 1, schemaHash });
  }

  private releaseTool(fullName: string): void {
    const entry = this.moduleTools.get(fullName);
    if (!entry) return;
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      this.registry.delete(fullName);
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
    return async (rawArgs: Record<string, unknown>): Promise<ToolCallContent> => {
      const args = { ...rawArgs };
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
