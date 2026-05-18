import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { type ServerContext } from '@/server/helpers';

export const registerConnectionStatusTool = (mcp: McpServer, ctx: ServerContext): void => {
  mcp.registerTool(
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
      const clients = ctx.bridge.listClients();
      const payload = {
        clientCount: clients.length,
        clients: clients.map((c) => {
          return {
            appName: c.appName,
            appVersion: c.appVersion,
            bundleId: c.bundleId,
            connectedAt: new Date(c.connectedAt).toISOString(),
            devServer: c.devServer,
            deviceId: c.deviceId,
            id: c.id,
            label: c.label,
            modules: c.modules.map((m) => {
              return m.name;
            }),
            platform: c.platform,
          };
        }),
        hostModules: ctx.hostModules.map((m) => {
          return m.name;
        }),
      };
      return {
        content: [{ text: JSON.stringify(payload, null, 2), type: 'text' as const }],
      };
    }
  );
};
