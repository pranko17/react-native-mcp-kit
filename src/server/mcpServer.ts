import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { DYNAMIC_PREFIX, MODULE_SEPARATOR, type ModuleDescriptor } from '@/shared/protocol';

import { type Bridge, type ClientEntry } from './bridge';
import { type HostModule, type HostToolHandler } from './host/types';

const BASE_INSTRUCTIONS = `You are connected to a running React Native app via the react-native-mcp-kit bridge.

Multiple React Native apps can connect simultaneously — each is identified by a short ID like "ios-1", "android-1", or "client-1". Use \`connection_status\` or \`list_tools\` to see which clients are connected and their IDs, platforms, and labels.

## How to interact

1. Use \`connection_status\` to check which clients are connected.
2. Use \`list_tools\` to browse all available tool names and short descriptions. The response is compact — modules that are structurally identical across multiple clients are deduplicated into a single entry with a \`clientIds\` array, and input schemas are omitted.
3. Use \`describe_tool\` with \`{ tool, clientId? }\` to fetch the full input schema of a specific tool before calling it. Required when you need to know the argument shape. Host tools are resolved directly (no clientId needed). For in-app tools, omit \`clientId\` to auto-pick; specify it only when multiple clients have the same tool with different schemas.
4. Use \`call\` to invoke any tool with format: module${MODULE_SEPARATOR}method (e.g. navigation${MODULE_SEPARATOR}navigate). When more than one client is connected, specify \`clientId\`. When exactly one client is connected, \`clientId\` is optional — it's auto-picked.
5. Use \`state_list\` / \`state_get\` to read app state exposed via useMcpState. State is scoped per client; specify \`clientId\` when multiple clients are connected.

Some tools run inline on the MCP server host (e.g. \`host${MODULE_SEPARATOR}screenshot\`, \`host${MODULE_SEPARATOR}list_devices\`, \`host${MODULE_SEPARATOR}launch_app\`, \`host${MODULE_SEPARATOR}terminate_app\`, \`host${MODULE_SEPARATOR}restart_app\`) and work even when no React Native client is connected. They use xcrun simctl / adb on the dev machine. When \`clientId\` is provided, host tools use that client's platform/label/deviceId as hints to resolve the target device; otherwise they prefer the device of the single connected client, falling back to the single booted sim / online device. \`launch_app\`, \`terminate_app\`, and \`restart_app\` accept an \`appId\` arg (iOS bundle ID / Android package name); omit it to reuse the target client's registered \`bundleId\` from its connection metadata.

## Driving the UI — pick the right tool
1. **\`fiber_tree${MODULE_SEPARATOR}find_all\` with \`select: ["mcpId", "name", "bounds"]\` + \`host${MODULE_SEPARATOR}tap\` with \`bounds.centerX\`/\`bounds.centerY\`** — the default for touch interactions. Exercises the real OS gesture pipeline, so Pressable/TouchableOpacity feedback, gesture responders, and hit-test logic all run. The bounds come back in physical pixels — pass them straight to \`host${MODULE_SEPARATOR}tap\`, no scaling. The \`select\` parameter also saves tokens by omitting heavy \`props\` from the response.
2. **\`fiber_tree${MODULE_SEPARATOR}invoke\`** when you need to bypass the gesture pipeline — e.g. for non-tap callbacks like \`onChangeText\` / \`onValueChange\` / \`onRefresh\`, or when a component is inside a scroll/gesture-handler parent that swallows taps. Calls the prop directly — faster and immune to overlay/occlusion, but does not exercise touch handlers.
3. **\`host${MODULE_SEPARATOR}screenshot\` + manual coordinate estimation + \`host${MODULE_SEPARATOR}tap\`** ONLY for non-React surfaces: system permission dialogs, native alerts, the on-screen keyboard, WebView content, native splash. These have no fiber and no bounds.

\`host${MODULE_SEPARATOR}tap\` / \`host${MODULE_SEPARATOR}swipe\` / \`host${MODULE_SEPARATOR}type_text\` / \`host${MODULE_SEPARATOR}press_key\` work on both platforms with no external daemons: Android via \`adb shell input\`, iOS via a bundled \`ios-hid\` binary that injects HID events directly into iOS Simulator through SimulatorKit.
`;

type TextContent = { text: string; type: 'text' };

