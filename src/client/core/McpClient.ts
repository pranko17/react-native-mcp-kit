import { type McpModule, type ToolHandler } from '@/client/models/types';
import { McpConnection } from '@/client/utils/connection';
import { ModuleRunner } from '@/client/utils/moduleRunner';
import { MODULE_SEPARATOR, type ToolRequest } from '@/shared/protocol';

const DEFAULT_PORT = 8347;
const TAG = '\x1b[1;35m[rn-mcp-kit]\x1b[0m';
const ARROW_IN = '\x1b[36m→\x1b[0m';
const ARROW_OUT = '\x1b[32m←\x1b[0m';
const CROSS = '\x1b[31m✕\x1b[0m';

const MODULE_COLORS = [
  '\x1b[1;31m', // bold red
  '\x1b[1;32m', // bold green
  '\x1b[1;33m', // bold yellow
  '\x1b[1;34m', // bold blue
  '\x1b[1;35m', // bold magenta
  '\x1b[1;36m', // bold cyan
  '\x1b[1;94m', // bold bright blue
  '\x1b[1;95m', // bold bright magenta
];

const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const moduleColorMap = new Map<string, string>();

const getModuleColor = (moduleName: string): string => {
  const existing = moduleColorMap.get(moduleName);
  if (existing) {
    return existing;
  }
  const color = MODULE_COLORS[moduleColorMap.size % MODULE_COLORS.length]!;
  moduleColorMap.set(moduleName, color);
  return color;
};

const colorModule = (moduleName: string): string => {
  return `${getModuleColor(moduleName)}${moduleName}${RESET}`;
};

const formatTool = (moduleName: string, method: string): string => {
  return `${colorModule(moduleName)}.${BOLD}${method}${RESET}`;
};

// Capture original console.log before any module intercepts it
const originalConsoleLog = console.log.bind(console);

interface ClientIdentity {
  appName?: string;
  appVersion?: string;
  deviceId?: string;
  label?: string;
  platform?: string;
}

// react-native-device-info returns the literal string "unknown" on Android
// emulators and some real devices when Settings.Global.DEVICE_NAME is empty.
// Treat it the same as undefined so we can fall back to manufacturer + model.
const isUsefulString = (value: unknown): value is string => {
  return typeof value === 'string' && value.length > 0 && value.toLowerCase() !== 'unknown';
};

const autoDetectIdentity = (): ClientIdentity => {
  const out: ClientIdentity = {};

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const rn = require('react-native');
    const os = rn.Platform?.OS ?? rn.default?.Platform?.OS;
    if (typeof os === 'string') {
      out.platform = os;
    }
  } catch {
    // not running inside a React Native bundle — that's fine
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const di = require('react-native-device-info');
    const DI = di.default ?? di;
    const appName: unknown = DI.getApplicationName?.();
    const appVersion: unknown = DI.getVersion?.();
    const rawDeviceName: unknown = DI.getDeviceNameSync?.();
    const model: unknown = DI.getModel?.();
    const manufacturer: unknown = DI.getManufacturerSync?.() ?? DI.getBrand?.();
    const deviceId: unknown = DI.getUniqueIdSync?.();

    if (typeof appName === 'string') {
      out.appName = appName;
    }
    if (typeof appVersion === 'string') {
      out.appVersion = appVersion;
    }
    if (isUsefulString(rawDeviceName)) {
      out.label = rawDeviceName;
    } else if (isUsefulString(model)) {
      out.label = isUsefulString(manufacturer) ? `${manufacturer} ${model}` : model;
    }
    if (typeof deviceId === 'string') {
      out.deviceId = deviceId;
    }
  } catch {
    // react-native-device-info not installed — identity stays partial
  }

  return out;
};

export class McpClient {
  private static instance: McpClient | null = null;

  private connection: McpConnection;
  private debug = false;
  private identity: ClientIdentity;
  private moduleRunner = new ModuleRunner();

  private constructor(url: string, identity: ClientIdentity) {
    this.identity = identity;
    this.connection = new McpConnection(url);

    this.connection.onOpen(() => {
      this.log('🚀 Connected to MCP server 🚀');
      this.sendRegistration();
    });

    this.connection.onMessage((message: ToolRequest) => {
      if (message.type === 'tool_request') {
        this.log(`${ARROW_IN} ${formatTool(message.module, message.method)}`, message.args);
        this.moduleRunner
          .handleRequest(message)
          .then((result) => {
            this.log(`${ARROW_OUT} ${formatTool(message.module, message.method)}`, result);
            this.connection.send({
              id: message.id,
              result,
              type: 'tool_response',
            });
          })
          .catch((error: Error) => {
            this.log(`${CROSS} ${formatTool(message.module, message.method)}`, error.message);
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

  static initialize(options?: {
    appName?: string;
    appVersion?: string;
    debug?: boolean;
    deviceId?: string;
    host?: string;
    label?: string;
    platform?: string;
    port?: number;
  }): McpClient {
    if (McpClient.instance) {
      if (options?.debug !== undefined) {
        McpClient.instance.debug = options.debug;
      }
      return McpClient.instance;
    }

    const host = options?.host ?? 'localhost';
    const port = options?.port ?? DEFAULT_PORT;

    const auto = autoDetectIdentity();
    const identity: ClientIdentity = {
      appName: options?.appName ?? auto.appName,
      appVersion: options?.appVersion ?? auto.appVersion,
      deviceId: options?.deviceId ?? auto.deviceId,
      label: options?.label ?? auto.label,
      platform: options?.platform ?? auto.platform,
    };

    McpClient.instance = new McpClient(`ws://${host}:${port}`, identity);
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
    this.log(`Registering module: ${colorModule(module.name)}`, Object.keys(module.tools));
    this.moduleRunner.registerModules([module]);
    this.sendRegistration();
  }

  registerModules(modules: McpModule[]): void {
    this.log(
      'Registering modules: ' +
        modules
          .map((m) => {
            return colorModule(m.name);
          })
          .join(', ')
    );
    this.moduleRunner.registerModules(modules);
    this.sendRegistration();
  }

  registerTool(name: string, tool: ToolHandler): void {
    this.log(`Registering dynamic tool: ${BOLD}${name}${RESET}`);
    this.moduleRunner.registerDynamicTool(name, tool);
    this.connection.send({
      module: `${MODULE_SEPARATOR}dynamic`,
      tool: {
        description: tool.description,
        inputSchema: tool.inputSchema,
        name,
      },
      type: 'tool_register',
    });
  }

  removeState(key: string): void {
    this.log(`Removing state: ${BOLD}${key}${RESET}`);
    this.connection.send({
      key,
      type: 'state_remove',
    });
  }

  setState(key: string, value: unknown): void {
    this.log(`Setting state: ${BOLD}${key}${RESET}`, value);
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
      module: `${MODULE_SEPARATOR}dynamic`,
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
      'Sending registration:\n ' +
        descriptors
          .map((m) => {
            return `${colorModule(m.name.padEnd(12))} ${m.tools.length} tools`;
          })
          .join('\n ')
    );
    this.connection.send({
      appName: this.identity.appName,
      appVersion: this.identity.appVersion,
      deviceId: this.identity.deviceId,
      label: this.identity.label,
      modules: descriptors,
      platform: this.identity.platform,
      type: 'registration',
    });
  }
}
