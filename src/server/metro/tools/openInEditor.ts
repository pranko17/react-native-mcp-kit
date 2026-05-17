import { type HostToolHandler } from '@/server/host/types';
import { resolveMetroUrl } from '@/server/metro/resolveMetroUrl';

const METRO_TIMEOUT_MS = 3_000;

export const openInEditorTool = (): HostToolHandler => {
  return {
    description: `Jump to a source location in the dev machine's editor — POSTs to Metro's \`/open-stack-frame\` endpoint, which shells out via $REACT_EDITOR / $EDITOR.

Natural finisher for a symbolication flow: errors__get_errors → metro__symbolicate → metro__open_in_editor on the top user-frame. Unlike a plain \`open file:…\` shell call, this jumps to the exact line and column.

Returns { ok: true, file, lineNumber, metroUrl } on success.`,
    handler: async (args, ctx) => {
      const file = typeof args.file === 'string' ? args.file : undefined;
      const lineNumber = typeof args.lineNumber === 'number' ? args.lineNumber : undefined;
      const column = typeof args.column === 'number' ? args.column : undefined;
      if (!file) {
        return { error: '`file` is required.' };
      }
      if (typeof lineNumber !== 'number') {
        return { error: '`lineNumber` is required (number).' };
      }
      const metroUrl = resolveMetroUrl(args, ctx);
      const body: { file: string; lineNumber: number; column?: number } = { file, lineNumber };
      if (typeof column === 'number') body.column = column;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
        }, METRO_TIMEOUT_MS);
        const res = await fetch(`${metroUrl}/open-stack-frame`, {
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          return {
            error: `Metro responded ${res.status}`,
            file,
            lineNumber,
            metroUrl,
            ok: false,
            skipped: true,
          };
        }
        return { file, lineNumber, metroUrl, ok: true };
      } catch (err) {
        return {
          error: `Metro at ${metroUrl} unreachable: ${(err as Error).message}`,
          file,
          lineNumber,
          metroUrl,
          ok: false,
          skipped: true,
        };
      }
    },
    inputSchema: {
      clientId: {
        description:
          'Target client ID — used to pick up the Metro URL the app was loaded from (falls back to `metroUrl` or the hardcoded default).',
        type: 'string',
      },
      column: {
        description: 'Column number (1-based).',
        minimum: 1,
        type: 'number',
      },
      file: {
        description:
          'Absolute or repo-relative path to the source file. Paths from metro__symbolicate output plug in directly.',
        examples: ['src/screens/HomeScreen/HomeScreen.tsx', '/Users/me/project/src/Foo.tsx'],
        minLength: 1,
        type: 'string',
      },
      lineNumber: {
        description: 'Line number (1-based).',
        minimum: 1,
        type: 'number',
      },
      metroUrl: {
        description: `Base URL of the Metro dev server. Overrides the URL reported by the connected client. Default "http://localhost:8081".`,
        type: 'string',
      },
    },
    timeout: METRO_TIMEOUT_MS + 1_000,
  };
};
