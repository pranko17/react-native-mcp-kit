export type LogLevel = 'debug' | 'error' | 'info' | 'log' | 'warn';

export interface LogEntry {
  args: unknown[];
  level: LogLevel;
  timestamp: string;
  stack?: string;
}

export interface ConsoleModuleOptions {
  levels?: LogLevel[];
  maxEntries?: number;
  stackTrace?: boolean | LogLevel[];
}
