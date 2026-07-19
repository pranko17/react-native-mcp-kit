import { type ProcessRunner } from './host/processRunner';

export interface CliArgs {
  disableHost: boolean;
  port?: number;
}

export const parseCliArgs = (argv: readonly string[]): CliArgs => {
  const parsed: CliArgs = { disableHost: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) {
      parsed.port = parseInt(argv[i + 1]!, 10);
      i++;
    } else if (argv[i] === '--no-host') {
      parsed.disableHost = true;
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
