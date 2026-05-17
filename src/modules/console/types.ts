export type LogLevel =
  | 'debug'
  | 'error'
  | 'group'
  | 'groupCollapsed'
  | 'groupEnd'
  | 'info'
  | 'log'
  | 'trace'
  | 'warn';

export interface LogEntry {
  args: unknown[];
  id: number;
  level: LogLevel;
  timestamp: string;
  stack?: string;
}

export interface ConsoleModuleOptions {
  levels?: LogLevel[];
  maxEntries?: number;
  stackTrace?: boolean | LogLevel[];
}
