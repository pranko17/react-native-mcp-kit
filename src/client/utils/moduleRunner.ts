import { type McpModule, type ToolHandler } from '@/client/models/types';
import { serializeInputSchema } from '@/client/utils/serializeInputSchema';
import { type ModuleDescriptor, type ToolRequest } from '@/shared/protocol';

export class ModuleRunner {
  private moduleDescriptions = new Map<string, string>();
  private modules = new Map<string, Record<string, ToolHandler>>();
  private dynamicTools = new Map<string, ToolHandler>();

  registerModules(modules: McpModule[]): void {
    for (const mod of modules) {
      this.modules.set(mod.name, mod.tools);
      if (mod.description) {
        this.moduleDescriptions.set(mod.name, mod.description);
      }
    }
  }

  unregisterModules(names: string[]): void {
    for (const name of names) {
      this.modules.delete(name);
      this.moduleDescriptions.delete(name);
    }
  }

  registerDynamicTool(name: string, tool: ToolHandler): void {
    this.dynamicTools.set(name, tool);
  }

  unregisterDynamicTool(name: string): void {
    this.dynamicTools.delete(name);
  }

  async handleRequest(request: ToolRequest): Promise<unknown> {
    // Check dynamic tools first — stored by name only
    const dynamicTool = this.dynamicTools.get(request.method);
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
        description: this.moduleDescriptions.get(name),
        name,
        tools: Object.entries(tools).map(([toolName, tool]) => {
          return {
            description: tool.description,
            inputSchema: serializeInputSchema(tool.inputSchema),
            name: toolName,
            timeout: tool.timeout,
          };
        }),
      });
    }

    return descriptors;
  }
}
