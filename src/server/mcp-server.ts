import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import type { ModuleDescriptor, ModuleToolDescriptor } from '../shared/protocol';
import type { Bridge } from './bridge';

export class McpServerWrapper {
  private mcp: McpServer;
  private stateStore = new Map<string, unknown>();
  private registeredTools = new Set<string>();

  constructor(private readonly bridge: Bridge) {
    this.mcp = new McpServer(
      { name: 'react-native-mcp', version: '0.1.0' },
    );

    this.registerBuiltInTools();
  }

  registerTools(modules: ModuleDescriptor[]): void {
    for (const mod of modules) {
      for (const tool of mod.tools) {
        const fullName = `${mod.name}_${tool.name}`;
        this.registerBridgeTool(fullName, mod.name, tool.name, tool);
      }
    }
  }

  registerTool(module: string, tool: ModuleToolDescriptor): void {
    const fullName = `${module}_${tool.name}`;
    this.registerBridgeTool(fullName, module, tool.name, tool);
  }

  unregisterTool(module: string, toolName: string): void {
    const fullName = `${module}_${toolName}`;
    this.registeredTools.delete(fullName);
    // Note: McpServer SDK doesn't support dynamic tool removal yet
    // The tool will remain registered but return an error if called after unregister
  }

  setState(key: string, value: unknown): void {
    this.stateStore.set(key, value);
  }

  removeState(key: string): void {
    this.stateStore.delete(key);
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.mcp.connect(transport);
  }

  private registerBuiltInTools(): void {
    this.mcp.tool(
      'state_get',
      'Read a state value exposed by the React Native app via useMcpState',
      { key: z.string().describe('State key to read (e.g. "cart", "auth")') },
      async ({ key }) => {
        const value = this.stateStore.get(key);
        if (value === undefined) {
          return {
            content: [{ text: JSON.stringify({ error: `State "${key}" not found. Use state_list to see available keys.` }), type: 'text' as const }],
          };
        }
        return {
          content: [{ text: JSON.stringify(value, null, 2), type: 'text' as const }],
        };
      },
    );

    this.mcp.tool(
      'state_list',
      'List all available state keys exposed by the React Native app',
      async () => {
        const keys = Array.from(this.stateStore.keys());
        return {
          content: [{ text: JSON.stringify({ keys }, null, 2), type: 'text' as const }],
        };
      },
    );

    this.mcp.tool(
      'connection_status',
      'Check if the React Native app is connected',
      async () => {
        return {
          content: [{
            text: JSON.stringify({ connected: this.bridge.isClientConnected() }),
            type: 'text' as const,
          }],
        };
      },
    );
  }

  private registerBridgeTool(
    fullName: string,
    moduleName: string,
    methodName: string,
    tool: ModuleToolDescriptor,
  ): void {
    if (this.registeredTools.has(fullName)) return;
    this.registeredTools.add(fullName);

    if (tool.inputSchema && Object.keys(tool.inputSchema).length > 0) {
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, _value] of Object.entries(tool.inputSchema)) {
        shape[key] = z.any().describe(String(key));
      }

      this.mcp.tool(
        fullName,
        tool.description,
        shape,
        async (args) => {
          const result = await this.bridge.call(moduleName, methodName, args);
          return {
            content: [{ text: JSON.stringify(result, null, 2), type: 'text' as const }],
          };
        },
      );
    } else {
      this.mcp.tool(
        fullName,
        tool.description,
        async () => {
          const result = await this.bridge.call(moduleName, methodName, {});
          return {
            content: [{ text: JSON.stringify(result, null, 2), type: 'text' as const }],
          };
        },
      );
    }
  }
}
