import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { type Bridge } from './bridge';
import { DaemonCore } from './daemonCore';
import { type HostModule } from './host/types';
import { localBackend, McpFront } from './mcpFront';

// Read the shipped package.json so the MCP handshake reports an accurate
// server version — keeps clients' connection logs in sync with the installed
// package without a parallel constant to maintain. __dirname at runtime is
// dist/server, so the relative walk lands on the package root.
export const PACKAGE_VERSION = ((): string => {
  try {
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();

/**
 * Single-process composition: DaemonCore + one in-process MCP front. This is
 * the embedding / test entrypoint (`connectTransport`) and the engine behind
 * `createServer`'s single-session mode. The multi-session CLI path composes
 * the same pieces differently (daemon + per-session proxies).
 */
export class McpServerWrapper {
  readonly core: DaemonCore;
  private front: McpFront;

  constructor(bridge: Bridge, hostModules: HostModule[] = []) {
    this.core = new DaemonCore(bridge, hostModules);
    this.front = new McpFront(localBackend(this.core), PACKAGE_VERSION);
  }

  async start(): Promise<void> {
    // Give RN clients a short window to connect to the bridge BEFORE the MCP
    // transport opens: the typical "app was already running" case then lands
    // module tools in the very first tools/list, sparing the agent a
    // list_changed round-trip (and covering MCP clients that don't honour the
    // notification at all).
    await this.core.waitForFirstClient(2000);
    const transport = new StdioServerTransport();
    await this.front.connectTransport(transport);
    // Re-broadcast for clients that connected between the wait window closing
    // and the transport opening.
    this.front.sendToolListChanged();
  }

  // Test/embedding entrypoint: attach the MCP endpoint to a caller-provided
  // transport (e.g. InMemoryTransport) instead of the stdio transport that
  // start() owns for the CLI path.
  async connectTransport(transport: Transport): Promise<void> {
    await this.front.connectTransport(transport);
  }
}
