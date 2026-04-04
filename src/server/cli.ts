#!/usr/bin/env node

import { createServer } from './index';

const args = process.argv.slice(2);
let port: number | undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = parseInt(args[i + 1]!, 10);
    i++;
  }
}

createServer({ port }).catch((error: Error) => {
  process.stderr.write(`Failed to start server: ${error.message}\n`);
  process.exit(1);
});
