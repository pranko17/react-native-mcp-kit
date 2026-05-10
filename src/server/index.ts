import { DEFAULT_PORT } from '@/shared/protocol';

import { Bridge } from './bridge';
import { type HostModule } from './host/types';
import { McpServerWrapper } from './mcpServer';
import { type ServerConfig } from './types';

export async function createServer(config?: ServerConfig): Promise<void> {
  const port = config?.port ?? DEFAULT_PORT;
  const hostModules: HostModule[] = config?.hostModules ?? [];
  const bridge = new Bridge(port);
  const mcpServer = new McpServerWrapper(bridge, hostModules);

  await bridge.start();
  process.stderr.write(
    `react-native-mcp-kit bridge listening on port ${port}` +
      (hostModules.length > 0
        ? ` (host modules: ${hostModules
            .map((m) => {
              return m.name;
            })
            .join(', ')})\n`
        : '\n')
  );

  await mcpServer.start();
}

export { type ServerConfig } from './types';
