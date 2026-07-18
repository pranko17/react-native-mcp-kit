import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { PACKAGE_NAME } from '@/shared/protocol';

import { type Bridge } from './bridge';
import { buildHostToolMap, createDispatcher } from './dispatch';
import { buildToolGroups, formatResult, type ServerContext } from './helpers';
import { type HostModule } from './host/types';
import { BASE_INSTRUCTIONS } from './instructions';
import { registerAssertTool } from './tools/assert';
import { registerCallTool } from './tools/call';
import { registerConnectionStatusTool } from './tools/connectionStatus';
import { registerDescribeToolTool } from './tools/describeTool';
import { registerListToolsTool } from './tools/listTools';
import { registerWaitUntilTool } from './tools/waitUntil';

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

export class McpServerWrapper {
  private mcp: McpServer;

  constructor(bridge: Bridge, hostModules: HostModule[] = []) {
    const hostToolMap = buildHostToolMap(hostModules);
    const dispatchTool = createDispatcher(bridge, hostToolMap);

    this.mcp = new McpServer(
      { name: PACKAGE_NAME, version: PACKAGE_VERSION },
      { instructions: BASE_INSTRUCTIONS }
    );

    const ctx: ServerContext = {
      bridge,
      dispatchTool,
      formatResult,
      hostModules,
      hostToolMap,
      listToolGroups: buildToolGroups,
    };

    registerCallTool(this.mcp, ctx);
    registerWaitUntilTool(this.mcp, ctx);
    registerAssertTool(this.mcp, ctx);
    registerListToolsTool(this.mcp, ctx);
    registerDescribeToolTool(this.mcp, ctx);
    registerConnectionStatusTool(this.mcp, ctx);
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.mcp.connect(transport);
  }
}
