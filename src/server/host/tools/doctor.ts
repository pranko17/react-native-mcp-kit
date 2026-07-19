import { z } from 'zod';

import { type HostToolHandler } from '@/server/host/types';
import { PACKAGE_VERSION } from '@/server/mcpServer';
import { resolveMetroUrl } from '@/server/metro/resolveMetroUrl';
import { MODULE_SEPARATOR } from '@/shared/protocol';

const METRO_PROBE_TIMEOUT_MS = 2_000;

interface MetroProbe {
  detail: string;
  reachable: boolean;
}

const probeMetro = async (url: string): Promise<MetroProbe> => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, METRO_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/status`, { signal: controller.signal });
    const body = await res.text();
    const running = res.ok && body.includes('running');
    return {
      detail: running ? 'packager-status: running' : `HTTP ${res.status}`,
      reachable: running,
    };
  } catch (err) {
    return { detail: (err as Error).message, reachable: false };
  } finally {
    clearTimeout(timer);
  }
};

interface FiberQueryResult {
  matches?: Array<{ mcpId?: string; name?: string }>;
  total?: number;
}

export const doctorTool = (): HostToolHandler => {
  return {
    description: `One-shot setup diagnosis — checks the whole chain and returns a verdict with fixes, so "the agent sees nothing" doesn't need manual guessing.

Checks: daemon (version / pid / port / uptime / attached agent sessions), connected + disconnected clients, Metro reachability, and whether the test-id babel plugin actually ran (probes the fiber tree for stamped mcpIds — all missing = plugin not applied / stale Metro cache). Works with zero clients connected; babel + Metro app-origin checks need one.

Returns { ok, server, clients, metro, babelPlugin, problems }. \`ok\` is true only when \`problems\` is empty; each problem carries its fix.`,
    handler: async (args, ctx) => {
      const clientId = ctx.requestedClientId;
      const clients = ctx.bridge.listClients();
      const disconnected = ctx.bridge.listDisconnected();

      const server = {
        packageVersion: PACKAGE_VERSION,
        pid: process.pid,
        port: ctx.bridge.boundPort(),
        // Agent sessions (proxies) sharing this daemon; 0 in single-process
        // embedding mode where the MCP client attaches with no proxy.
        sessions: ctx.bridge.proxySessionCount(),
        uptimeSec: Math.round(process.uptime()),
      };

      const clientsReport = {
        connected: clients.length,
        disconnected: disconnected.length,
        list: clients.map((c) => {
          return {
            appName: c.appName,
            id: c.id,
            modules: c.modules.length,
            platform: c.platform,
            status: c.appState ?? 'active',
          };
        }),
      };

      const metroUrl = resolveMetroUrl(args, { bridge: ctx.bridge, requestedClientId: clientId });
      const metro = { url: metroUrl, ...(await probeMetro(metroUrl)) };

      // The test-id transform is per app bundle, so two connected apps can
      // differ — probe each client explicitly rather than dispatching with an
      // unset clientId (which errors "multiple clients — specify clientId").
      // Per client: a descendants-scope step over the whole tree; any fiber
      // carrying an mcpId means the plugin ran, zero (with a mounted app)
      // means it didn't or Metro served a stale transform.
      const babelTargets = clientId ? [clientId] : clients.map((c) => c.id);
      let babelPlugin: { applied: boolean | null; checked: boolean; detail: string };
      if (babelTargets.length === 0) {
        babelPlugin = {
          applied: null,
          checked: false,
          detail: 'No RN client connected — cannot probe the fiber tree.',
        };
      } else {
        const perClient = await Promise.all(
          babelTargets.map(async (id) => {
            const probe = await ctx.dispatch(
              `fiber_tree${MODULE_SEPARATOR}query`,
              { limit: 3, select: ['mcpId', 'name'], steps: [{ mcpId: '/./' }] },
              id
            );
            if (!probe.ok) {
              return {
                applied: null as boolean | null,
                note: `${id}: probe failed (${probe.error})`,
              };
            }
            const result = probe.result as FiberQueryResult;
            const total = result.total ?? 0;
            const sample = result.matches?.[0]?.mcpId;
            return {
              applied: total > 0,
              note: total > 0 ? `${id}: ${total} mcpIds (e.g. "${sample}")` : `${id}: no mcpIds`,
            };
          })
        );
        // Any app missing the plugin is a real problem (false); otherwise
        // true if at least one confirmed; null when none could be probed.
        const applied = perClient.some((p) => p.applied === false)
          ? false
          : perClient.some((p) => p.applied === true)
            ? true
            : null;
        babelPlugin = {
          applied,
          checked: perClient.some((p) => p.applied !== null),
          detail: perClient
            .map((p) => {
              return p.note;
            })
            .join('; '),
        };
      }

      const problems: string[] = [];
      if (clients.length === 0) {
        problems.push(
          'No RN client connected. Start the dev app; on an Android emulator run `adb reverse tcp:8347 tcp:8347`. The app retries every 3s.'
        );
      }
      if (!metro.reachable) {
        problems.push(
          `Metro is not reachable at ${metro.url}. Start it with \`yarn start\`, or pass \`metroUrl\` if it runs elsewhere.`
        );
      }
      if (babelPlugin.applied === false) {
        problems.push(
          'The test-id babel plugin did not run (no mcpIds in the tree). Add `react-native-mcp-kit/babel/test-id-plugin` to babel.config.js (dev), then `yarn start --reset-cache`.'
        );
      }

      return {
        babelPlugin,
        clients: clientsReport,
        metro,
        ok: problems.length === 0,
        problems,
        server,
      };
    },
    inputSchema: z.looseObject({
      metroUrl: z
        .string()
        .describe(
          'Override the Metro origin to probe. Defaults to the app-reported dev-server URL, then http://localhost:8081.'
        )
        .optional(),
    }),
  };
};
