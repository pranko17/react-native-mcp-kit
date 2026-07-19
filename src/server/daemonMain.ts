import { join } from 'node:path';

import { Bridge } from './bridge';
import { DaemonCore } from './daemonCore';
import { type HostModule } from './host/types';
import { PACKAGE_VERSION } from './mcpServer';
import { ProxyService } from './proxyService';

export interface DaemonConfig {
  port: number;
  hostModules?: HostModule[];
  idleTimeoutMs?: number;
}

/**
 * The shared daemon: bridge (RN apps) + tool registry + proxy service
 * (agent sessions). Spawned detached by the first session proxy; serves every
 * subsequent session; exits on its own once the last proxy has been gone for
 * the idle timeout. Never speaks MCP itself — sessions do, through proxies.
 */
export async function runDaemon(config: DaemonConfig): Promise<void> {
  const bridge = new Bridge(config.port);
  const core = new DaemonCore(bridge, config.hostModules ?? []);

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`react-native-mcp-kit daemon shutting down: ${reason}\n`);
    try {
      await bridge.stop();
    } catch {
      // best effort — exit anyway
    }
    process.exit(0);
  };

  const service = new ProxyService(bridge, core, {
    idleTimeoutMs: config.idleTimeoutMs,
    onIdle: () => {
      void shutdown('idle — no session proxies connected');
    },
    packageVersion: PACKAGE_VERSION,
  });
  void service;

  try {
    await bridge.start();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      // Two proxies raced to spawn the first daemon and this one lost — the
      // winner owns the port and serves everyone. Quiet, successful exit.
      process.stderr.write(
        `react-native-mcp-kit daemon: port ${config.port} already owned — exiting (spawn race).\n`
      );
      process.exit(0);
    }
    throw error;
  }

  const packageRoot = join(__dirname, '..', '..');
  process.stderr.write(
    `react-native-mcp-kit daemon v${PACKAGE_VERSION} (pid ${process.pid}) listening on port ${config.port} — serving ${packageRoot}\n`
  );

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGHUP', () => {
    void shutdown('SIGHUP');
  });
}
