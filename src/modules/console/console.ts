import { type McpModule } from '@/client/models/types';
import {
  applyProjection,
  makeProjectionSchema,
  projectAsValue,
  type ProjectionArgs,
} from '@/shared/projection/projectValue';

import { type ConsoleModuleOptions, type LogEntry, type LogLevel } from './types';

const ALL_LEVELS: LogLevel[] = ['debug', 'error', 'info', 'log', 'warn'];
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_STACK_LEVELS: LogLevel[] = ['error', 'warn'];

// Default depth 3 — top level is array of entries, level 2 expands each
// entry (id/level/timestamp inline, args/stack still markers), level 3
// opens the args array (primitive args inline, nested objects → ${obj}
// markers). Drill deeper via `path` or bump `depth`.
const CONSOLE_DEFAULT_DEPTH = 3;

const PROJECTION_SCHEMA = makeProjectionSchema(CONSOLE_DEFAULT_DEPTH);

const captureStack = (): string | undefined => {
  const stack = new Error().stack;
  if (!stack) return undefined;
  const lines = stack.split('\n');
  // Remove Error, captureStack, addEntry, console[level] wrapper frames
  return lines.slice(4).join('\n');
};

// === Module-level capture state — auto-starts at import time. ===
//
// Rationale: when `McpProvider` mounts, its `useEffect` runs after React's
// first render — any console.log fired during bundle evaluation or the first
// render would be lost. Patching at module import time (before React boots)
// closes that gap. The factory below adopts the pre-existing buffer and
// applies caller-supplied options retroactively.

const buffer: LogEntry[] = [];
let nextId = 1;
let maxEntries = DEFAULT_MAX_ENTRIES;
let capturedLevels = new Set<LogLevel>(ALL_LEVELS);
let stackLevels = new Set<LogLevel>(DEFAULT_STACK_LEVELS);

const addEntry = (level: LogLevel, args: unknown[]): void => {
  if (!capturedLevels.has(level)) return;
  // Args are stored RAW (no per-arg serializer). Projection — depth walk,
  // marker collapse, cycle / class detection, redaction — runs at query
  // time via the shared `projectValue`. This keeps cold-start capture
  // cheap and lets the agent drill any path / depth at query time.
  const entry: LogEntry = {
    args,
    id: nextId++,
    level,
    timestamp: new Date().toISOString(),
  };
  if (stackLevels.has(level)) {
    entry.stack = captureStack();
  }
  buffer.push(entry);
  if (buffer.length > maxEntries) {
    buffer.splice(0, buffer.length - maxEntries);
  }
};

let patchesInstalled = false;
const installPatches = (): void => {
  if (patchesInstalled) return;
  patchesInstalled = true;
  for (const level of ALL_LEVELS) {
    const original = console[level];
    console[level] = (...args: unknown[]) => {
      addEntry(level, args);
      original.apply(console, args);
    };
  }
};

installPatches();

const project = (entries: LogEntry[], args: ProjectionArgs): unknown => {
  return applyProjection(entries, args, projectAsValue, CONSOLE_DEFAULT_DEPTH);
};

const filterByLevel = (level: LogLevel): LogEntry[] => {
  return buffer.filter((entry) => {
    return entry.level === level;
  });
};

export const consoleModule = (options?: ConsoleModuleOptions): McpModule => {
  // Apply options retroactively to the already-running buffer.
  if (typeof options?.maxEntries === 'number') {
    maxEntries = options.maxEntries;
    if (buffer.length > maxEntries) {
      buffer.splice(0, buffer.length - maxEntries);
    }
  }
  if (options?.levels) {
    capturedLevels = new Set(options.levels);
  }
  if (options?.stackTrace === true) {
    stackLevels = new Set(ALL_LEVELS);
  } else if (options?.stackTrace === false) {
    stackLevels = new Set();
  } else if (Array.isArray(options?.stackTrace)) {
    stackLevels = new Set(options.stackTrace);
  }

  return {
    description: `Ring buffer of console.log/warn/error/info/debug.

Each entry carries a monotonic numeric \`id\`. Args are stored raw; the
shared projection runs at query time. Stack traces captured per level
(default error+warn). Listing tools accept path / depth / maxBytes
(default depth ${CONSOLE_DEFAULT_DEPTH}). Capture starts at module-import time so cold-start
logs are not lost. Buffer size and captured levels are configurable via
consoleModule options.`,
    name: 'console',
    tools: {
      clear_logs: {
        description: 'Clear the log buffer.',
        handler: () => {
          buffer.length = 0;
          return { success: true };
        },
      },
      get_logs: {
        description: 'Return log entries, optionally filtered by level.',
        handler: (args) => {
          const level = typeof args.level === 'string' ? (args.level as LogLevel) : undefined;
          const result = level ? filterByLevel(level) : buffer;
          return project(result, args as ProjectionArgs);
        },
        inputSchema: {
          ...PROJECTION_SCHEMA,
          level: {
            description: 'Filter by level. Omit for all levels.',
            examples: ['log', 'warn', 'error', 'info', 'debug'],
            type: 'string',
          },
        },
      },
    },
  };
};
