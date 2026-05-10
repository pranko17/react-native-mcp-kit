/** npm package name. Single source of truth for the server identity reported
 * in the MCP handshake (`mcpServer.ts`) and for the default `import` source
 * the strip babel plugin recognises (`stripPlugin.ts`). */
export const PACKAGE_NAME = 'react-native-mcp-kit';

/** Default WebSocket port the bridge listens on and the RN client connects to.
 * Used by the server (`createServer`) and the client (`McpClient.initialize`)
 * — they must agree, hence shared. */
export const DEFAULT_PORT = 8347;

/** Separator between module name and tool name in MCP call format */
export const MODULE_SEPARATOR = '__';

/** Prefix for dynamic tools registered via useMcpTool */
export const DYNAMIC_PREFIX = `${MODULE_SEPARATOR}dynamic${MODULE_SEPARATOR}`;

/**
 * Wire-protocol version. Bumped on any breaking change to the messages below.
 * Independent of the npm package semver — a major package release does not
 * imply a protocol bump, and a protocol bump does not imply a new major.
 *
 * Introduced in package v2.0.0. Older clients/servers don't send or expect a
 * version field; the handshake treats their absence as an incompatibility.
 */
export const PROTOCOL_VERSION = 1;

/** WebSocket close code used when the server refuses the client over protocol mismatch. */
export const WS_CLOSE_PROTOCOL_MISMATCH = 4010;

// === RN App → Server: registers modules on connection ===

export interface ModuleToolDescriptor {
  description: string;
  name: string;
  inputSchema?: Record<string, unknown>;
  timeout?: number;
}

export interface ModuleDescriptor {
  name: string;
  tools: ModuleToolDescriptor[];
  description?: string;
}

/**
 * Metro dev-server origin the app was loaded from, detected in the client via
 * `getDevServer()` (`react-native/Libraries/Core/Devtools/getDevServer`).
 * Absent in production builds (where the bundle is loaded from disk) and when
 * detection fails. Server-side `metro__*` tools (symbolicate, reload, etc.)
 * use this instead of hardcoding `localhost:8081`.
 */
export interface DevServerInfo {
  bundleLoadedFromServer: boolean;
  host: string;
  port: number;
  url: string;
}

export interface RegistrationMessage {
  modules: ModuleDescriptor[];
  protocolVersion: number;
  type: 'registration';
  appName?: string;
  appVersion?: string;
  bundleId?: string;
  devServer?: DevServerInfo;
  deviceId?: string;
  label?: string;
  platform?: string;
}

// === Server → RN App: handshake ===

/**
 * Server sends this immediately after accepting a WebSocket connection, before
 * expecting any registration. A client whose PROTOCOL_VERSION doesn't match the
 * server's must disconnect and surface a clear error to the developer.
 */
export interface ServerHelloMessage {
  protocolVersion: number;
  type: 'server_hello';
}

/**
 * Server sends this when a client's registration is rejected over protocol
 * incompatibility (missing or mismatched protocolVersion). Always followed by
 * a WS close with code WS_CLOSE_PROTOCOL_MISMATCH.
 */
export interface VersionMismatchMessage {
  reason: string;
  serverVersion: number;
  type: 'version_mismatch';
  clientVersion?: number;
}

// === Server → RN App: tool invocation ===

export interface ToolRequest {
  args: Record<string, unknown>;
  id: string;
  method: string;
  module: string;
  type: 'tool_request';
}

// === RN App → Server: tool result ===

export interface ToolResponse {
  id: string;
  type: 'tool_response';
  error?: string;
  result?: unknown;
}

// === RN App → Server: dynamic tool registration (from useMcpTool) ===

export interface ToolRegisterMessage {
  module: string;
  tool: ModuleToolDescriptor;
  type: 'tool_register';
}

export interface ToolUnregisterMessage {
  module: string;
  toolName: string;
  type: 'tool_unregister';
}

// === Union types ===

export type ClientMessage =
  | RegistrationMessage
  | ToolRegisterMessage
  | ToolResponse
  | ToolUnregisterMessage;

export type ServerMessage = ServerHelloMessage | ToolRequest | VersionMismatchMessage;
