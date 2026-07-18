#!/usr/bin/env node

import { DEFAULT_PORT } from '@/shared/protocol';

import { hostModule } from './host';
import { runProcess } from './host/processRunner';
import { metroModule } from './metro';

import { createServer } from './index';

const args = process.argv.slice(2);
let port: number | undefined;
let disableHost = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = parseInt(args[i + 1]!, 10);
    i++;
  } else if (args[i] === '--no-host') {
    disableHost = true;
  }
}

// Best-effort (POSIX-only) lookup of whoever holds the port, so an
// EADDRINUSE verdict names the culprit instead of sending the user off to
// run lsof by hand.
const describePortOwner = async (busyPort: number): Promise<string> => {
  try {
    const result = await runProcess('lsof', ['-nP', `-iTCP:${busyPort}`, '-sTCP:LISTEN'], {
      timeoutMs: 3_000,
    });
    const listing = String(result.stdout).trim();
    return listing ? `Held by:\n${listing}\n` : '';
  } catch {
    return '';
  }
};

createServer({
  hostModules: disableHost ? [] : [hostModule(runProcess), metroModule()],
  port,
}).catch(async (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    const busyPort = port ?? DEFAULT_PORT;
    const owner = await describePortOwner(busyPort);
    process.stderr.write(
      `Port ${busyPort} is already in use — most likely another react-native-mcp-kit server ` +
        `(a second IDE window, or a stale process that survived a reinstall).\n` +
        owner +
        `Kill it, or start this server with --port <number> — the app must then connect ` +
        `with the same port (McpClient.initialize option).\n`
    );
  } else {
    process.stderr.write(`Failed to start server: ${error.message}\n`);
  }
  process.exit(1);
});
