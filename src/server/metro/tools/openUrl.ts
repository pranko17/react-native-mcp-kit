import { type HostToolHandler } from '@/server/host/types';
import { resolveMetroUrl } from '@/server/metro/resolveMetroUrl';

const METRO_TIMEOUT_MS = 5_000;

export const openUrlTool = (): HostToolHandler => {
  return {
    description: `Open a URL in the default browser on the machine running Metro — POSTs to Metro's \`/open-url\` endpoint.

Useful for handing off to a view the agent has discovered but can't usefully display itself: a CI job page, a Grafana dashboard, a PR diff, a deployed preview build. This runs \`open\` on macOS / \`xdg-open\` on Linux against the host, not on the mobile device. For deep-linking into the app use navigation module or iOS/Android URL schemes instead.

Returns { ok: true, url, metroUrl } on success.`,
    handler: async (args, ctx) => {
      const url = typeof args.url === 'string' ? args.url : undefined;
      if (!url) {
        return { error: '`url` is required.' };
      }
      const metroUrl = resolveMetroUrl(args, ctx);
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
        }, METRO_TIMEOUT_MS);
        const res = await fetch(`${metroUrl}/open-url`, {
          body: JSON.stringify({ url }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          return {
            error: `Metro responded ${res.status}`,
            metroUrl,
            ok: false,
            skipped: true,
            url,
          };
        }
        return { metroUrl, ok: true, url };
      } catch (err) {
        return {
          error: `Metro at ${metroUrl} unreachable: ${(err as Error).message}`,
          metroUrl,
          ok: false,
          skipped: true,
          url,
        };
      }
    },
    inputSchema: {
      clientId: {
        description:
          'Target client ID — used to pick up the Metro URL the app was loaded from (falls back to `metroUrl` or the hardcoded default).',
        type: 'string',
      },
      metroUrl: {
        description: `Base URL of the Metro dev server. Overrides the URL reported by the connected client. Default "http://localhost:8081".`,
        type: 'string',
      },
      url: {
        description:
          'Absolute URL to open on the host (http/https). Deep-linking into the mobile app is a different concern — use navigation tools instead.',
        examples: ['https://example.com/dashboard', 'https://github.com/org/repo/pull/42'],
        type: 'string',
      },
    },
    timeout: METRO_TIMEOUT_MS + 1_000,
  };
};
