import { z } from 'zod';

import { type HostToolHandler } from '@/server/host/types';

/**
 * First-class host-tool replacement for the legacy top-level
 * `connection_status` meta-tool — same payload, shows up in the MCP catalog
 * like any other host tool and works with no RN client connected.
 */
export const connectionStatusTool = (): HostToolHandler => {
  return {
    description:
      'List connected React Native clients — per client: id, platform, label, appName/appVersion, bundleId, deviceId, connectedAt, devServer, registered modules, and a lifecycle `status` (active / background / inactive, from the app\'s pushed AppState). `disconnected` lists recently-closed clients still held for the ~1-hour reconnect-id window, each with `status: "disconnected"` + an `expiresInMs` countdown — shown for visibility but NOT callable (tools return "not connected").',
    handler: (_args, ctx) => {
      const clients = ctx.bridge.listClients();
      const disconnected = ctx.bridge.listDisconnected();
      return {
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
      };
    },
    inputSchema: z.looseObject({}),
  };
};