interface ToolGroup {
  description: string | undefined;
  module: string;
  tools: Array<{
    description: string;
    name: string;
    inputSchema?: Record<string, unknown>;
  }>;
}

const jsonError = (msg: string): { content: TextContent[] } => {
  return {
    content: [{ text: JSON.stringify({ error: msg }), type: 'text' as const }],
  };
};

interface HostToolEntry {
  handler: HostToolHandler['handler'];
  moduleName: string;
  toolName: string;
  timeout?: number;
}

interface ToolDescriptorShape {
  description: string;
  name: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Recursively serializes a value to JSON with sorted object keys, producing a
 * stable canonical form that's safe to use as a dedup Map key. Arrays keep
 * their original order — caller is responsible for normalizing them when
 * order-independence is desired.
 */
const canonicalize = (value: unknown): string => {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
};

/**
 * Produces a canonical key for a ToolGroup that's independent of tool
 * registration order. Two modules with the same name + tools (regardless of
 * order) + descriptions + schemas produce the same key.
 */
const canonicalizeGroup = (group: ToolGroup): string => {
  const normalized = {
    description: group.description,
    module: group.module,
    tools: [...group.tools].sort((a, b) => {
      return a.name.localeCompare(b.name);
    }),
  };
  return canonicalize(normalized);
};

/**
 * Looks up a full tool descriptor on a client by its full name
 * (`module__method`). Checks both static modules and dynamic tools registered
 * via useMcpTool. Returns null if the tool is not on this client.
 */
const findToolInClient = (
  client: ClientEntry,
  toolFullName: string
): ToolDescriptorShape | null => {
  for (const mod of client.modules) {
    const prefix = `${mod.name}${MODULE_SEPARATOR}`;
    if (toolFullName.startsWith(prefix)) {
      const methodName = toolFullName.slice(prefix.length);
      const toolDef = mod.tools.find((t) => {
        return t.name === methodName;
      });
      if (toolDef) {
        return {
          description: toolDef.description,
          inputSchema: toolDef.inputSchema,
          name: toolFullName,
        };
      }
    }
  }

  const dynamicEntry = client.dynamicTools.get(toolFullName);
  if (dynamicEntry) {
    return {
      description: dynamicEntry.description,
      inputSchema: dynamicEntry.inputSchema,
      name: toolFullName,
    };
  }

  return null;
};

export class McpServerWrapper {
  private hostModules: HostModule[];
  private hostToolMap = new Map<string, HostToolEntry>();
  private mcp: McpServer;

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
      { name: 'react-native-mcp-kit', version: '1.0.0' },
      { instructions: BASE_INSTRUCTIONS }
    );

