import { type McpModule, type ToolHandler } from '@/client/models/types';
import { McpConnection } from '@/client/utils/connection';
import { ModuleRunner } from '@/client/utils/moduleRunner';
import { type ToolRequest } from '@/shared/protocol';

const DEFAULT_PORT = 8347;
const TAG = '\x1b[35m[react-native-mcp]\x1b[0m';
const ARROW_IN = '\x1b[36m→\x1b[0m';
const ARROW_OUT = '\x1b[32m←\x1b[0m';
const CROSS = '\x1b[31m✕\x1b[0m';

// Capture original console.log before any module intercepts it
const originalConsoleLog = console.log.bind(console);

export class McpClient {
  private static instance: McpClient | null = null;

  private connection: McpConnection;
  private debug = false;
  private moduleRunner = new ModuleRunner();

  private constructor(port: number) {
    this.connection = new McpConnection(port);

    this.connection.onOpen(() => {
      this.log('Connected to MCP server');
      this.sendRegistration();
    });

    this.connection.onMessage((message: ToolRequest) => {
      if (message.type === 'tool_request') {
        this.log(`${ARROW_IN} Tool request: ${message.module}.${message.method}`, message.args);
        this.moduleRunner
          .handleRequest(message)
          .then((result) => {
            this.log(`${ARROW_OUT} Tool response: ${message.module}.${message.method}`, result);
            this.connection.send({
              id: message.id,
              result,
              type: 'tool_response',
            });
          })
          .catch((error: Error) => {
            this.log(`${CROSS} Tool error: ${message.module}.${message.method}`, error.message);
            this.connection.send({
              error: error.message,
              id: message.id,
              type: 'tool_response',
            });
          });
      }
    });

    this.connection.connect();
  }

  static initialize(options?: { debug?: boolean; port?: number }): McpClient {
    if (McpClient.instance) {
      if (options?.debug !== undefined) {
        McpClient.instance.debug = options.debug;
      }
      return McpClient.instance;
    }

    McpClient.instance = new McpClient(options?.port ?? DEFAULT_PORT);
    McpClient.instance.debug = options?.debug ?? false;
    return McpClient.instance;
  }

  static getInstance(): McpClient {
    if (!McpClient.instance) {
      console.error(`${TAG} McpClient is not initialized. Call McpClient.initialize() first.`);
      throw new Error('McpClient is not initialized. Call McpClient.initialize() first.');
    }

    return McpClient.instance;
  }

  dispose(): void {
    this.log('Disposing MCP client');
    this.connection.dispose();
    McpClient.instance = null;
  }

  enableDebug(enabled: boolean): void {
    this.debug = enabled;
  }

  registerModule(module: McpModule): void {
    this.log(`Registering module: ${module.name}`, Object.keys(module.tools));
    this.moduleRunner.registerModules([module]);
    this.sendRegistration();
  }

  registerModules(modules: McpModule[]): void {
    this.log(
      'Registering modules:',
      modules.map((m) => {
        return m.name;
      })
    );
    this.moduleRunner.registerModules(modules);
    this.sendRegistration();
  }

  registerTool(name: string, tool: ToolHandler): void {
    this.log(`Registering dynamic tool: ${name}`);
    this.moduleRunner.registerDynamicTool(name, tool);
    this.connection.send({
      module: '_dynamic',
      tool: {
        description: tool.description,
        inputSchema: tool.inputSchema,
        name,
      },
      type: 'tool_register',
    });
  }

  removeState(key: string): void {
    this.log(`Removing state: ${key}`);
    this.connection.send({
      key,
      type: 'state_remove',
    });
  }

  setState(key: string, value: unknown): void {
    this.log(`Setting state: ${key}`, value);
    this.connection.send({
      key,
      type: 'state_update',
      value,
    });
  }

  unregisterTool(name: string): void {
    this.log(`Unregistering dynamic tool: ${name}`);
    this.moduleRunner.unregisterDynamicTool(name);
    this.connection.send({
      module: '_dynamic',
      toolName: name,
      type: 'tool_unregister',
    });
  }

  private log(message: string, data?: unknown): void {
    if (!this.debug) return;
    if (data !== undefined) {
      originalConsoleLog(`${TAG} ${message}`, data);
    } else {
      originalConsoleLog(`${TAG} ${message}`);
    }
  }

  private sendRegistration(): void {
    const descriptors = this.moduleRunner.getModuleDescriptors();
    this.log(
      'Sending registration:',
      descriptors.map((m) => {
        return `${m.name} (${m.tools.length} tools)`;
      })
    );
    this.connection.send({
      modules: descriptors,
      type: 'registration',
    });
  }
}
