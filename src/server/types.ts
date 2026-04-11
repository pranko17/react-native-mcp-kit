import { type HostModule } from './host/types';

export interface ServerConfig {
  hostModules?: HostModule[];
  port?: number;
}
