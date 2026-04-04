import { type McpModule } from '@/client/models/types';

import { type ConsoleModuleOptions, type LogEntry, type LogLevel } from './types';

const ALL_LEVELS: LogLevel[] = ['debug', 'error', 'info', 'log', 'warn'];
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_STACK_LEVELS: LogLevel[] = ['error', 'warn'];

const serializeArg = (arg: unknown, seen = new WeakSet<object>()): unknown => {
  if (arg === null || arg === undefined) return arg;

  if (typeof arg === 'function') {
    return `[Function: ${arg.name || 'anonymous'}]`;
  }

  if (typeof arg === 'symbol') {
    return arg.toString();
  }

  if (typeof arg !== 'object') return arg;

  if (arg instanceof Error) {
    return {
      message: arg.message,
      name: arg.name,
      stack: arg.stack,
    };
  }

  if (arg instanceof Date) {
    return arg.toISOString();
  }

  if (arg instanceof RegExp) {
    return arg.toString();
  }

  if (seen.has(arg)) {
    return '[Circular]';
  }
  seen.add(arg);

  if (Array.isArray(arg)) {
    return arg.map((item) => {
      return serializeArg(item, seen);
    });
  }

  const className = arg.constructor?.name;
  const serialized: Record<string, unknown> = {};

  if (className && className !== 'Object') {
    serialized.__class = className;
  }

  for (const key of Object.keys(arg)) {
    serialized[key] = serializeArg((arg as Record<string, unknown>)[key], seen);
  }

  return serialized;
};

const captureStack = (): string | undefined => {
  const stack = new Error().stack;
  if (!stack) return undefined;
  const lines = stack.split('\n');
  // Remove Error, captureStack, addEntry, console[level] wrapper frames
  return lines.slice(4).join('\n');
};

export const consoleModule = (options?: ConsoleModuleOptions): McpModule => {
  const levels = options?.levels ?? ALL_LEVELS;
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;

  const stackTraceLevels: LogLevel[] =
    options?.stackTrace === true
      ? ALL_LEVELS
      : Array.isArray(options?.stackTrace)
        ? options.stackTrace
        : options?.stackTrace === false
          ? []
          : DEFAULT_STACK_LEVELS;

  const buffer: LogEntry[] = [];
  const originals = new Map<LogLevel, (...args: unknown[]) => void>();

  const addEntry = (level: LogLevel, args: unknown[]) => {
    const entry: LogEntry = {
      args: args.map((arg) => {
        return serializeArg(arg);
      }),
      level,
      timestamp: new Date().toISOString(),
    };

    if (stackTraceLevels.includes(level)) {
      entry.stack = captureStack();
    }

    buffer.push(entry);
    if (buffer.length > maxEntries) {
      buffer.splice(0, buffer.length - maxEntries);
    }
  };

  for (const level of levels) {
    const original = console[level];
    originals.set(level, original);
    console[level] = (...args: unknown[]) => {
      addEntry(level, args);
      original.apply(console, args);
    };
  }

  const filterByLevel = (level: LogLevel, limit?: number) => {
    const filtered = buffer.filter((entry) => {
      return entry.level === level;
    });
    if (limit) {
      return filtered.slice(-limit);
    }
    return filtered;
  };

  return {
    name: 'console',
    tools: {
      clear_logs: {
        description: 'Clear all console log entries from the buffer',
        handler: () => {
          buffer.length = 0;
          return { success: true };
        },
      },
      get_debug: {
        description: 'Get console.debug entries',
        handler: (args) => {
          return filterByLevel('debug', args.limit as number | undefined);
        },
        inputSchema: {
          limit: { description: 'Max number of entries to return', type: 'number' },
        },
      },
      get_errors: {
        description: 'Get console.error entries',
        handler: (args) => {
          return filterByLevel('error', args.limit as number | undefined);
        },
        inputSchema: {
          limit: { description: 'Max number of entries to return', type: 'number' },
        },
      },
      get_info: {
        description: 'Get console.info entries',
        handler: (args) => {
          return filterByLevel('info', args.limit as number | undefined);
        },
        inputSchema: {
          limit: { description: 'Max number of entries to return', type: 'number' },
        },
      },
      get_logs: {
        description: 'Get all console log entries. Optionally filter by level and limit.',
        handler: (args) => {
          let result = [...buffer];
          if (args.level) {
            result = result.filter((entry) => {
              return entry.level === (args.level as LogLevel);
            });
          }
          if (args.limit) {
            result = result.slice(-(args.limit as number));
          }
          return result;
        },
        inputSchema: {
          level: {
            description: 'Filter by log level (log, warn, error, info, debug)',
            type: 'string',
          },
          limit: { description: 'Max number of entries to return', type: 'number' },
        },
      },
      get_warnings: {
        description: 'Get console.warn entries',
        handler: (args) => {
          return filterByLevel('warn', args.limit as number | undefined);
        },
        inputSchema: {
          limit: { description: 'Max number of entries to return', type: 'number' },
        },
      },
    },
  };
};
