import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  canonicalizeGroup,
  jsonError,
  parseClientIds,
  type ServerContext,
  type ToolGroup,
} from '@/server/helpers';
import { MODULE_SEPARATOR } from '@/shared/protocol';

export const registerListToolsTool = (mcp: McpServer, ctx: ServerContext): void => {
  mcp.registerTool(
    'list_tools',
    {
      annotations: {
        readOnlyHint: true,
        title: 'List Tools',
      },
      description:
        "Browse tool names + one-line descriptions (schema-free; modules identical across clients dedupe into one entry with a `clientIds` array). Also returns the connected `clients` and host `hostTools`. Filter with `module` / `clientId` (string, array, or `/regex/`); `compact: true` drops module-level descriptions. Use describe_tool for a tool's full input schema before calling.",
      inputSchema: {
        clientId: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(
            'Narrow listing to a single client (string), a `/body/flags` regex over IDs, or several clients (array of literals and/or regex strings). Omit for all connected clients.'
          ),
        compact: z
          .boolean()
          .optional()
          .describe(
            'Drop module-level descriptions (still keeps per-tool one-liners). Default false.'
          ),
        module: z
          .string()
          .optional()
          .describe(
            'Narrow listing to a single module name (e.g. "fiber_tree", "host"). Omit for all.'
          ),
      },
    },
    async ({ clientId, compact, module }) => {
      const filter = parseClientIds(clientId, ctx.bridge);
      if (!filter.ok) return jsonError(filter.error);
      const allClients = ctx.bridge.listClients();
      const clients =
        filter.mode === 'broadcast'
          ? allClients.filter((c) => {
              return filter.ids.includes(c.id);
            })
          : filter.clientId
            ? allClients.filter((c) => {
                return c.id === filter.clientId;
              })
            : allClients;

      // Dedup tool groups across clients by canonical shape
      const dedupMap = new Map<string, { clientIds: string[]; group: ToolGroup }>();
      for (const client of clients) {
        const groups = ctx.listToolGroups(client);
        for (const group of groups) {
          if (module && group.module !== module) continue;
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
          description: compact ? undefined : group.description,
          name: group.module,
          tools: group.tools.map((t) => {
            return {
              description: t.description,
              name: t.name,
            };
          }),
        };
      });

      const hostToolsPayload = ctx.hostModules
        .filter((mod) => {
          return !module || mod.name === module;
        })
        .map((mod) => {
          return {
            description: compact ? undefined : mod.description,
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
          devServer: client.devServer,
          deviceId: client.deviceId,
          id: client.id,
          isSimulator: client.isSimulator,
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
};
