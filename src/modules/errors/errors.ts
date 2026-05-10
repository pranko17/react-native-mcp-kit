import { type McpModule } from '@/client/models/types';
import {
  applyProjection,
  makeProjectionSchema,
  projectAsValue,
  type ProjectionArgs,
} from '@/shared/projectValue';

import {
  type ErrorEntry,
  type ErrorSource,
  type ErrorsModuleOptions,
  type StackFrame,
} from './types';

const DEFAULT_MAX_ENTRIES = 50;

// Default depth 4 — top is array of entries, level 2 expands each entry
// (id/isFatal/message/source/timestamp inline, stack/stackFrames still
// markers), level 3 opens stackFrames (each frame as `${obj}` marker),
// level 4 opens each frame (file/line/method/column inline). Long `stack`
// string auto-wraps in `${str}` regardless. Drill deeper via path.
const ERRORS_DEFAULT_DEPTH = 4;

const PROJECTION_SCHEMA = makeProjectionSchema(ERRORS_DEFAULT_DEPTH);

// Match both the V8 `    at method (file:line:col)` and Hermes / JSC
// `method@file:line:col` stack formats. Keep parsing lightweight — full
// symbolication lives in metro__symbolicate so the agent can resolve frames
// back to source paths against Metro's sourcemaps on demand.
const parseStack = (stack: string | undefined): StackFrame[] | undefined => {
  if (!stack) return undefined;
  const frames: StackFrame[] = [];

  const v8Regex = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = v8Regex.exec(stack)) !== null) {
    frames.push({
      column: Number.parseInt(match[4]!, 10),
      file: match[2]!,
      lineNumber: Number.parseInt(match[3]!, 10),
      methodName: match[1]?.trim() || undefined,
    });
  }
  if (frames.length > 0) return frames;

  const hermesRegex = /^(.*?)@(.+?):(\d+):(\d+)$/gm;
  while ((match = hermesRegex.exec(stack)) !== null) {
    frames.push({
      column: Number.parseInt(match[4]!, 10),
      file: match[2]!,
      lineNumber: Number.parseInt(match[3]!, 10),
      methodName: match[1]?.trim() || undefined,
    });
  }
  return frames.length > 0 ? frames : undefined;
};

// === Module-level capture state — auto-starts at import time. ===
//
// Critical for cold-start: a fatal error during bundle evaluation or first
// render would otherwise be invisible because McpProvider's useEffect runs
// after React has already chosen whether to show the red box. Patching at
// import time makes early crashes recoverable for the agent.

const buffer: ErrorEntry[] = [];
let maxEntries = DEFAULT_MAX_ENTRIES;
let nextId = 1;

const addEntry = (entry: Omit<ErrorEntry, 'id'>): void => {
  // Deduplicate by message + timestamp proximity (within 100ms).
  const lastEntry = buffer[buffer.length - 1];
  if (lastEntry && lastEntry.message === entry.message) {
    const timeDiff = new Date(entry.timestamp).getTime() - new Date(lastEntry.timestamp).getTime();
    if (Math.abs(timeDiff) < 100) return;
  }

  buffer.push({ ...entry, id: nextId++ });
  if (buffer.length > maxEntries) {
    buffer.splice(0, buffer.length - maxEntries);
  }
};

let patchesInstalled = false;
const installPatches = (): void => {
  if (patchesInstalled) return;
  patchesInstalled = true;

  // 1. Intercept ErrorUtils global handler (catches fatal JS errors).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ErrorUtilsGlobal = (global as any).ErrorUtils;
  if (ErrorUtilsGlobal) {
    const originalHandler = ErrorUtilsGlobal.getGlobalHandler();
    ErrorUtilsGlobal.setGlobalHandler((error: Error, isFatal: boolean) => {
      const source: ErrorSource = error.message?.includes('in promise') ? 'promise' : 'global';
      addEntry({
        isFatal,
        message: error.message,
        source,
        stack: error.stack,
        stackFrames: parseStack(error.stack),
        timestamp: new Date().toISOString(),
      });
      if (originalHandler) {
        originalHandler(error, isFatal);
      }
    });
  }

  // 2. Intercept console.error to catch promise rejections reported by RN.
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    const firstArg = args[0];

    // RN reports unhandled promise rejections as console.error with an Error object.
    if (firstArg && typeof firstArg === 'object' && 'message' in firstArg) {
      const error = firstArg as { message?: string; name?: string; stack?: string };
      if (error.message?.includes('in promise')) {
        addEntry({
          isFatal: false,
          message: error.message,
          source: 'promise',
          stack: error.stack,
          stackFrames: parseStack(error.stack),
          timestamp: new Date().toISOString(),
        });
      }
    }

    originalConsoleError.apply(console, args);
  };
};

