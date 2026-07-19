#!/usr/bin/env node

import { DEFAULT_PORT } from '@/shared/protocol';

import { describePortOwner, formatProxyStartupVerdict, parseCliArgs } from './cliHelpers';
import { runDaemon } from './daemonMain';
import { DAEMON_LOG_PATH } from './daemonSpawn';
import { runDoctorCli } from './doctorCli';
import { hostModule } from './host';
import { runProcess } from './host/processRunner';
import { metroModule } from './metro';
import { runProxy } from './proxyMain';
import { VersionMismatchError } from './remoteBackend';

const { daemon, disableHost, doctor, port } = parseCliArgs(process.argv.slice(2));
const resolvedPort = port ?? DEFAULT_PORT;
const daemonArgs = ['--daemon', '--port', String(resolvedPort)];
if (disableHost) daemonArgs.push('--no-host');

if (daemon) {
  // Daemon mode — spawned detached by a session proxy (or the --doctor CLI).
  // Owns the bridge, the registry, and all app state; serves any number of
  // session proxies.
  runDaemon({
    hostModules: disableHost ? [] : [hostModule(runProcess), metroModule()],
    port: resolvedPort,
  }).catch((error: Error) => {
    process.stderr.write(`Failed to start daemon: ${error.message}\n`);
    process.exit(1);
  });
} else if (doctor) {
  // Human-facing setup diagnosis — connect (spawning a daemon if needed), run
  // host__doctor, print a verdict, exit 0/1.
  runDoctorCli({ daemonArgs, port: resolvedPort }).catch((error: Error) => {
    process.stderr.write(`doctor failed: ${error.message}\n`);
    process.exit(1);
  });
} else {
  // Default mode — the per-session stdio proxy Claude Code spawns. Connects
  // to the shared daemon, starting one if the port is silent.
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
