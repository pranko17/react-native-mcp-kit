import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  canonicalize,
  findToolInClient,
  jsonError,
  parseClientIds,
  type ServerContext,
  type ToolDescriptorShape,
} from '@/server/helpers';
import { MODULE_SEPARATOR } from '@/shared/protocol';

export const registerDescribeToolTool = (mcp: McpServer, ctx: ServerContext): void => {
  mcp.registerTool(
    'describe_tool',
    {
      annotations: {
        readOnlyHint: true,
        title: 'Describe Tool',
      },
      description:
        'Fetch the full description and input schema for a single tool. Use this after list_tools to learn how to construct arguments for a tool before calling it. For host tools, clientId is ignored. For in-app tools, omit clientId to auto-pick the shared descriptor; specify a string clientId to pin to one client, or an array of clientIds to narrow the auto-pick to that subset (useful when other clients have a divergent schema).',
      inputSchema: {
        clientId: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(
            'Target client(s) for in-app tools. String pins to one client; array narrows the canonicalisation pool to the listed clients. Ignored for host tools.'
          ),
        tool: z
          .string()
          .describe(
            `Full tool name in the format "module${MODULE_SEPARATOR}method" (e.g. "navigation${MODULE_SEPARATOR}navigate", "host${MODULE_SEPARATOR}screenshot").`
          ),
      },
    },
    async ({ clientId, tool }) => {
      const parsedClient = parseClientIds(clientId);
      if (!parsedClient.ok) return jsonError(parsedClient.error);

      // 1. Host tool path — resolved via hostToolMap, clientId is ignored
      const hostEntry = ctx.hostToolMap.get(tool);
      if (hostEntry) {
        const mod = ctx.hostModules.find((m) => {
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

      // 2. Explicit single clientId — pin to one client
      if (parsedClient.mode === 'single' && parsedClient.clientId) {
        const pinned = parsedClient.clientId;
        const client = ctx.bridge.getClient(pinned);
        if (!client) {
          const available =
            ctx.bridge
              .listClients()
              .map((c) => {
                return c.id;
              })
              .join(', ') || '(none)';
          return jsonError(`Client '${pinned}' not connected. Available: ${available}`);
        }
        const found = findToolInClient(client, tool);
        if (!found) {
          return jsonError(`Tool '${tool}' not found on client '${pinned}'.`);
        }
        return {
          content: [
            {
              text: JSON.stringify(
                {
                  clientIds: [pinned],
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

      // 3. Auto-pick across all connected clients (optionally narrowed by an
      //    explicit array of clientIds — only those clients participate in the
      //    canonicalisation pool).
      const allClients = ctx.bridge.listClients();
      const clients =
        parsedClient.mode === 'broadcast'
          ? allClients.filter((c) => {
              return parsedClient.ids.includes(c.id);
            })
          : allClients;
      if (parsedClient.mode === 'broadcast' && clients.length === 0) {
        const available =
          allClients
            .map((c) => {
              return c.id;
            })
            .join(', ') || '(none)';
        return jsonError(
          `None of the requested clients (${parsedClient.ids.join(', ')}) are connected. Available: ${available}`
        );
      }
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
};
