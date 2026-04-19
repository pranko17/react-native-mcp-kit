import { type McpModule } from '@/client/models/types';

import { type QueryClientLike } from './types';

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
'["users","list"]' or '"users"'. Omit \`key\` on invalidate / refetch /
remove / reset to target every cached query at once.`,
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
          return {
            data: query.state.data,
            dataUpdatedAt: query.state.dataUpdatedAt
              ? new Date(query.state.dataUpdatedAt).toISOString()
              : null,
            error: query.state.error ? String(query.state.error) : null,
            fetchStatus: query.state.fetchStatus,
            key: query.queryKey,
            status: query.state.status,
          };
        },
        inputSchema: {
          key: {
            description: 'Query key (JSON string).',
            examples: ['["users"]', '["users","list"]', '"users"'],
            type: 'string',
          },
        },
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
          return queries.map(serializeQuery);
        },
        inputSchema: {
          key: { description: 'Substring filter on the serialized key.', type: 'string' },
          status: {
            description: 'Filter by status.',
            examples: ['pending', 'error', 'success'],
            type: 'string',
          },
        },
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
      },
      invalidate: {
        description: 'Mark queries stale (will refetch on next use). Omit key for all.',
        handler: async (args) => {
          const filters = args.key ? { queryKey: parseKey(args.key as string) } : undefined;
          await queryClient.invalidateQueries(filters);
          return { success: true };
        },
        inputSchema: {
          key: {
            description: 'Query key (JSON string). Omit to invalidate all.',
            examples: ['["users"]'],
            type: 'string',
          },
        },
      },
      refetch: {
        description: 'Refetch queries immediately. Omit key for all.',
        handler: async (args) => {
          const filters = args.key ? { queryKey: parseKey(args.key as string) } : undefined;
          await queryClient.refetchQueries(filters);
          return { success: true };
        },
        inputSchema: {
          key: {
            description: 'Query key (JSON string). Omit to refetch all.',
            examples: ['["users"]'],
            type: 'string',
          },
        },
      },
      remove: {
        description: 'Remove queries from cache entirely. Omit key for all.',
        handler: (args) => {
          const filters = args.key ? { queryKey: parseKey(args.key as string) } : undefined;
          queryClient.removeQueries(filters);
          return { success: true };
        },
        inputSchema: {
          key: {
            description: 'Query key (JSON string). Omit to remove all.',
            examples: ['["users"]'],
            type: 'string',
          },
        },
      },
      reset: {
        description: 'Reset queries to initial state (clears data + error). Omit key for all.',
        handler: async (args) => {
          const filters = args.key ? { queryKey: parseKey(args.key as string) } : undefined;
          await queryClient.resetQueries(filters);
          return { success: true };
        },
        inputSchema: {
          key: {
            description: 'Query key (JSON string). Omit to reset all.',
            examples: ['["users"]'],
            type: 'string',
          },
        },
      },
    },
  };
};
