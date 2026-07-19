#!/usr/bin/env node

import { DEFAULT_PORT } from '@/shared/protocol';

import { describePortOwner, formatProxyStartupVerdict, parseCliArgs } from './cliHelpers';
import { runDaemon } from './daemonMain';
import { hostModule } from './host';
import { runProcess } from './host/processRunner';
import { metroModule } from './metro';
import { DAEMON_LOG_PATH, runProxy } from './proxyMain';
import { VersionMismatchError } from './remoteBackend';

const { daemon, disableHost, port } = parseCliArgs(process.argv.slice(2));
const resolvedPort = port ?? DEFAULT_PORT;

if (daemon) {
  // Daemon mode — spawned detached by a session proxy. Owns the bridge, the
  // registry, and all app state; serves any number of session proxies.
  runDaemon({
    hostModules: disableHost ? [] : [hostModule(runProcess), metroModule()],
    port: resolvedPort,
  }).catch((error: Error) => {
    process.stderr.write(`Failed to start daemon: ${error.message}\n`);
    process.exit(1);
  });
} else {
  // Default mode — the per-session stdio proxy Claude Code spawns. Connects
  // to the shared daemon, starting one if the port is silent.
  const daemonArgs = ['--daemon', '--port', String(resolvedPort)];
  if (disableHost) daemonArgs.push('--no-host');
  runProxy({ daemonArgs, port: resolvedPort }).catch(async (error: Error) => {
    if (error instanceof VersionMismatchError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      const owner = await describePortOwner(resolvedPort, runProcess);
      process.stderr.write(
        formatProxyStartupVerdict(resolvedPort, owner, DAEMON_LOG_PATH, error.message)
      );
    }
    process.exit(1);
  });
}
