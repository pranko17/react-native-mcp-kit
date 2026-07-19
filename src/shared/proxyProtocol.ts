/**
 * Wire protocol between a session proxy (the stdio MCP process Claude Code
 * spawns per session) and the shared daemon that owns the bridge, the tool
 * registry, and all app state. Rides the same TCP port as the app bridge —
 * proxy connections are distinguished by the WebSocket upgrade path
 * (`PROXY_PATH`); RN apps connect to the root path.
 *
 * Versioning: the daemon reports its npm package version in `proxy_hello`.
 * Proxy and daemon must run the exact same installed version — they ship in
 * one package, so a mismatch means two different installs are alive (e.g. a
 * daemon from a stale checkout). The proxy refuses to serve mismatched
 * catalogs and tells the user how to recover.
 */

export const PROXY_PATH = '/mcp-proxy';

/** Tool descriptor as served to MCP `tools/list` — inputSchema is JSON Schema. */
export interface WireToolDescriptor {
  description: string;
  inputSchema: Record<string, unknown>;
  name: string;
  annotations?: Record<string, unknown>;
}

/** One MCP content block (text or image) — mirrored from the MCP shape. */
export type WireContentBlock = Record<string, unknown>;

export interface WireCallResult {
  content: WireContentBlock[];
  /**
   * Argument-validation failure — fronts surface it as an in-band
   * `isError: true` text result, matching what the high-level SDK produced
   * when it owned validation.
   */
  invalidParams?: string;
  isError?: boolean;
  /**
   * The tool is not in the registry — fronts re-raise as an MCP
   * MethodNotFound protocol error, matching SDK behavior for unknown tools.
   */
  unknownTool?: string;
}

// === Daemon → proxy ===

export interface ProxyHelloMessage {
  packageVersion: string;
  pid: number;
  type: 'proxy_hello';
}

export interface ProxyListToolsResponse {
  id: string;
  tools: WireToolDescriptor[];
  type: 'list_tools_result';
}

export interface ProxyCallToolResponse {
  id: string;
  result: WireCallResult;
  type: 'call_tool_result';
}

/** Pushed on every coalesced registry change; the proxy forwards it to its
 * host as `notifications/tools/list_changed`. */
export interface ProxyToolsChangedMessage {
  type: 'tools_changed';
}

export type ProxyServerMessage =
  ProxyCallToolResponse | ProxyHelloMessage | ProxyListToolsResponse | ProxyToolsChangedMessage;

// === Proxy → daemon ===

export interface ProxyListToolsRequest {
  id: string;
  type: 'list_tools';
}

export interface ProxyCallToolRequest {
  id: string;
  name: string;
  type: 'call_tool';
  args?: Record<string, unknown>;
}

export type ProxyClientMessage = ProxyCallToolRequest | ProxyListToolsRequest;
