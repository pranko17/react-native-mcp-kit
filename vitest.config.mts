import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration tests spawn a WebSocketServer per suite — serial keeps the
    // ephemeral-port juggling deterministic. Unit suites are fast enough that
    // parallelism isn't worth the flake surface.
    pool: 'forks',
  },
});
