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
        'List connected React Native clients with their IDs, platforms, labels, registered modules, and lifecycle `status` (active / background / inactive — from the app\'s pushed AppState). `disconnected` lists recently-closed clients still held for the ~1-hour reconnect-id window, each with a `status: "disconnected"` and `expiresInMs` countdown; these are shown for visibility but are NOT callable (tools return "not connected").',
    },
    async () => {
      const clients = ctx.bridge.listClients();
      const disconnected = ctx.bridge.listDisconnected();
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
            status: c.appState ?? 'active',
          };
        }),
        disconnected: disconnected.map(({ disconnectedAt, entry, expiresInMs }) => {
          return {
            appName: entry.appName,
            bundleId: entry.bundleId,
            disconnectedAt: new Date(disconnectedAt).toISOString(),
            expiresInMs,
            id: entry.id,
            label: entry.label,
            platform: entry.platform,
            status: 'disconnected',
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
