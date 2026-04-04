import type { ModuleDescriptor, ModuleToolDescriptor } from '../shared/protocol';

export interface BridgeEvents {
  onRegistration: (modules: ModuleDescriptor[]) => void;
  onStateRemove: (key: string) => void;
  onStateUpdate: (key: string, value: unknown) => void;
  onToolRegister: (module: string, tool: ModuleToolDescriptor) => void;
  onToolUnregister: (module: string, toolName: string) => void;
}

export interface ServerConfig {
  port?: number;
}
