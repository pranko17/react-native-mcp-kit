import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { jsonError, parseCallArgs, type ServerContext } from '@/server/helpers';
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
        'Call a tool registered by a React Native app client. Use list_tools first to see available tools. When multiple clients are connected, specify clientId; otherwise it is auto-picked. `args` accepts either a plain object or a JSON string — objects are preferred to avoid escaping quotes.',
      inputSchema: {
        args: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .optional()
          .describe(
            'Tool arguments as a plain object (e.g. { screen: "AUTH_LOGIN_SCREEN" }) or a JSON string.'
          ),
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
      const parsed = parseCallArgs(args);
      if (!parsed.ok) return jsonError(parsed.error);
      const dispatch = await ctx.dispatchTool(tool, parsed.args, clientId);
      if (!dispatch.ok) return jsonError(dispatch.error);
      return { content: ctx.formatResult(dispatch.result) };
    }
  );
};
