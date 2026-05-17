import { type McpModule, type ToolHandler } from '@/client/models/types';
import { McpConnection } from '@/client/utils/connection';
import { ModuleRunner } from '@/client/utils/moduleRunner';
import {
  DEFAULT_PORT,
  type DevServerInfo,
  MODULE_SEPARATOR,
  PROTOCOL_VERSION,
  type ServerMessage,
  type ToolRequest,
} from '@/shared/protocol';
import { loadRN, loadRNInternal } from '@/shared/rn/core';
import { callDI, loadDeviceInfo } from '@/shared/rn/deviceInfo';

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
  bundleId?: string;
  devServer?: DevServerInfo;
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

// RN ships `getDevServer()` which reads NativeSourceCode.scriptURL — this is
// the actual Metro origin the bundle was loaded from. In production builds the
// script URL is a local file and `bundleLoadedFromServer` is false; we skip
// the field in that case so Metro-facing tools fail fast.
const detectDevServer = (): DevServerInfo | undefined => {
  const getDevServer = loadRNInternal('Libraries/Core/Devtools/getDevServer') as
    | (() => { bundleLoadedFromServer: boolean; url: string })
    | null;
  if (typeof getDevServer !== 'function') return undefined;
  try {
    const info = getDevServer();
    if (!info.bundleLoadedFromServer || typeof info.url !== 'string') {
      return undefined;
    }
    const url = info.url.replace(/\/$/, '');
    const parsed = new URL(url);
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    return {
      bundleLoadedFromServer: true,
      host: parsed.hostname,
      port,
      url,
    };
  } catch {
    return undefined;
  }
};

const autoDetectIdentity = (): ClientIdentity => {
  const out: ClientIdentity = {};

  // RN is optional at this layer — SDK / tests may pull this module without
  // a React Native runtime. Skip the platform field rather than throwing.
  const RN = loadRN();
  if (RN) {
    const os = RN.Platform?.OS;
    if (typeof os === 'string') {
      out.platform = os;
    }
  }

  const devServer = detectDevServer();
  if (devServer) {
    out.devServer = devServer;
  }

  // react-native-device-info is optional. When absent the identity stays
  // partial (just platform + devServer) — both the handshake and the
  // device module tolerate the missing package the same way.
  const DI = loadDeviceInfo();
  if (DI) {
    const appName = callDI<string>(DI.getApplicationName);
    const appVersion = callDI<string>(DI.getVersion);
    const bundleId = callDI<string>(DI.getBundleId) ?? callDI<string>(DI.getBundleIdSync);
    const rawDeviceName = callDI<string>(DI.getDeviceNameSync);
    const model = callDI<string>(DI.getModel);
    const manufacturer = callDI<string>(DI.getManufacturerSync) ?? callDI<string>(DI.getBrand);
    const deviceId = callDI<string>(DI.getUniqueIdSync);

    if (typeof appName === 'string') out.appName = appName;
    if (typeof appVersion === 'string') out.appVersion = appVersion;
    if (typeof bundleId === 'string') out.bundleId = bundleId;
    if (isUsefulString(rawDeviceName)) {
      out.label = rawDeviceName;
    } else if (isUsefulString(model)) {
      out.label = isUsefulString(manufacturer) ? `${manufacturer} ${model}` : model;
    }
    if (typeof deviceId === 'string') out.deviceId = deviceId;
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

    this.connection.onMessage((message: ServerMessage) => {
      switch (message.type) {
        case 'server_hello':
          if (message.protocolVersion !== PROTOCOL_VERSION) {
            console.error(
              `${TAG} Protocol version mismatch — server ${message.protocolVersion}, client ${PROTOCOL_VERSION}. Update the mcp-kit package on one side so they line up; disconnecting.`
            );
            this.connection.stopReconnect();
            this.connection.dispose();
            return;
          }
          this.log(`Server hello — protocol v${message.protocolVersion}`);
          break;

        case 'version_mismatch':
          console.error(
            `${TAG} Server rejected connection: ${message.reason} (server protocol v${message.serverVersion}, client protocol v${PROTOCOL_VERSION}). Not reconnecting.`
          );
          this.connection.stopReconnect();
          break;

        case 'tool_request':
          this.handleToolRequest(message);
          break;
      }
    });

    this.connection.connect();
  }

  private handleToolRequest(message: ToolRequest): void {
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

  static initialize(options?: {
    appName?: string;
    appVersion?: string;
    bundleId?: string;
    debug?: boolean;
    devServer?: DevServerInfo;
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

    const auto = autoDetectIdentity();
    // Default the WS host to whatever origin the bundle was loaded from. On
    // a simulator/emulator that's `localhost` (same as before). On a physical
    // iOS device over Wi-Fi it's the Mac's LAN IP — the device can reach the
    // MCP server without any extra port-forwarding because the WebSocket
    // server already binds to 0.0.0.0. On Android over `adb reverse` it
    // resolves to `localhost`, which the user must mirror with
    // `adb reverse tcp:<port> tcp:<port>` for the MCP port. Production
    // bundles return undefined here, so we fall back to `localhost` and the
    // connect attempt simply no-ops.
    const host = options?.host ?? auto.devServer?.host ?? 'localhost';
    const port = options?.port ?? DEFAULT_PORT;

    const identity: ClientIdentity = {
      appName: options?.appName ?? auto.appName,
      appVersion: options?.appVersion ?? auto.appVersion,
      bundleId: options?.bundleId ?? auto.bundleId,
      devServer: options?.devServer ?? auto.devServer,
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
      bundleId: this.identity.bundleId,
      devServer: this.identity.devServer,
      deviceId: this.identity.deviceId,
      label: this.identity.label,
      modules: descriptors,
      platform: this.identity.platform,
      protocolVersion: PROTOCOL_VERSION,
      type: 'registration',
    });
  }
}