    this.registerTools();
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.mcp.connect(transport);
  }

  private registerTools(): void {
    this.mcp.registerTool(
      'call',
      {
        annotations: {
          openWorldHint: true,
          title: 'Call Tool',
        },
        description:
          'Call a tool registered by a React Native app client. Use list_tools first to see available tools. When multiple clients are connected, specify clientId; otherwise it is auto-picked.',
        inputSchema: {
          args: z
            .string()
            .optional()
            .describe('Arguments as JSON string (e.g. {"screen": "AUTH_LOGIN_SCREEN"})'),
          clientId: z
            .string()
            .optional()
            .describe(
              'Target client ID (e.g. "ios-1", "android-1"). Optional when exactly one client is connected.'
            ),
          tool: z
            .string()
            .describe(
              `Tool name in format "module${MODULE_SEPARATOR}method" (e.g. "navigation${MODULE_SEPARATOR}navigate")`
            ),
        },
      },
      async ({ args, clientId, tool }) => {
        let parsedArgs: Record<string, unknown> = {};
        if (args) {
          try {
            parsedArgs = JSON.parse(args) as Record<string, unknown>;
          } catch {
            return jsonError('Invalid JSON in args');
          }
        }

        // Host dispatch — runs inline on the Node server, may work without any connected client
        const hostEntry = this.hostToolMap.get(tool);
        if (hostEntry) {
          try {
            const result = await hostEntry.handler(parsedArgs, {
              bridge: this.bridge,
              requestedClientId: clientId,
            });
            return { content: this.formatResult(result) };
          } catch (err) {
            return jsonError(`Host tool "${tool}" threw: ${(err as Error).message}`);
          }
        }

        const resolution = this.bridge.resolveClient(clientId);
        if (!resolution.ok) {
          return jsonError(resolution.error);
        }
        const client = resolution.client;

        // Find the module by matching prefix in this client's modules
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

        // If no module matched, check for dynamic tool prefix or generic module__method
        if (!mod) {
          if (tool.startsWith(DYNAMIC_PREFIX)) {
            moduleName = `${MODULE_SEPARATOR}dynamic`;
            methodName = tool.slice(DYNAMIC_PREFIX.length);
          } else {
            const idx = tool.indexOf(MODULE_SEPARATOR);
            if (idx <= 0) {
              return jsonError(
                `Invalid tool name "${tool}". Use "module${MODULE_SEPARATOR}method" format.`
              );
            }
            moduleName = tool.slice(0, idx);
            methodName = tool.slice(idx + MODULE_SEPARATOR.length);
          }

          // Try dispatching via bridge — might be a dynamic tool registered on this client
          try {
            const result = await this.bridge.call(client.id, moduleName, methodName, parsedArgs);
            return { content: this.formatResult(result) };
          } catch {
            const allModules = client.modules
              .map((m) => {
                return m.name;
              })
              .join(', ');
            const dynNames = [...client.dynamicTools.keys()].join(', ');
            return jsonError(
              `Tool "${tool}" not found on client '${client.id}'. Modules: ${allModules || '(none)'}. Dynamic: ${dynNames || '(none)'}`
            );
          }
        }

        const toolDef = mod.tools.find((t) => {
          return t.name === methodName;
        });
        if (!toolDef) {
          return jsonError(
            `Tool "${methodName}" not found in module "${moduleName}" on client '${client.id}'. Available: ${mod.tools
              .map((t) => {
                return t.name;
              })
              .join(', ')}`
          );
        }

        const result = await this.bridge.call(
          client.id,
          moduleName,
          methodName,
          parsedArgs,
          toolDef.timeout
        );
        return { content: this.formatResult(result) };
      }
    );

    this.mcp.registerTool(
      'list_tools',
      {
        annotations: {
          readOnlyHint: true,
          title: 'List Tools',
        },
        description:
          'Browse available tools with compact (schema-free) descriptions. Modules with identical shape across multiple clients are deduplicated into a single entry with a clientIds array. Use describe_tool to fetch the full input schema for a specific tool before calling it.',
      },
      async () => {
        const clients = this.bridge.listClients();

        // Dedup tool groups across clients by canonical shape
        const dedupMap = new Map<string, { clientIds: string[]; group: ToolGroup }>();
        for (const client of clients) {
          const groups = this.buildToolGroups(client);
          for (const group of groups) {
            const key = canonicalizeGroup(group);
            const existing = dedupMap.get(key);
            if (existing) {
              existing.clientIds.push(client.id);
            } else {
              dedupMap.set(key, { clientIds: [client.id], group });
            }
          }
        }

        const modulesPayload = [...dedupMap.values()].map(({ clientIds, group }) => {
          return {
            clientIds,
            description: group.description,
            name: group.module,
            tools: group.tools.map((t) => {
              return {
                description: t.description,
                name: t.name,
              };
            }),
          };
        });

        const hostToolsPayload = this.hostModules.map((mod) => {
          return {
            description: mod.description,
            name: mod.name,
            tools: Object.entries(mod.tools).map(([toolName, tool]) => {
              return {
                description: tool.description,
                name: `${mod.name}${MODULE_SEPARATOR}${toolName}`,
              };
            }),
          };
        });

        const clientsPayload = clients.map((client) => {
          return {
            appName: client.appName,
            appVersion: client.appVersion,
            bundleId: client.bundleId,
            deviceId: client.deviceId,
            id: client.id,
            label: client.label,
            platform: client.platform,
          };
        });

        const payload: {
          clientCount: number;
          clients: typeof clientsPayload;
          hostTools: typeof hostToolsPayload;
          modules: typeof modulesPayload;
          clientError?: string;
        } = {
          clientCount: clients.length,
          clients: clientsPayload,
          hostTools: hostToolsPayload,
          modules: modulesPayload,
        };

        if (clients.length === 0) {
          payload.clientError = 'No React Native clients connected';
        }

        return {
          content: [{ text: JSON.stringify(payload, null, 2), type: 'text' as const }],
        };
      }
    );

    this.mcp.registerTool(
      'connection_status',
      {
        annotations: {
          readOnlyHint: true,
          title: 'Connection Status',
        },
        description:
          'List connected React Native clients with their IDs, platforms, labels, and registered module names.',
      },
      async () => {
        const clients = this.bridge.listClients();
        const payload = {
          clientCount: clients.length,
          clients: clients.map((c) => {
            return {
              appName: c.appName,
              appVersion: c.appVersion,
              bundleId: c.bundleId,
              connectedAt: new Date(c.connectedAt).toISOString(),
              deviceId: c.deviceId,
              id: c.id,
              label: c.label,
              modules: c.modules.map((m) => {
                return m.name;
              }),
              platform: c.platform,
            };
          }),
          hostModules: this.hostModules.map((m) => {
            return m.name;
          }),
        };
        return {
          content: [{ text: JSON.stringify(payload, null, 2), type: 'text' as const }],
        };
      }
    );

    this.mcp.registerTool(
      'state_get',
      {
        annotations: {
          readOnlyHint: true,
          title: 'Get State',
        },
        description:
          'Read a state value exposed by a React Native client via useMcpState. State is scoped per client; specify clientId when multiple clients are connected.',
        inputSchema: {
          clientId: z
            .string()
            .optional()
            .describe('Target client ID. Optional when exactly one client is connected.'),
          key: z.string().describe('State key to read (e.g. "cart", "auth")'),
        },
      },
      async ({ clientId, key }) => {
        const resolution = this.bridge.resolveClient(clientId);
        if (!resolution.ok) {
          return jsonError(resolution.error);
        }
        const value = resolution.client.stateStore.get(key);
        if (value === undefined) {
          return jsonError(
            `State "${key}" not found on client '${resolution.client.id}'. Use state_list to see available keys.`
          );
        }
        return {
          content: [{ text: JSON.stringify(value, null, 2), type: 'text' as const }],
        };
      }
    );

    this.mcp.registerTool(
      'state_list',
      {
        annotations: {
          readOnlyHint: true,
          title: 'List State',
        },
        description:
          "List all available state keys. When a specific clientId is given, returns that client's keys; otherwise auto-picks the sole connected client or groups by client when multiple are connected.",
        inputSchema: {
          clientId: z
            .string()
            .optional()
            .describe('Target client ID. Optional when exactly one client is connected.'),
        },
      },
      async ({ clientId }) => {
        if (clientId) {
          const resolution = this.bridge.resolveClient(clientId);
          if (!resolution.ok) {
            return jsonError(resolution.error);
          }
          return {
            content: [
              {
                text: JSON.stringify(
                  {
                    clientId: resolution.client.id,
                    keys: [...resolution.client.stateStore.keys()],
                  },
                  null,
                  2
                ),
                type: 'text' as const,
              },
            ],
          };
        }

        const clients = this.bridge.listClients();
        if (clients.length === 0) {
          return jsonError('No React Native clients connected');
        }
        if (clients.length === 1) {
          const client = clients[0]!;
          return {
            content: [
              {
                text: JSON.stringify(
                  { clientId: client.id, keys: [...client.stateStore.keys()] },
                  null,
                  2
                ),
                type: 'text' as const,
              },
            ],
          };
        }
        return {
          content: [
            {
              text: JSON.stringify(
                {
                  clients: clients.map((c) => {
                    return { id: c.id, keys: [...c.stateStore.keys()] };
                  }),
                },
                null,
                2
              ),
              type: 'text' as const,
            },
          ],
        };
      }
    );

    this.mcp.registerTool(
      'describe_tool',
      {
        annotations: {
          readOnlyHint: true,
          title: 'Describe Tool',
        },
        description:
          'Fetch the full description and input schema for a single tool. Use this after list_tools to learn how to construct arguments for a tool before calling it. For host tools, clientId is ignored. For in-app tools, omit clientId to auto-pick the shared descriptor; specify it only when multiple clients have the same tool with different schemas.',
        inputSchema: {
          clientId: z
            .string()
            .optional()
            .describe(
              'Target client ID for in-app tools. Required only when multiple clients have the same tool with different schemas. Ignored for host tools.'
            ),
          tool: z
            .string()
            .describe(
              `Full tool name in the format "module${MODULE_SEPARATOR}method" (e.g. "navigation${MODULE_SEPARATOR}navigate", "host${MODULE_SEPARATOR}screenshot").`
            ),
        },
      },
      async ({ clientId, tool }) => {
        // 1. Host tool path — resolved via hostToolMap, clientId is ignored
        const hostEntry = this.hostToolMap.get(tool);
        if (hostEntry) {
          const mod = this.hostModules.find((m) => {
            return m.name === hostEntry.moduleName;
          });
          const hostTool = mod?.tools[hostEntry.toolName];
          if (!hostTool) {
            return jsonError(
              `Host tool '${tool}' metadata inconsistent — entry in hostToolMap but missing from hostModules.`
            );
          }
          return {
            content: [
              {
                text: JSON.stringify(
                  {
                    description: hostTool.description,
                    inputSchema: hostTool.inputSchema,
                    name: tool,
                    scope: 'host',
                  },
                  null,
                  2
                ),
                type: 'text' as const,
              },
            ],
          };
        }

        // 2. Explicit clientId — look up the specific client
        if (clientId) {
          const client = this.bridge.getClient(clientId);
          if (!client) {
            const available =
              this.bridge
                .listClients()
                .map((c) => {
                  return c.id;
                })
                .join(', ') || '(none)';
            return jsonError(`Client '${clientId}' not connected. Available: ${available}`);
          }
          const found = findToolInClient(client, tool);
          if (!found) {
            return jsonError(`Tool '${tool}' not found on client '${clientId}'.`);
          }
          return {
            content: [
              {
                text: JSON.stringify(
                  {
                    clientIds: [clientId],
                    description: found.description,
                    inputSchema: found.inputSchema,
                    name: tool,
                    scope: 'client',
                  },
                  null,
                  2
                ),
                type: 'text' as const,
              },
            ],
          };
        }

        // 3. Auto-pick across all connected clients
        const clients = this.bridge.listClients();
        const matches: Array<{ clientId: string; descriptor: ToolDescriptorShape }> = [];
        for (const c of clients) {
          const found = findToolInClient(c, tool);
          if (found) {
            matches.push({ clientId: c.id, descriptor: found });
          }
        }
        if (matches.length === 0) {
          return jsonError(
            `Tool '${tool}' not found on any client. Use list_tools to see available tools.`
          );
        }

        // Group by canonical descriptor shape — same shape across clients is not ambiguous
        const byShape = new Map<string, { clientIds: string[]; descriptor: ToolDescriptorShape }>();
        for (const match of matches) {
          const key = canonicalize(match.descriptor);
          const existing = byShape.get(key);
          if (existing) {
            existing.clientIds.push(match.clientId);
          } else {
            byShape.set(key, { clientIds: [match.clientId], descriptor: match.descriptor });
          }
        }

        if (byShape.size === 1) {
          const [first] = byShape.values();
          const { clientIds, descriptor } = first!;
          return {
            content: [
              {
                text: JSON.stringify(
                  {
                    clientIds,
                    description: descriptor.description,
                    inputSchema: descriptor.inputSchema,
                    name: tool,
                    scope: 'client',
                  },
                  null,
                  2
                ),
                type: 'text' as const,
              },
            ],
          };
        }

        const candidates = [...byShape.values()]
          .map(({ clientIds }) => {
            return clientIds.join('+');
          })
          .join('; ');
        return jsonError(
          `Tool '${tool}' exists on multiple clients with different schemas: ${candidates}. Specify clientId.`
        );
      }
    );
  }

  private buildToolGroups(client: ClientEntry): ToolGroup[] {
    const groups: ToolGroup[] = client.modules.map((mod) => {
      return {
        description: mod.description,
        module: mod.name,
        tools: mod.tools.map((t) => {
          return {
            description: t.description,
            inputSchema: t.inputSchema,
            name: `${mod.name}${MODULE_SEPARATOR}${t.name}`,
          };
        }),
      };
    });

    if (client.dynamicTools.size > 0) {
      const dynamicByModule = new Map<
        string,
        Array<{ description: string; name: string; inputSchema?: Record<string, unknown> }>
      >();
      for (const [fullName, info] of client.dynamicTools) {
        const existing = dynamicByModule.get(info.module) ?? [];
        existing.push({
          description: info.description,
          inputSchema: info.inputSchema,
          name: fullName,
        });
        dynamicByModule.set(info.module, existing);
      }
      for (const [module, dynTools] of dynamicByModule) {
        groups.push({
          description: 'Dynamically registered tools from useMcpTool hooks',
          module: `${module} (dynamic)`,
          tools: dynTools,
        });
      }
    }

    return groups;
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
