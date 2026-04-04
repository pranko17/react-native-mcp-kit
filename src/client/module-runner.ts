import type { ModuleDescriptor, ToolRequest } from '../shared/protocol';
import type { McpModule, ToolHandler } from './types';

export class ModuleRunner {
  private modules = new Map<string, Record<string, ToolHandler>>();
  private dynamicTools = new Map<string, ToolHandler>();

  registerModules(modules: McpModule[]): void {
    for (const mod of modules) {
      this.modules.set(mod.name, mod.tools);
    }
  }

  registerDynamicTool(name: string, tool: ToolHandler): void {
    this.dynamicTools.set(name, tool);
  }

  unregisterDynamicTool(name: string): void {
    this.dynamicTools.delete(name);
  }

  async handleRequest(request: ToolRequest): Promise<unknown> {
    // Check dynamic tools first (format: "toolName")
    const dynamicTool = this.dynamicTools.get(`${request.module}_${request.method}`);
    if (dynamicTool) {
      return dynamicTool.handler(request.args);
    }

    // Check module tools (format: module + method)
    const moduleTools = this.modules.get(request.module);
    if (!moduleTools) {
      throw new Error(`Module "${request.module}" not found`);
    }

    const tool = moduleTools[request.method];
    if (!tool) {
      throw new Error(`Tool "${request.method}" not found in module "${request.module}"`);
    }

    return tool.handler(request.args);
  }

  getModuleDescriptors(): ModuleDescriptor[] {
    const descriptors: ModuleDescriptor[] = [];

    for (const [name, tools] of this.modules) {
      descriptors.push({
        name,
        tools: Object.entries(tools).map(([toolName, tool]) => {
          return {
            description: tool.description,
            inputSchema: tool.inputSchema,
            name: toolName,
          };
        }),
      });
    }

    return descriptors;
  }
}
