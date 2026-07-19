#!/usr/bin/env node

import { DEFAULT_PORT } from '@/shared/protocol';

import { describePortOwner, formatEaddrinuseVerdict, parseCliArgs } from './cliHelpers';
import { hostModule } from './host';
import { runProcess } from './host/processRunner';
import { metroModule } from './metro';

import { createServer } from './index';

const { disableHost, port } = parseCliArgs(process.argv.slice(2));

createServer({
  hostModules: disableHost ? [] : [hostModule(runProcess), metroModule()],
  port,
}).catch(async (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    const busyPort = port ?? DEFAULT_PORT;
    const owner = await describePortOwner(busyPort, runProcess);
    process.stderr.write(formatEaddrinuseVerdict(busyPort, owner));
  } else {
    process.stderr.write(`Failed to start server: ${error.message}\n`);
  }
  process.exit(1);
});
