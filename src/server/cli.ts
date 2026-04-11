#!/usr/bin/env node

import { hostModule } from './host';
import { runProcess } from './host/processRunner';

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

createServer({
  hostModules: disableHost ? [] : [hostModule(runProcess)],
  port,
}).catch((error: Error) => {
  process.stderr.write(`Failed to start server: ${error.message}\n`);
  process.exit(1);
});
