import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { DYNAMIC_PREFIX, MODULE_SEPARATOR, type ModuleDescriptor } from '@/shared/protocol';

import { type Bridge, type ClientEntry, type DynamicToolEntry } from './bridge';
import { type HostModule, type HostToolHandler } from './host/types';
import { convertInputSchema, hashInputSchema } from './inputSchemaToZod';

// Read the shipped package.json so the MCP handshake reports an accurate
// server version — keeps clients' connection logs in sync with the installed
// package without a parallel constant to maintain. __dirname at runtime is
// dist/server, so the relative walk lands on the package root.
const PACKAGE_VERSION = ((): string => {
  try {
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();

const BASE_INSTRUCTIONS = `You are connected to one or more React Native apps via the react-native-mcp-kit bridge.

EVERY TOOL IS TOP-LEVEL
  Module tools shipped by the app (\`fiber_tree__query\`, \`network__get_pending\`, \`navigation__navigate\`, ...), dynamic tools registered via \`useMcpTool\`, and host tools (\`host__screenshot\`, \`host__tap\`, \`metro__reload\`, \`host__connection_status\`, ...) are all registered as first-class top-level MCP tools. Invoke them directly by name with their full schema visible in your catalog — no proxy layer.

MULTI-CLIENT ROUTING
  Every tool accepts an optional \`clientId\` arg (e.g. \`"ios-1"\`, \`"android-1"\`). With a single client connected the field can be omitted — it auto-picks. With more than one connected, omitting it returns an error listing the available IDs. Use \`host__connection_status\` to discover them along with platform/label/app metadata.

CATALOG REFRESH
  The tool catalog updates when RN clients connect / disconnect or when components mount / unmount \`useMcpTool\` calls — the server emits \`notifications/tools/list_changed\`. Most MCP clients respect this; if the catalog feels stale after the app reloads, restart the session.

DRIVING THE UI
  1. \`host${MODULE_SEPARATOR}tap_fiber\` with \`steps: [...]\` — canonical user-tap simulator. One call locates the fiber and taps its center through the real OS gesture pipeline so Pressable feedback, gesture responders, and hit-test all run.
  2. \`fiber_tree${MODULE_SEPARATOR}query\` with \`select: ["mcpId","name","bounds"]\` + \`host${MODULE_SEPARATOR}tap\` — when you want to inspect bounds before committing.
  3. \`fiber_tree${MODULE_SEPARATOR}invoke\` — non-gesture callbacks where the gesture pipeline is unwanted (off-screen, virtualised, callback isolation).
  4. \`host${MODULE_SEPARATOR}screenshot\` + manual coordinates + \`host${MODULE_SEPARATOR}tap\` — only for non-React surfaces (system permission dialogs, native alerts, the on-screen keyboard, WebView).

POLLING / WAITING
  \`fiber_tree${MODULE_SEPARATOR}query\` accepts \`waitFor: { until: "appear" | "disappear", timeout?, interval?, stable? }\` for UI-state waits. Generic per-tool polling is not a server primitive — modules expose \`waitFor\` themselves where it makes sense.

STACK TRACES
  \`errors${MODULE_SEPARATOR}get_errors\` and \`log_box${MODULE_SEPARATOR}get_logs\` return parsed \`stackFrames\` you can pass straight into \`metro${MODULE_SEPARATOR}symbolicate\` to resolve bundled frames back to source paths via Metro.

COMPONENT-LOCAL STATE
  \`fiber_tree${MODULE_SEPARATOR}query\` with \`select: ["hooks"]\` reads a component's hook list — useState / useMemo / useRef / useEffect / custom hooks — with variable names recovered from source. Each entry carries \`{ kind, name, hook?, via?, expanded? }\`; pass \`hooksInclude: { withValues: true }\` for resolved values, \`format: "tree"\` for nested children, \`expansionDepth: N\` to cap recursion. Sensitive names (password, token, jwt, secret, credential, apiKey, authorization, Pin suffix) are auto-redacted; configure via \`fiberTreeModule({ redactHookNames, additionalRedactHookNames })\`.

HOST GESTURE BACKENDS
  iOS input (tap / swipe / type_text / press_key) goes through a bundled ios-hid binary — HID injection into iOS Simulator via SimulatorKit. Android input / screenshots go through adb. All (x, y) coordinates are PHYSICAL pixels, top-left origin — they match \`fiber_tree\` bounds.centerX/centerY directly.
`;

type TextContent = { text: string; type: 'text' };

interface HostToolEntry {
  handler: HostToolHandler['handler'];
  moduleName: string;
  toolName: string;
  timeout?: number;
}

interface ModuleToolDescriptor {
  description: string;
  inputSchema?: Record<string, unknown>;
}

interface ModuleToolRegistryEntry {
  refCount: number;
  registered: RegisteredTool;
  schemaHash: string;
}

const jsonError = (msg: string): { content: TextContent[] } => {
  return {
    content: [{ text: JSON.stringify({ error: msg }), type: 'text' as const }],
  };
};

export class McpServerWrapper {
  private hostModules: HostModule[];
  private hostToolMap = new Map<string, HostToolEntry>();
  private mcp: McpServer;
  private moduleTools = new Map<string, ModuleToolRegistryEntry>();

  constructor(
    private readonly bridge: Bridge,
    hostModules: HostModule[] = []
  ) {
    this.hostModules = hostModules;
    for (const mod of hostModules) {
      for (const [toolName, tool] of Object.entries(mod.tools)) {
        const fullName = `${mod.name}${MODULE_SEPARATOR}${toolName}`;
        this.hostToolMap.set(fullName, {
          handler: tool.handler,
          moduleName: mod.name,
          timeout: tool.timeout,
          toolName,
        });
      }
    }

    this.mcp = new McpServer(
      { name: 'react-native-mcp-kit', version: PACKAGE_VERSION },
      { instructions: BASE_INSTRUCTIONS }
    );

    this.registerHostTools();
    this.subscribeToBridge();
  }

  async start(): Promise<void> {
    // Give RN clients a short window to connect to the bridge BEFORE we
    // initialize the MCP transport. Some MCP agents (notably Claude Code) only
    // populate their tool catalog from the initial `tools/list` response and
    // ignore `notifications/tools/list_changed` afterwards — so any module
    // tools registered after the handshake never reach the agent. Waiting for
    // the first client (with a short cap so a fresh boot without an app still
    // exposes host tools quickly) lets the typical "app was already running"
    // case put module tools into the very first tools/list.
    await this.waitForFirstClient(2000);
    const transport = new StdioServerTransport();
    await this.mcp.connect(transport);
    // Belt-and-suspenders re-broadcast for clients that connect after the
    // transport opens — agents that DO honour list_changed will pick them up.
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
        // Tool list is registered synchronously inside the clientAdded
        // listener earlier in the chain; resolve on the next microtask so
        // those registrations land before mcp.connect runs.
        setImmediate(settle);
      };
      const timer = setTimeout(settle, timeoutMs);
      this.bridge.on('clientAdded', onClient);
    });
  }

  /**
   * Host tools are static for the server's lifetime — register them once at
   * startup. No refcount: they don't depend on any RN client being connected.
   * `clientId` is still injected (optional) because some host handlers use it
   * as a device-resolution hint (`host__screenshot`, `host__launch_app`).
   */
  private registerHostTools(): void {
    for (const mod of this.hostModules) {
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
      // Diff old vs new (moduleName, toolName) pairs.
      const before = new Set<string>();
      for (const mod of prevModules) {
        for (const t of mod.tools) {
          before.add(`${mod.name}${MODULE_SEPARATOR}${t.name}`);
        }
      }
      const after = new Set<string>();
      const afterDescriptors = new Map<string, ModuleToolDescriptor>();
      for (const mod of client.modules) {
        for (const t of mod.tools) {
          const fullName = `${mod.name}${MODULE_SEPARATOR}${t.name}`;
          after.add(fullName);
          afterDescriptors.set(fullName, {
            description: t.description,
            inputSchema: t.inputSchema,
          });
        }
      }
      for (const fullName of before) {
        if (!after.has(fullName)) this.releaseTool(fullName);
      }
      for (const fullName of after) {
        if (!before.has(fullName)) {
          const descriptor = afterDescriptors.get(fullName);
          if (descriptor) this.acquireTool(fullName, descriptor);
        }
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
      // Drain — release every still-registered module tool. SDK auto-emits
      // notifications/tools/list_changed for each, but the connection is on
      // its way down anyway so the listChanged storm doesn't matter.
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
   * calls within the same tick. SDK already auto-emits per registerTool/remove,
   * but in practice the agent (Claude Code) doesn't always pick those up — an
   * explicit broadcast after the batch is the reliable way to make it re-fetch
   * `tools/list`.
   */
  private listChangedTimer: ReturnType<typeof setImmediate> | null = null;
  private flushToolListChanged(): void {
    if (this.listChangedTimer) return;
    this.listChangedTimer = setImmediate(() => {
      this.listChangedTimer = null;
      try {
        this.mcp.sendToolListChanged();
      } catch {
        // Pre-handshake or transport gone — safe to ignore; the next event
        // will re-broadcast, and `start()` re-broadcasts after connect.
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
   * with matching schema share one MCP-level tool — handler dispatches to the
   * right client via the optional `clientId` arg. A schema mismatch (e.g.
   * rolling upgrade with version skew) skips the new registration with a
   * warning instead of namespacing.
   */
  private acquireTool(fullName: string, descriptor: ModuleToolDescriptor): void {
    if (this.hostToolMap.has(fullName)) {
      console.warn(
        `[mcp-kit] Module tool "${fullName}" collides with a host tool of the same name — module registration skipped.`
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
      console.warn(
        `[mcp-kit] Tool "${fullName}" schema differs across clients — keeping the first registration. Existing: ${existing.schemaHash}; new: ${schemaHash}.`
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
   * Builds the per-tool handler used by both host and client-module
   * registrations. Every tool exposes an optional `clientId` arg; the rest of
   * `rawArgs` flows straight into `dispatchTool`, which already handles
   * auto-pick, host vs client routing, dynamic-prefix fallback, and error
   * formatting.
   */
  private makeToolHandler(fullName: string) {
    return async (rawArgs: Record<string, unknown> | undefined) => {
      const args = { ...(rawArgs ?? {}) };
      const clientId = typeof args.clientId === 'string' ? args.clientId : undefined;
      delete args.clientId;
      const dispatch = await this.dispatchTool(fullName, args, clientId);
      if (!dispatch.ok) return jsonError(dispatch.error);
      return { content: this.formatResult(dispatch.result) };
    };
  }

  /**
   * Execute a single tool by full name, returning the raw handler result.
   * Used by every registered MCP tool's handler — host tools, client module
   * tools, and `useMcpTool`-driven dynamic tools all funnel through here.
   */
  private async dispatchTool(
    tool: string,
    args: Record<string, unknown>,
    clientId?: string
  ): Promise<{ ok: true; result: unknown } | { error: string; ok: false }> {
    const hostEntry = this.hostToolMap.get(tool);
    if (hostEntry) {
      try {
        const result = await hostEntry.handler(args, {
          bridge: this.bridge,
          dispatch: (nextTool, nextArgs, nextClientId) => {
            return this.dispatchTool(nextTool, nextArgs, nextClientId ?? clientId);
          },
          requestedClientId: clientId,
        });
        return { ok: true, result };
      } catch (err) {
        return { error: `Host tool "${tool}" threw: ${(err as Error).message}`, ok: false };
      }
    }

    const resolution = this.bridge.resolveClient(clientId);
    if (!resolution.ok) return { error: resolution.error, ok: false };
    const client = resolution.client;

    let mod: ModuleDescriptor | undefined;
    let moduleName = '';
    let methodName = '';
    for (const m of client.modules) {
      const prefix = `${m.name}${MODULE_SEPARATOR}`;
      if (tool.startsWith(prefix)) {
        mod = m;
        moduleName = m.name;
        methodName = tool.slice(prefix.length);
        break;
      }
    }

    if (!mod) {
      if (tool.startsWith(DYNAMIC_PREFIX)) {
        moduleName = `${MODULE_SEPARATOR}dynamic`;
        methodName = tool.slice(DYNAMIC_PREFIX.length);
      } else {
        const idx = tool.indexOf(MODULE_SEPARATOR);
        if (idx <= 0) {
          return {
            error: `Invalid tool name "${tool}". Use "module${MODULE_SEPARATOR}method" format.`,
            ok: false,
          };
        }
        moduleName = tool.slice(0, idx);
        methodName = tool.slice(idx + MODULE_SEPARATOR.length);
      }
      try {
        const result = await this.bridge.call(client.id, moduleName, methodName, args);
        return { ok: true, result };
      } catch {
        const allModules = client.modules
          .map((m) => {
            return m.name;
          })
          .join(', ');
        const dynNames = [...client.dynamicTools.keys()].join(', ');
        return {
          error: `Tool "${tool}" not found on client '${client.id}'. Modules: ${allModules || '(none)'}. Dynamic: ${dynNames || '(none)'}`,
          ok: false,
        };
      }
    }

    const toolDef = mod.tools.find((t) => {
      return t.name === methodName;
    });
    if (!toolDef) {
      return {
        error: `Tool "${methodName}" not found in module "${moduleName}" on client '${client.id}'. Available: ${mod.tools
          .map((t) => {
            return t.name;
          })
          .join(', ')}`,
        ok: false,
      };
    }

    try {
      const result = await this.bridge.call(
        client.id,
        moduleName,
        methodName,
        args,
        toolDef.timeout
      );
      return { ok: true, result };
    } catch (err) {
      return { error: (err as Error).message, ok: false };
    }
  }

  private formatResult(result: unknown) {
    if (Array.isArray(result) && result.length > 0) {
      const first = result[0];
      if (
        typeof first === 'object' &&
        first !== null &&
        'type' in first &&
        first.type === 'image'
      ) {
        return result as Array<
          { data: string; mimeType: string; type: 'image' } | { text: string; type: 'text' }
        >;
      }
    }

    return [{ text: JSON.stringify(result, null, 2), type: 'text' as const }];
  }
}
