import { z } from 'zod';

import { type HostToolHandler } from '@/server/host/types';
import { resolveMetroUrl } from '@/server/metro/resolveMetroUrl';

const METRO_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_FRAMES = 10;
const MAX_FRAMES_CEILING = 100;

interface StackFrame {
  column?: number;
  file?: string;
  lineNumber?: number;
  methodName?: string;
}

interface ResolvedFrame extends StackFrame {
  collapse?: boolean;
}

// Strip a leading "ErrorName: message" line if present. V8 and Hermes both
// prepend this on `Error.stack`; some formats omit it. Anything that doesn't
// look like a frame on the first line gets dropped so the regex matchers
// below see a clean stack.
const stripErrorHeader = (stack: string): string => {
  const newline = stack.indexOf('\n');
  if (newline === -1) return stack;
  const firstLine = stack.slice(0, newline);
  if (/^\s*[A-Z][A-Za-z]*Error:?(\s|$)/.test(firstLine) && !/@|^\s*at\s/.test(firstLine)) {
    return stack.slice(newline + 1);
  }
  return stack;
};

/**
 * Parses a raw Error.stack string into structured frames. Supports:
 *   • V8 `    at method (file:line:col)` (Node / Chrome)
 *   • V8 `    at file:line:col` (anonymous)
 *   • Hermes / JSC `method@file:line:col`
 *   • Hermes anonymous `@file:line:col` and `anonymous@file:line:col`
 *   • Hermes packager-rooted `?anon_0_/abs/path.tsx:line:col`
 * Drops a leading `<Error>: <message>` header line. Returns an empty array
 * if nothing matches so the caller can fall back gracefully.
 */
const parseStackString = (stack: string): StackFrame[] => {
  const body = stripErrorHeader(stack);
  const frames: StackFrame[] = [];

  // V8 — handles both `at method (file:L:C)` and bare `at file:L:C` (anon).
  const v8Regex = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = v8Regex.exec(body)) !== null) {
    frames.push({
      column: Number.parseInt(match[4]!, 10),
      file: match[2]!,
      lineNumber: Number.parseInt(match[3]!, 10),
      methodName: match[1]?.trim() || undefined,
    });
  }
  if (frames.length > 0) return frames;

  // Hermes / JSC — `[method]@[?anon_X_]<file>:L:C`. Method side can be empty
  // (purely `@file:L:C`) or the literal "anonymous". `?anon_N_/abs/path` is
  // Hermes' compiled-bundle marker for anonymous functions and passes
  // through to Metro's /symbolicate as-is.
  const hermesRegex = /^(.*?)@(\??[^:\n]+?):(\d+):(\d+)$/gm;
  while ((match = hermesRegex.exec(body)) !== null) {
    const methodName = match[1]?.trim();
    frames.push({
      column: Number.parseInt(match[4]!, 10),
      file: match[2]!,
      lineNumber: Number.parseInt(match[3]!, 10),
      methodName:
        methodName && methodName.length > 0 && methodName !== 'anonymous' ? methodName : undefined,
    });
  }
  return frames;
};

/**
 * Shorten an absolute filesystem path by stripping the current working
 * directory prefix. Leaves URLs and unrelated absolute paths untouched.
 */
const relativeToCwd = (file: string | undefined, cwd: string): string | undefined => {
  if (!file) return file;
  if (file.startsWith('http://') || file.startsWith('https://')) return file;
  if (file.startsWith(cwd + '/')) return file.slice(cwd.length + 1);
  if (file === cwd) return '.';
  return file;
};

/**
 * Apply token-saving transforms to a resolved stack:
 * 1. Drop framework frames (`collapse: true` from Metro = node_modules / RN
 *    internals) unless explicitly kept via includeFrameworkFrames.
 * 2. Trim to `maxFrames` (from the top — where the actual cause lives).
 * 3. Rewrite file paths relative to cwd unless fullPaths is set.
 * 4. Drop `collapse` from output (already used for filtering).
 */
const trimFrames = (
  frames: ResolvedFrame[],
  opts: { fullPaths: boolean; includeFramework: boolean; maxFrames: number }
): StackFrame[] => {
  const filtered = opts.includeFramework
    ? frames
    : frames.filter((f) => {
        return !f.collapse;
      });
  const limited = filtered.slice(0, opts.maxFrames);
  const cwd = process.cwd();
  return limited.map((f) => {
    const out: StackFrame = {};
    const file = opts.fullPaths ? f.file : relativeToCwd(f.file, cwd);
    if (file) out.file = file;
    if (typeof f.lineNumber === 'number') out.lineNumber = f.lineNumber;
    if (typeof f.column === 'number' && f.column > 0) out.column = f.column;
    if (f.methodName) out.methodName = f.methodName;
    return out;
  });
};

