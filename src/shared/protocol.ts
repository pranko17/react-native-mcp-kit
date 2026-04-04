// === RN App → Server: при подключении регистрирует модули ===

export interface ModuleToolDescriptor {
  description: string;
  inputSchema?: Record<string, unknown>;
  name: string;
}

export interface ModuleDescriptor {
  name: string;
  tools: ModuleToolDescriptor[];
}

export interface RegistrationMessage {
  modules: ModuleDescriptor[];
  type: 'registration';
}

// === Server → RN App: вызов tool ===

export interface ToolRequest {
  args: Record<string, unknown>;
  id: string;
  method: string;
  module: string;
  type: 'tool_request';
}

// === RN App → Server: результат ===

export interface ToolResponse {
  error?: string;
  id: string;
  result?: unknown;
  type: 'tool_response';
}

// === RN App → Server: state updates (от useMcpState) ===

export interface StateUpdateMessage {
  key: string;
  type: 'state_update';
  value: unknown;
}

export interface StateRemoveMessage {
  key: string;
  type: 'state_remove';
}

// === RN App → Server: динамическая регистрация tool (от useMcpTool) ===

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
  | StateRemoveMessage
  | StateUpdateMessage
  | ToolRegisterMessage
  | ToolResponse
  | ToolUnregisterMessage;

export type ServerMessage = ToolRequest;
