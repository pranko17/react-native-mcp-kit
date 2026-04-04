// Client (safe for React Native)
export {
  McpClient,
  McpContext,
  McpProvider,
  useMcpModule,
  useMcpState,
  useMcpTool,
} from './client/index';
export {
  type McpContextValue,
  type McpModule,
  type McpProviderProps,
  type ToolHandler,
} from './client/index';

// Modules (safe for React Native)
export { consoleModule, deviceModule, navigationModule, networkModule } from './modules/index';

// Protocol types
export {
  type ClientMessage,
  type ModuleDescriptor,
  type ModuleToolDescriptor,
  type RegistrationMessage,
  type ServerMessage,
  type StateRemoveMessage,
  type StateUpdateMessage,
  type ToolRegisterMessage,
  type ToolRequest,
  type ToolResponse,
  type ToolUnregisterMessage,
} from './shared/protocol';
