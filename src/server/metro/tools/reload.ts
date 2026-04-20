import { type HostToolHandler } from '@/server/host/types';
import { resolveMetroUrl } from '@/server/metro/resolveMetroUrl';

const METRO_TIMEOUT_MS = 5_000;

export const reloadTool = (): HostToolHandler => {
  return {
    description: `Trigger a full JS reload on every app attached to Metro — POSTs to Metro's \`/reload\` endpoint.

Equivalent to shaking the device and tapping "Reload". Use this when the agent needs a clean runtime (post-edit, after state corruption, or between test cases) without touching the simulator UI. All connected clients reload, not just the targeted one — Metro broadcasts.

Returns { ok: true, metroUrl } on success. On an unreachable Metro returns { ok: false, error, metroUrl, skipped: true }.`,
    handler: async (args, ctx) => {
      const metroUrl = resolveMetroUrl(args, ctx);
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
        }, METRO_TIMEOUT_MS);
        const res = await fetch(`${metroUrl}/reload`, {
          method: 'POST',
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          return { error: `Metro responded ${res.status}`, metroUrl, ok: false, skipped: true };
        }
        return { metroUrl, ok: true };
      } catch (err) {
        return {
          error: `Metro at ${metroUrl} unreachable: ${(err as Error).message}`,
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
      metroUrl: {
        description: `Base URL of the Metro dev server. Overrides the URL reported by the connected client. Default "${'http://localhost:8081'}".`,
        type: 'string',
      },
    },
    timeout: METRO_TIMEOUT_MS + 1_000,
  };
};
