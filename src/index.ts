// Client (safe for React Native)
export { McpContext, McpProvider, useMcpState, useMcpTool } from './client/index';
export type { McpContextValue, McpModule, McpProviderProps, ToolHandler } from './client/index';

// Modules (safe for React Native)
export { navigationModule } from './modules/index';

// Protocol types
export type {
  ClientMessage,
  ModuleDescriptor,
  ModuleToolDescriptor,
  RegistrationMessage,
  ServerMessage,
  StateRemoveMessage,
  StateUpdateMessage,
  ToolRegisterMessage,
  ToolRequest,
  ToolResponse,
  ToolUnregisterMessage,
} from './shared/protocol';
