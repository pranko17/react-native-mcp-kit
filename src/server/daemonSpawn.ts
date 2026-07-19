import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RemoteBackend, VersionMismatchError } from './remoteBackend';

/** Shared log file the detached daemon writes its stderr to — the only place
 * daemon diagnostics surface, since nothing owns its stdio. */
export const DAEMON_LOG_PATH = join(tmpdir(), 'react-native-mcp-kit-daemon.log');

const CONNECT_ATTEMPT_WINDOW_MS = 10_000;
const CONNECT_RETRY_DELAY_MS = 300;

const sleep = (ms: number): Promise<void> => {
  return new Promise((r) => {
    return setTimeout(r, ms);
  });
};

/**
 * Launch the shared daemon fully detached — it must outlive the process that
 * spawns it (a session proxy or the `--doctor` CLI). Its stderr goes to
 * DAEMON_LOG_PATH.
 */
export const spawnDaemon = (daemonArgs: string[]): void => {
  const fd = openSync(DAEMON_LOG_PATH, 'a');
  const child = spawn(process.execPath, [join(__dirname, 'cli.js'), ...daemonArgs], {
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  closeSync(fd);
};

/**
 * Connect to the daemon on `port`, spawning one (once) if the port is silent,
 * and retrying until the connect window elapses. Rethrows a
 * `VersionMismatchError` immediately — a mismatched daemon won't heal by
 * waiting. Shared by the session proxy and the `--doctor` CLI.
 */
export const connectOrSpawnDaemon = async (
  port: number,
  ownVersion: string,
  daemonArgs: string[]
): Promise<RemoteBackend> => {
  const started = Date.now();
  let spawned = false;
  let lastError: Error = new Error('unreachable');
  while (Date.now() - started < CONNECT_ATTEMPT_WINDOW_MS) {
    try {
      return await RemoteBackend.connect(port, ownVersion);
    } catch (err) {
      if (err instanceof VersionMismatchError) throw err;
      lastError = err as Error;
      if (!spawned) {
        spawned = true;
        spawnDaemon(daemonArgs);
      }
      await sleep(CONNECT_RETRY_DELAY_MS);
    }
  }
  throw lastError;
};
