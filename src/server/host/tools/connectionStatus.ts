import { type HostToolHandler } from '@/server/host/types';

/**
 * Reports which RN clients are currently connected to the bridge with their
 * platform, label, app metadata, and registered module names. Replaces the
 * legacy top-level `connection_status` meta-tool with a first-class host tool
 * so it shows up in the MCP catalog like any other.
 */
export const connectionStatusTool = (): HostToolHandler => {
  return {
    description:
      'List connected React Native clients with their IDs, platforms, labels, app metadata, and registered module names. Use the returned client IDs to disambiguate calls when more than one client is connected.',
    handler: (_args, ctx) => {
      const clients = ctx.bridge.listClients();
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
          };
        }),
      };
    },
    inputSchema: {},
  };
};
