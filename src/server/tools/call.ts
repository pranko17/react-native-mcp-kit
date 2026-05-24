import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  type BroadcastDispatch,
  buildBroadcastContent,
  detectShadowedOuterArgs,
  jsonError,
  parseCallArgs,
  parseClientIds,
  type ServerContext,
} from '@/server/helpers';
import { MODULE_SEPARATOR } from '@/shared/protocol';

export const registerCallTool = (mcp: McpServer, ctx: ServerContext): void => {
  mcp.registerTool(
    'call',
    {
      annotations: {
        openWorldHint: true,
        title: 'Call Tool',
      },
      description:
        'Call a tool registered by a React Native app client. Use list_tools first to see available tools. When multiple clients are connected, specify clientId; otherwise it is auto-picked. Pass an array (`["ios-1", "android-1"]`) or a `/regex/flags` literal (`"/^ios/"`) to broadcast the same call to several clients in parallel — useful for iOS↔Android parity checks. `args` accepts either a plain object or a JSON string — objects are preferred to avoid escaping quotes.',
      inputSchema: {
        args: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .optional()
          .describe(
            'Tool arguments as a plain object (e.g. { screen: "AUTH_LOGIN_SCREEN" }) or a JSON string.'
          ),
        clientId: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(
            'Target client ID(s). Plain string ("ios-1") selects one client. `/body/flags` literal ("/^ios/") matches connected IDs by regex and broadcasts to every match. Array ([ "ios-1", "/^android/" ]) accepts literals and regex strings mixed — entries are unioned and dedup\'d. Optional when exactly one client is connected.'
          ),
        tool: z
          .string()
          .describe(
            `Tool name in format "module${MODULE_SEPARATOR}method" (e.g. "navigation${MODULE_SEPARATOR}navigate")`
          ),
      },
    },
    async ({ args, clientId, tool }) => {
      const parsed = parseCallArgs(args);
      if (!parsed.ok) return jsonError(parsed.error);

      const shadowed = detectShadowedOuterArgs(parsed.args, 'call', tool);
      if (shadowed) return jsonError(shadowed);

      const clients = parseClientIds(clientId, ctx.bridge);
      if (!clients.ok) return jsonError(clients.error);

      if (clients.mode === 'single') {
        const dispatch = await ctx.dispatchTool(tool, parsed.args, clients.clientId);
        if (!dispatch.ok) return jsonError(dispatch.error);
        return { content: ctx.formatResult(dispatch.result) };
      }

      const results: BroadcastDispatch[] = await Promise.all(
        clients.ids.map(async (id) => {
          const result = await ctx.dispatchTool(tool, parsed.args, id);
          return { clientId: id, result };
        })
      );
      return { content: buildBroadcastContent(results, ctx.formatResult) };
    }
  );
};
