import { z } from 'zod';

import { type McpModule } from '@/client/models/types';
import {
  applyProjection,
  makeProjectionSchema,
  projectAsValue,
  type ProjectionArgs,
} from '@/shared/projection/projectValue';

import { type QueryClientLike } from './types';

// `get_queries` shape: array of compact entries (metadata only, no `data`).
// Default depth 2 — array opened, each entry opened (all primitives inline).
const QUERIES_DEFAULT_DEPTH = 2;

// `get_data` shape: { data, dataUpdatedAt, error, fetchStatus, key, status }.
// Default depth 2 — outer object expanded, `data` walked one level (top-level
// fields visible, nested containers collapse to markers). Drill via path.
const DATA_DEFAULT_DEPTH = 2;

const QUERIES_SCHEMA = makeProjectionSchema(QUERIES_DEFAULT_DEPTH);
const DATA_SCHEMA = makeProjectionSchema(DATA_DEFAULT_DEPTH);

const serializeQuery = (query: {
  queryHash: string;
  queryKey: readonly unknown[];
  state: {
    dataUpdatedAt: number;
    errorUpdatedAt: number;
    fetchStatus: string;
    status: string;
    data?: unknown;
    error?: unknown;
  };
}) => {
  return {
    dataUpdatedAt: query.state.dataUpdatedAt
      ? new Date(query.state.dataUpdatedAt).toISOString()
      : null,
    fetchStatus: query.state.fetchStatus,
    hasData: query.state.data !== undefined,
    hasError: query.state.error !== undefined,
    hash: query.queryHash,
    key: query.queryKey,
    status: query.state.status,
  };
};

export const reactQueryModule = (queryClient: QueryClientLike): McpModule => {
  const getAllQueries = () => {
    return queryClient.getQueryCache().getAll();
  };

  const parseKey = (keyStr: string): unknown[] => {
    try {
      const parsed = JSON.parse(keyStr);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [keyStr];
    }
  };

  return {
    description: `React Query cache inspection + mutation.

Query keys are passed as JSON strings to preserve array structure — e.g.
'["users","list"]' or '"users"'. Omit \`key\` on \`mutate\` to target every
cached query at once.

\`get_queries\` returns metadata only (no \`data\`, default depth ${QUERIES_DEFAULT_DEPTH}).
\`get_data\` returns the full query state for one key (default depth ${DATA_DEFAULT_DEPTH}).
Both accept path / depth / maxBytes.`,
    name: 'query',
    tools: {
      get_data: {
        description: 'Cached data for one query by exact key.',
        handler: (args) => {
          const key = parseKey(args.key as string);
          const queries = getAllQueries();
          const query = queries.find((q) => {
            return JSON.stringify(q.queryKey) === JSON.stringify(key);
          });
          if (!query) return { error: `Query with key ${args.key} not found` };
          const result = {
            data: query.state.data,
            dataUpdatedAt: query.state.dataUpdatedAt
              ? new Date(query.state.dataUpdatedAt).toISOString()
              : null,
            error: query.state.error ? String(query.state.error) : null,
            fetchStatus: query.state.fetchStatus,
            key: query.queryKey,
            status: query.state.status,
          };
          return applyProjection(
            result,
            args as ProjectionArgs,
            projectAsValue,
            DATA_DEFAULT_DEPTH
          );
        },
        inputSchema: z.looseObject({
          ...DATA_SCHEMA,
          key: z
            .string()
            .min(1)
            .describe('Query key (JSON string).')
            .meta({ examples: ['["users"]', '["users","list"]', '"users"'] }),
        }),
      },
      get_queries: {
        description: 'List cached queries (status/fetchStatus/timestamps, no data).',
        handler: (args) => {
          let queries = getAllQueries();
          if (args.status) {
            queries = queries.filter((q) => {
              return q.state.status === (args.status as string);
            });
          }
          if (args.key) {
            const keyStr = args.key as string;
            queries = queries.filter((q) => {
              return q.queryHash.includes(keyStr);
            });
          }
          return applyProjection(
            queries.map(serializeQuery),
            args as ProjectionArgs,
            projectAsValue,
            QUERIES_DEFAULT_DEPTH
          );
        },
        inputSchema: z.looseObject({
          ...QUERIES_SCHEMA,
          key: z
            .string()
            .describe(
              'Substring filter on the serialized queryHash — NOT an exact key match (unlike get_data / mutate, which take an exact JSON key).'
            )
            .optional(),
          status: z.enum(['pending', 'error', 'success']).describe('Filter by status.').optional(),
        }),
      },
      get_stats: {
        description: 'Cache counts — total, by status, by fetchStatus.',
        handler: () => {
          const queries = getAllQueries();
          const byStatus: Record<string, number> = {};
          const byFetchStatus: Record<string, number> = {};
          for (const q of queries) {
            byStatus[q.state.status] = (byStatus[q.state.status] ?? 0) + 1;
            byFetchStatus[q.state.fetchStatus] = (byFetchStatus[q.state.fetchStatus] ?? 0) + 1;
          }
          return { byFetchStatus, byStatus, total: queries.length };
        },
        inputSchema: z.looseObject({}),
      },
      mutate: {
        description:
          'Run a cache action: `invalidate` (mark stale, refetch on next use) · `refetch` (now) · `remove` (drop) · `reset` (clear data+error to initial). Omit `key` to hit every cached query.',
        handler: async (args) => {
          const action = typeof args.action === 'string' ? args.action : undefined;
          const filters = args.key ? { queryKey: parseKey(args.key as string) } : undefined;
          switch (action) {
            case 'invalidate':
              await queryClient.invalidateQueries(filters);
              return { action, success: true };
            case 'refetch':
              await queryClient.refetchQueries(filters);
              return { action, success: true };
            case 'remove':
              queryClient.removeQueries(filters);
              return { action, success: true };
            case 'reset':
              await queryClient.resetQueries(filters);
              return { action, success: true };
            default:
              return {
                error: `mutate.action must be one of "invalidate" / "refetch" / "remove" / "reset", got ${action ?? '(missing)'}.`,
              };
          }
        },
        inputSchema: z.looseObject({
          action: z
            .enum(['invalidate', 'refetch', 'remove', 'reset'])
            .describe('Mutation kind to perform on the cache.'),
          key: z
            .string()
            .describe('Query key (JSON string). Omit to target every cached query.')
            .meta({ examples: ['["users"]', '["users","list"]'] })
            .optional(),
        }),
      },
    },
  };
};