export const symbolicateTool = (): HostToolHandler => {
  return {
    description: `Resolve a JS stack trace via Metro's /symbolicate endpoint — maps bundled paths like "http://localhost:8081/index.bundle:12345:67" back to original sources like "src/components/Foo.tsx:42:10".

Pass either a raw stack string (from errors__get_errors.stack) or a parsed array of frames (from log_box__get_logs[*].stack). No-ops gracefully when Metro is unreachable (returns { skipped: true, error }), so safe to call opportunistically.

TOKEN-SAVING DEFAULTS
  - node_modules / RN-internal frames (collapse: true from Metro) are dropped.
  - Trimmed to the top maxFrames frames (the top is where the actual cause lives).
  - Absolute paths are shortened relative to the MCP server's cwd.
  Opt-out via includeFrameworkFrames / maxFrames / fullPaths.`,
    handler: async (args, ctx) => {
      const stack = args.stack as string | undefined;
      const frames = args.frames as StackFrame[] | undefined;
      const metroUrl = resolveMetroUrl(args, ctx);

      const includeFramework = args.includeFrameworkFrames === true;
      const fullPaths = args.fullPaths === true;
      const maxFrames = Math.max(
        1,
        Math.min(
          MAX_FRAMES_CEILING,
          typeof args.maxFrames === 'number' ? Math.floor(args.maxFrames) : DEFAULT_MAX_FRAMES
        )
      );
      const trimOpts = { fullPaths, includeFramework, maxFrames };

      let rawFrames: StackFrame[];
      if (Array.isArray(frames) && frames.length > 0) {
        rawFrames = frames;
      } else if (typeof stack === 'string' && stack.length > 0) {
        rawFrames = parseStackString(stack);
      } else {
        return { error: 'Pass either `stack` (string) or `frames` (array).' };
      }

      if (rawFrames.length === 0) {
        return { error: 'No frames parsed from input.', frames: [], skipped: true };
      }

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
        }, METRO_TIMEOUT_MS);
        const res = await fetch(`${metroUrl}/symbolicate`, {
          body: JSON.stringify({ stack: rawFrames }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          return {
            error: `Metro responded ${res.status}`,
            frames: trimFrames(rawFrames, trimOpts),
            skipped: true,
          };
        }
        const json = (await res.json()) as { stack?: ResolvedFrame[] };
        const resolved: ResolvedFrame[] = json.stack ?? rawFrames;
        const totalFrames = includeFramework
          ? resolved.length
          : resolved.filter((f) => {
              return !f.collapse;
            }).length;
        const trimmed = trimFrames(resolved, trimOpts);
        const result: {
          frames: StackFrame[];
          totalFrames: number;
          droppedFrameworkFrames?: number;
          truncated?: true;
        } = { frames: trimmed, totalFrames };
        if (!includeFramework) {
          result.droppedFrameworkFrames = resolved.length - totalFrames;
        }
        if (totalFrames > trimmed.length) result.truncated = true;
        return result;
      } catch (err) {
        return {
          error: `Metro at ${metroUrl} unreachable: ${(err as Error).message}`,
          frames: trimFrames(rawFrames, trimOpts),
          skipped: true,
        };
      }
    },
    inputSchema: z.looseObject({
      clientId: z
        .string()
        .describe(
          'Target client ID — used to pick up the Metro URL the app was actually loaded from (falls back to `metroUrl` or the hardcoded default).'
        )
        .optional(),
      frames: z
        .array(
          z.looseObject({
            column: z.number().optional(),
            file: z.string().optional(),
            lineNumber: z.number().optional(),
            methodName: z.string().optional(),
          })
        )
        .describe(
          'Parsed stack frames. One of `stack` / `frames` is required; `frames` takes precedence when both are provided.'
        )
        .meta({
          examples: [
            [
              {
                column: 42,
                file: 'http://localhost:8081/index.bundle',
                lineNumber: 1234,
                methodName: 'render',
              },
            ],
          ],
        })
        .optional(),
      fullPaths: z
        .boolean()
        .describe('Return absolute file paths instead of ones relative to the MCP server cwd.')
        .meta({ default: false })
        .optional(),
      includeFrameworkFrames: z
        .boolean()
        .describe(
          'Keep node_modules / React Native internal frames (marked collapse: true by Metro). Framework noise is dropped by default to save tokens.'
        )
        .meta({ default: false })
        .optional(),
      maxFrames: z
        .number()
        .min(1)
        .max(MAX_FRAMES_CEILING)
        .describe('Max frames to return after filtering (top-down).')
        .meta({ default: DEFAULT_MAX_FRAMES })
        .optional(),
      metroUrl: z
        .string()
        .describe(
          'Base URL of the Metro dev server. Overrides the URL auto-detected from the connected client; last-resort fallback "http://localhost:8081".'
        )
        .optional(),
      stack: z
        .string()
        .describe(
          'Raw stack trace string (e.g. from an Error.stack). Parsed into frames. One of `stack` / `frames` is required.'
        )
        .optional(),
    }),
    timeout: METRO_TIMEOUT_MS + 1_000,
  };
};
