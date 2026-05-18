import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  canonicalize,
  findToolInClient,
  jsonError,
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

      // 2. Explicit clientId — look up the specific client
      if (clientId) {
        const client = ctx.bridge.getClient(clientId);
        if (!client) {
          const available =
            ctx.bridge
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
      const clients = ctx.bridge.listClients();
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
