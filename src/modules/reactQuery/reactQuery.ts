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
    name: 'query',
    tools: {
      get_data: {
        description: 'Get the cached data for a specific query by key',
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
            description: 'Query key as JSON string (e.g. \'["users"]\' or \'"users"\')',
            type: 'string',
          },
        },
      },
      get_queries: {
        description:
          'List all cached queries with their status, fetch status, and timestamps. Does not include data — use get_data for that.',
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
          key: { description: 'Filter by key substring', type: 'string' },
          status: {
            description: 'Filter by status (pending, error, success)',
            type: 'string',
          },
        },
      },
      get_stats: {
        description: 'Get query cache statistics',
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
        description:
          'Invalidate queries, marking them as stale. They will refetch on next use. Pass key to target specific queries, or omit to invalidate all.',
        handler: async (args) => {
          const filters = args.key ? { queryKey: parseKey(args.key as string) } : undefined;
          await queryClient.invalidateQueries(filters);
          return { success: true };
        },
        inputSchema: {
          key: {
            description: 'Query key to invalidate as JSON string (omit to invalidate all)',
            type: 'string',
          },
        },
      },
      refetch: {
        description:
          'Refetch queries immediately. Pass key to target specific queries, or omit to refetch all.',
        handler: async (args) => {
          const filters = args.key ? { queryKey: parseKey(args.key as string) } : undefined;
          await queryClient.refetchQueries(filters);
          return { success: true };
        },
        inputSchema: {
          key: {
            description: 'Query key to refetch as JSON string (omit to refetch all)',
            type: 'string',
          },
        },
      },
      remove: {
        description:
          'Remove queries from cache entirely. Pass key to target specific queries, or omit to clear all.',
        handler: (args) => {
          const filters = args.key ? { queryKey: parseKey(args.key as string) } : undefined;
          queryClient.removeQueries(filters);
          return { success: true };
        },
        inputSchema: {
          key: {
            description: 'Query key to remove as JSON string (omit to remove all)',
            type: 'string',
          },
        },
      },
      reset: {
        description:
          'Reset queries to initial state (clears data and error). Pass key to target specific queries.',
        handler: async (args) => {
          const filters = args.key ? { queryKey: parseKey(args.key as string) } : undefined;
          await queryClient.resetQueries(filters);
          return { success: true };
        },
        inputSchema: {
          key: {
            description: 'Query key to reset as JSON string (omit to reset all)',
            type: 'string',
          },
        },
      },
    },
  };
};
