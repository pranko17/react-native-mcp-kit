import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { type WireCallResult, type WireToolDescriptor } from '@/shared/proxyProtocol';

import { connectOrSpawnDaemon, DAEMON_LOG_PATH } from './daemonSpawn';
import { type FrontBackend, McpFront } from './mcpFront';
import { PACKAGE_VERSION } from './mcpServer';
import { type RemoteBackend, VersionMismatchError } from './remoteBackend';

const RECONNECT_RETRY_DELAY_MS = 3_000;

export interface ProxyConfig {
  /** argv for the daemon process (`--daemon --port N [--no-host]`). */
  daemonArgs: string[];
  port: number;
}

const sleep = (ms: number): Promise<void> => {
  return new Promise((r) => {
    return setTimeout(r, ms);
  });
};

/**
 * Per-session stdio MCP process: a thin front over the shared daemon. On
 * startup it connects to the daemon (spawning one if the port is silent),
 * then serves MCP over stdio, forwarding everything. If the daemon dies, the
 * proxy respawns it and reconnects — the MCP session stays up throughout,
 * with a `list_changed` refresh once the catalog is back.
 */
export async function runProxy(config: ProxyConfig): Promise<void> {
  let backend: RemoteBackend | null = null;
  const changedListeners = new Set<() => void>();
  const notifyChanged = (): void => {
    for (const listener of changedListeners) {
      listener();
    }
  };

  const connectWithSpawn = (): Promise<RemoteBackend> => {
    return connectOrSpawnDaemon(config.port, PACKAGE_VERSION, config.daemonArgs);
  };

  const attach = (remote: RemoteBackend): void => {
    backend = remote;
    remote.onToolsChanged(notifyChanged);
    remote.on('down', () => {
      backend = null;
      process.stderr.write('react-native-mcp-kit: daemon connection lost — reconnecting.\n');
      void reconnectForever();
    });
  };

  const reconnectForever = async (): Promise<void> => {
    for (;;) {
      try {
        attach(await connectWithSpawn());
        notifyChanged();
        return;
      } catch (err) {
        if (err instanceof VersionMismatchError) {
          process.stderr.write(`react-native-mcp-kit: ${err.message}\n`);
          return;
        }
        process.stderr.write(
          `react-native-mcp-kit: daemon still unreachable (${(err as Error).message}) — retrying. Daemon log: ${DAEMON_LOG_PATH}\n`
        );
        await sleep(RECONNECT_RETRY_DELAY_MS);
      }
    }
  };

  // Backend shim the front holds forever — survives daemon restarts.
  const shim: FrontBackend = {
    callTool: (name, args): Promise<WireCallResult> => {
      if (!backend) {
        return Promise.resolve({
          content: [
            {
              text: JSON.stringify({
                error:
                  'Daemon connection is re-establishing — retry in a few seconds. If this persists, check the daemon log: ' +
                  DAEMON_LOG_PATH,
              }),
              type: 'text',
            },
          ],
        });
      }
      return backend.callTool(name, args);
    },
    listTools: (): Promise<WireToolDescriptor[]> => {
      return backend ? backend.listTools() : Promise.resolve([]);
    },
    onToolsChanged: (listener) => {
      changedListeners.add(listener);
      return () => {
        changedListeners.delete(listener);
      };
    },
  };

  // First connection happens BEFORE the MCP transport opens so the session's
  // initial tools/list already sees the shared catalog.
  attach(await connectWithSpawn());

  const front = new McpFront(shim, PACKAGE_VERSION);
  await front.connectTransport(new StdioServerTransport());
  front.sendToolListChanged();

  process.stderr.write(
    `react-native-mcp-kit proxy v${PACKAGE_VERSION} attached to daemon on port ${config.port}\n`
  );

  // The proxy dies with its session — the daemon is the survivor, and it
  // notices the proxy socket close (idle shutdown once the last one is gone).
  const exit = (): void => {
    backend?.close();
    process.exit(0);
  };
  process.stdin.on('end', exit);
  process.stdin.on('close', exit);
  process.on('SIGINT', exit);
  process.on('SIGTERM', exit);
  process.on('SIGHUP', exit);
}
