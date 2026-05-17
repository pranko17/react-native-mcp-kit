import { type McpModule } from '@/client/models/types';
import {
  applyProjection,
  makeProjectionSchema,
  projectAsValue,
  type ProjectionArgs,
} from '@/shared/projection/projectValue';
import { getRN, loadRNInternal } from '@/shared/rn/core';

// Default depth 4 — array of rows (1) → row (2) → stack array (3) → frame
// (4, primitives inline). Long messages auto-wrap in `${str}` markers.
const LOGBOX_DEFAULT_DEPTH = 4;

const PROJECTION_SCHEMA = makeProjectionSchema(LOGBOX_DEFAULT_DEPTH);

// Minimal shape of a LogBoxLog row, keeping only fields useful to an agent.
interface SerializedLog {
  count: number;
  index: number;
  level: string;
  message: string;
  category?: string;
  stack?: Array<{ column?: number; file?: string; line?: number; method?: string }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LogBoxLog = any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LogBoxDataModule = any;

const REGEX_LITERAL = /^\/(.+)\/([gimsuy]*)$/;

const parsePattern = (raw: string): RegExp | string => {
  const m = raw.match(REGEX_LITERAL);
  if (!m) return raw;
  try {
    return new RegExp(m[1]!, m[2]);
  } catch {
    return raw;
  }
};

export const logBoxModule = (): McpModule => {
  const getLogBox = () => {
    return getRN().LogBox;
  };

  // LogBoxData is private. In dev it exposes getLogs/dismiss/etc; in release
  // it's stubbed, so every call is guarded with optional chaining.
  const getLogBoxData = (): LogBoxDataModule | null => {
    return loadRNInternal('Libraries/LogBox/Data/LogBoxData') as LogBoxDataModule | null;
  };

  const getLogsArray = (): LogBoxLog[] => {
    const logs = getLogBoxData()?.getLogs?.();
    if (!logs) return [];
    return Array.from(logs as Iterable<LogBoxLog>);
  };

  const serializeLog = (log: LogBoxLog, index: number): SerializedLog => {
    return {
      category: log.category,
      count: log.count ?? 1,
      index,
      level: log.level ?? 'warn',
      message: log.message?.content ?? String(log.message ?? ''),
      stack: Array.isArray(log.stack)
        ? log.stack.slice(0, 20).map((f: LogBoxLog) => {
            return {
              column: f.column,
              file: f.file,
              line: f.lineNumber,
              method: f.methodName,
            };
          })
        : undefined,
    };
  };

  return {
    description: `Inspect and control the React Native LogBox overlay.

Clear warning toasts that block the UI during tests, suppress noisy
warnings with ignore patterns, or mute LogBox entirely for a test run.
LogBox is a dev-only surface — in production these tools are no-ops.

\`get_logs\` accepts path / depth / maxBytes (default depth ${LOGBOX_DEFAULT_DEPTH}).

IGNORE PATTERNS
  Strings match as substrings. Wrap in /.../flags to use a RegExp,
  e.g. "/^Warning: /" or "/useNativeDriver/i".

LEVELS
  warn / error / fatal / syntax — clear({ level }) for surgical cleanup,
  or clear() for all.`,
    name: 'log_box',
    tools: {
      clear: {
        description:
          'Clear LogBox rows. Pass `level: "warn"` / `"error"` / `"syntax"` for surgical cleanup; omit `level` (or pass `"all"`) to clear every row.',
        handler: (args) => {
          const level = typeof args.level === 'string' ? args.level : undefined;
          const data = getLogBoxData();
          if (!level || level === 'all') {
            getLogBox()?.clearAllLogs?.();
          } else if (level === 'warn') {
            data?.clearWarnings?.();
          } else if (level === 'error') {
            data?.clearErrors?.();
          } else if (level === 'syntax') {
            data?.clearSyntaxErrors?.();
          } else {
            return { error: `Unknown level "${level}". Use "warn" / "error" / "syntax" / "all".` };
          }
          return { cleared: true, level: level ?? 'all' };
        },
        inputSchema: {
          level: {
            description: 'Optional level filter. Omit (or pass "all") to clear every row.',
            enum: ['all', 'warn', 'error', 'syntax'],
            type: 'string',
          },
        },
      },
      dismiss: {
        description: 'Dismiss a single row by index (from get_logs).',
        handler: (args) => {
          const data = getLogBoxData();
          if (!data?.dismiss) return { error: 'LogBoxData.dismiss unavailable' };
          const index = args.index as number;
          if (typeof index !== 'number' || index < 0) {
            return { error: 'index required (0-based).' };
          }
          const logs = getLogsArray();
          const log = logs[index];
          if (!log) return { error: `No row at index ${index} (have ${logs.length})` };
          data.dismiss(log);
          return { dismissed: index };
        },
        inputSchema: {
          index: {
            description: '0-based row index from get_logs.',
            minimum: 0,
            type: 'number',
          },
        },
      },
      get_logs: {
        description:
          'Current LogBox rows — { index, level, category, message, count, stack? }. Index feeds dismiss. Filter by level.',
        handler: (args) => {
          let rows = getLogsArray().map((log, i) => {
            return serializeLog(log, i);
          });
          if (typeof args.level === 'string') {
            const level = args.level;
            rows = rows.filter((r) => {
              return r.level === level;
            });
          }
          return applyProjection(
            rows,
            args as ProjectionArgs,
            projectAsValue,
            LOGBOX_DEFAULT_DEPTH
          );
        },
        inputSchema: {
          ...PROJECTION_SCHEMA,
          level: {
            description: 'Filter by level.',
            enum: ['warn', 'error', 'fatal', 'syntax'],
            type: 'string',
          },
        },
      },
      ignore: {
        description:
          'Add substring/regex patterns to the ignore list. Matching logs are hidden from LogBox but still print to the JS console.',
        handler: (args) => {
          const patterns = args.patterns as string[] | undefined;
          if (!Array.isArray(patterns) || patterns.length === 0) {
            return { error: 'patterns required — non-empty array of strings.' };
          }
          const parsed = patterns.map(parsePattern);
          getLogBox()?.ignoreLogs?.(parsed);
          return { added: patterns.length };
        },
        inputSchema: {
          patterns: {
            description:
              'Substrings or /regex/flags strings to add to the ignore list. /.../flags compiles to RegExp; everything else matches as a substring.',
            examples: [
              ['VirtualizedLists should never be nested'],
              ['/^Warning: /', '/useNativeDriver/i'],
            ],
            items: { type: 'string' },
            minItems: 1,
            type: 'array',
          },
        },
      },
      ignore_all: {
        description: 'Globally mute or unmute LogBox. Leaves console logging intact.',
        handler: (args) => {
          const value = typeof args.value === 'boolean' ? args.value : true;
          getLogBox()?.ignoreAllLogs?.(value);
          return { ignoreAll: value };
        },
        inputSchema: {
          value: {
            default: true,
            description: 'true to mute all logs, false to unmute.',
            type: 'boolean',
          },
        },
      },
      set_installed: {
        description:
          'Install (`enabled: true`) or uninstall (`enabled: false`) LogBox globally. When uninstalled, warnings still log to console but the overlay is disabled. No-op when the requested state already holds.',
        handler: (args) => {
          const enabled = args.enabled === true;
          const LogBox = getLogBox();
          if (enabled) {
            LogBox?.install?.();
          } else {
            LogBox?.uninstall?.();
          }
          return { installed: enabled };
        },
        inputSchema: {
          enabled: {
            description: 'true → install (enable); false → uninstall (disable).',
            type: 'boolean',
          },
        },
      },
      status: {
        description: 'LogBox state — installed, disabled, current log count, ignore patterns.',
        handler: () => {
          const LogBox = getLogBox();
          const data = getLogBoxData();
          return {
            disabled: data?.isDisabled?.() ?? null,
            ignorePatterns: (data?.getIgnorePatterns?.() ?? []).map((p: unknown) => {
              return typeof p === 'string' ? p : String(p);
            }),
            installed: LogBox?.isInstalled?.() ?? null,
            logCount: getLogsArray().length,
          };
        },
      },
    },
  };
};
