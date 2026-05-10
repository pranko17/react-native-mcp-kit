import { Bridge } from './bridge';
import { type HostModule } from './host/types';
import { McpServerWrapper } from './mcpServer';
import { type ServerConfig } from './types';

const DEFAULT_PORT = 8347;

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

  // Graceful shutdown — without these the WebSocketServer keeps the event loop
  // alive after the MCP client disconnects, leaving an orphan that holds the
  // port and breaks the next session with EADDRINUSE.
  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`react-native-mcp-kit shutting down: ${reason}\n`);
    try {
      await bridge.stop();
    } catch {
      // best effort — exit anyway
    }
    process.exit(0);
  };

  // Parent (Claude Code / Cursor / etc.) closing stdio = our cue to exit.
  process.stdin.on('end', () => {
    void shutdown('stdin ended');
  });
  process.stdin.on('close', () => {
    void shutdown('stdin closed');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGHUP', () => {
    void shutdown('SIGHUP');
  });

  await mcpServer.start();
}

export { type ServerConfig } from './types';
