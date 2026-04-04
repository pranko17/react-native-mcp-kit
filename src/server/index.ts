import { Bridge } from './bridge';
import { McpServerWrapper } from './mcp-server';
import type { ServerConfig } from './types';

const DEFAULT_PORT = 8347;

export async function createServer(config?: ServerConfig): Promise<void> {
  const port = config?.port ?? DEFAULT_PORT;
  const bridge = new Bridge(port);
  const mcpServer = new McpServerWrapper(bridge);

  bridge.onRegistration((modules) => {
    mcpServer.registerTools(modules);
  });
  bridge.onStateUpdate((key, value) => {
    mcpServer.setState(key, value);
  });
  bridge.onStateRemove((key) => {
    mcpServer.removeState(key);
  });
  bridge.onToolRegister((module, tool) => {
    mcpServer.registerTool(module, tool);
  });
  bridge.onToolUnregister((module, toolName) => {
    mcpServer.unregisterTool(module, toolName);
  });

  await bridge.start();
  process.stderr.write(`react-native-mcp bridge listening on port ${port}\n`);

  await mcpServer.start();
}

export type { ServerConfig } from './types';
