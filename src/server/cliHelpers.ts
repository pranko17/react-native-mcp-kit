import { type ProcessRunner } from './host/processRunner';

export interface CliArgs {
  daemon: boolean;
  disableHost: boolean;
  port?: number;
}

export const parseCliArgs = (argv: readonly string[]): CliArgs => {
  const parsed: CliArgs = { daemon: false, disableHost: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) {
      parsed.port = parseInt(argv[i + 1]!, 10);
      i++;
    } else if (argv[i] === '--no-host') {
      parsed.disableHost = true;
    } else if (argv[i] === '--daemon') {
      parsed.daemon = true;
    }
  }
  return parsed;
};

/**
 * Best-effort (POSIX-only) lookup of whoever holds the port, so an
 * EADDRINUSE verdict names the culprit instead of sending the user off to
 * run lsof by hand.
 */
export const describePortOwner = async (
  busyPort: number,
  runner: ProcessRunner
): Promise<string> => {
  try {
    const result = await runner('lsof', ['-nP', `-iTCP:${busyPort}`, '-sTCP:LISTEN'], {
      timeoutMs: 3_000,
    });
    const listing = String(result.stdout).trim();
    return listing ? `Held by:\n${listing}\n` : '';
  } catch {
    return '';
  }
};

export const formatEaddrinuseVerdict = (busyPort: number, owner: string): string => {
  return (
    `Port ${busyPort} is already in use — most likely another react-native-mcp-kit server ` +
    `(a second IDE window, or a stale process that survived a reinstall).\n` +
    owner +
    `Kill it, or start this server with --port <number> — the app must then connect ` +
    `with the same port (McpClient.initialize option).\n`
  );
};

/**
 * Session-proxy startup failure: the daemon could be neither reached nor
 * spawned. Two very different causes hide behind that — a foreign process
 * squatting on the port, or the daemon crashing at boot — so the verdict
 * branches on whether the port has an owner.
 */
export const formatProxyStartupVerdict = (
  busyPort: number,
  owner: string,
  logPath: string,
  cause: string
): string => {
  return (
    `Could not reach or start the react-native-mcp-kit daemon on port ${busyPort} (${cause}).\n` +
    owner +
    (owner
      ? `The port is held by a process that does not speak the daemon protocol — kill it, ` +
        `or use --port <number> (the app must then connect with the same port).\n`
      : `The daemon may be failing at startup — check its log: ${logPath}\n`)
  );
};