installPatches();

const project = (entries: ErrorEntry[], args: ProjectionArgs): unknown => {
  return applyProjection(entries, args, projectAsValue, ERRORS_DEFAULT_DEPTH);
};

export const errorsModule = (options?: ErrorsModuleOptions): McpModule => {
  if (typeof options?.maxEntries === 'number') {
    maxEntries = options.maxEntries;
    if (buffer.length > maxEntries) {
      buffer.splice(0, buffer.length - maxEntries);
    }
  }

  return {
    description: `Unhandled JS errors + promise rejections, with stack traces.

Captures via ErrorUtils.setGlobalHandler + console.error sniffing.
Deduplicates within a 100ms window. Capture starts at module-import
time so early fatal crashes are visible. Each entry carries a monotonic
numeric \`id\`, parsed \`stackFrames\` (V8 + Hermes formats, ready for
metro__symbolicate), and the raw \`stack\` string. Listing tools accept
path / depth / maxBytes (default depth ${ERRORS_DEFAULT_DEPTH}). Buffer size configurable via
errorsModule options.`,
    name: 'errors',
    tools: {
      clear_errors: {
        description: 'Clear the error buffer.',
        handler: () => {
          buffer.length = 0;
          return { success: true };
        },
      },
      get_errors: {
        description:
          'Captured errors; filterable by source / fatal / time range. Use `metro__symbolicate` on stackFrames to resolve bundled paths back to source.',
        handler: (args) => {
          let result = [...buffer];
          if (args.source) {
            result = result.filter((e) => {
              return e.source === (args.source as string);
            });
          }
          if (typeof args.fatal === 'boolean') {
            result = result.filter((e) => {
              return e.isFatal === args.fatal;
            });
          }
          if (typeof args.since === 'string') {
            const sinceMs = Date.parse(args.since);
            if (Number.isFinite(sinceMs)) {
              result = result.filter((e) => {
                return Date.parse(e.timestamp) >= sinceMs;
              });
            }
          }
          if (typeof args.until === 'string') {
            const untilMs = Date.parse(args.until);
            if (Number.isFinite(untilMs)) {
              result = result.filter((e) => {
                return Date.parse(e.timestamp) <= untilMs;
              });
            }
          }
          return project(result, args as ProjectionArgs);
        },
        inputSchema: {
          ...PROJECTION_SCHEMA,
          fatal: { description: 'Filter by fatal flag.', type: 'boolean' },
          since: {
            description: 'ISO timestamp — only entries at or after this point.',
            examples: ['2026-04-19T22:00:00.000Z'],
            type: 'string',
          },
          source: {
            description: 'Filter by source.',
            examples: ['global', 'promise'],
            type: 'string',
          },
          until: {
            description: 'ISO timestamp — only entries at or before this point.',
            type: 'string',
          },
        },
      },
      get_fatal: {
        description: 'Fatal errors only.',
        handler: (args) => {
          const result = buffer.filter((e) => {
            return e.isFatal;
          });
          return project(result, args as ProjectionArgs);
        },
        inputSchema: PROJECTION_SCHEMA,
      },
      get_stats: {
        description: 'Error counts — total, by source, fatal.',
        handler: () => {
          return {
            bySource: {
              global: buffer.filter((e) => {
                return e.source === 'global';
              }).length,
              promise: buffer.filter((e) => {
                return e.source === 'promise';
              }).length,
            },
            fatal: buffer.filter((e) => {
              return e.isFatal;
            }).length,
            total: buffer.length,
          };
        },
      },
    },
  };
};
