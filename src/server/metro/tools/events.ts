import { z } from 'zod';

import { type HostToolHandler } from '@/server/host/types';
import { getEventCapture } from '@/server/metro/eventCapture';
import { resolveMetroUrl } from '@/server/metro/resolveMetroUrl';
import {
  applyProjection,
  makeProjectionSchema,
  projectAsValue,
  type ProjectionArgs,
} from '@/shared/projection/projectValue';

// Default depth 4 — top-level outer ({metroUrl,connected,events,lastError,total})
// (1) → events array (2) → event (3) → data (4). Heavy event payloads collapse
// past depth 4 to markers; drill via path.
const EVENTS_DEFAULT_DEPTH = 4;

const PROJECTION_SCHEMA = makeProjectionSchema(EVENTS_DEFAULT_DEPTH);

export const getEventsTool = (): HostToolHandler => {
  return {
    description: `Read recent Metro reporter events from a server-side ring buffer fed by Metro's WebSocket \`/events\` stream.

Metro emits events for the whole bundler lifecycle — \`bundle_build_started\` / \`bundle_build_done\` / \`bundle_build_failed\`, \`bundling_error\`, \`hmr_update\`, \`hmr_client_error\`, \`initial_update_done\`, \`transform_cache_reset\`, \`dep_graph_loading\` / \`dep_graph_loaded\`, \`client_log\`, \`worker_stdout_chunk\` / \`worker_stderr_chunk\`. When an agent edits a file and HMR silently fails (syntax error, broken import), the red box may not appear — but the \`bundling_error\` / \`hmr_client_error\` event already explains why.

The capture is lazy (connects on first call) and auto-reconnects. Buffer holds the last 200 events. Pass \`since: <msEpoch>\` to get only what arrived after a known checkpoint. \`type\` filters to one or several event types.

Each event: \`{ id, receivedAt, type, data }\`; \`data\` is the raw Metro payload minus the \`type\` field. Response accepts path / depth / maxBytes.`,
    handler: async (args, ctx) => {
      const metroUrl = resolveMetroUrl(args, ctx);
      const capture = getEventCapture(metroUrl);

      const type = args.type as string | string[] | undefined;
      const since = typeof args.since === 'number' ? args.since : undefined;

      const result = capture.getEvents({ since, type });
      return applyProjection(
        { metroUrl, ...result },
        args as ProjectionArgs,
        projectAsValue,
        EVENTS_DEFAULT_DEPTH
      );
    },
    inputSchema: z.looseObject({
      ...PROJECTION_SCHEMA,
      clientId: z
        .string()
        .describe(
          'Target client ID — used to pick up the Metro URL the app was loaded from (falls back to `metroUrl` or the hardcoded default).'
        )
        .optional(),
      metroUrl: z
        .string()
        .describe(
          'Base URL of the Metro dev server. Overrides the URL auto-detected from the connected client; last-resort fallback "http://localhost:8081".'
        )
        .optional(),
      since: z
        .number()
        .min(0)
        .describe('Only return events with `receivedAt >= since` (ms since epoch).')
        .optional(),
      type: z
        .union([z.string(), z.array(z.string())])
        .describe('Filter by event type — an array matches any of the listed types (OR).')
        .meta({
          examples: [
            'bundling_error',
            ['bundling_error', 'hmr_client_error', 'bundle_build_failed'],
          ],
        })
        .optional(),
    }),
  };
};
