import { describe, expect, it } from 'vitest';

import { type McpModule } from '@/client/models/types';
import { reactQueryModule, type QueryClientLike } from '@/modules/reactQuery';

interface FakeQueryState {
  dataUpdatedAt: number;
  errorUpdatedAt: number;
  fetchStatus: string;
  status: string;
  data?: unknown;
  error?: unknown;
}

interface FakeQuery {
  queryHash: string;
  queryKey: readonly unknown[];
  state: FakeQueryState;
}

const makeQuery = (key: unknown[], state: Partial<FakeQueryState> = {}): FakeQuery => {
  return {
    queryHash: JSON.stringify(key),
    queryKey: key,
    state: {
      dataUpdatedAt: 0,
      errorUpdatedAt: 0,
      fetchStatus: 'idle',
      status: 'success',
      ...state,
    },
  };
};

interface RecordedCall {
  filters: unknown;
  method: string;
}

interface FakeClient {
  calls: RecordedCall[];
  client: QueryClientLike;
}

const makeFakeClient = (queries: FakeQuery[]): FakeClient => {
  const calls: RecordedCall[] = [];
  const client: QueryClientLike = {
    getQueryCache: () => {
      return {
        getAll: () => {
          return queries;
        },
      };
    },
    invalidateQueries: async (filters) => {
      calls.push({ filters, method: 'invalidate' });
    },
    refetchQueries: async (filters) => {
      calls.push({ filters, method: 'refetch' });
    },
    removeQueries: (filters) => {
      calls.push({ filters, method: 'remove' });
    },
    resetQueries: async (filters) => {
      calls.push({ filters, method: 'reset' });
    },
  };
  return { calls, client };
};

const seedQueries = (): FakeQuery[] => {
  return [
    makeQuery(['users'], { data: { list: [1, 2] }, dataUpdatedAt: 1700000000000 }),
    makeQuery(['users', 'list'], { fetchStatus: 'fetching', status: 'pending' }),
    makeQuery(['orders'], { error: 'boom', errorUpdatedAt: 1700000001000, status: 'error' }),
  ];
};

const call = (mod: McpModule, tool: string, args: Record<string, unknown> = {}): unknown => {
  return mod.tools[tool]!.handler(args);
};

describe('reactQueryModule get_queries', () => {
  it('serializes cache entries as metadata (no data) with ISO timestamps', () => {
    const mod = reactQueryModule(makeFakeClient(seedQueries()).client);
    const entries = call(mod, 'get_queries', { depth: 3 }) as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      dataUpdatedAt: '2023-11-14T22:13:20.000Z',
      fetchStatus: 'idle',
      hasData: true,
      hasError: false,
      hash: '["users"]',
      key: ['users'],
      status: 'success',
    });
    expect(entries[1]).toMatchObject({ dataUpdatedAt: null, hasData: false, status: 'pending' });
    expect(entries[2]).toMatchObject({ hasError: true, status: 'error' });
  });

  it('collapses the key array to a marker at the default depth 2', () => {
    const mod = reactQueryModule(makeFakeClient(seedQueries()).client);
    const entries = call(mod, 'get_queries') as Array<Record<string, unknown>>;
    expect(entries[0]!.key).toEqual({ '${arr}': 1 });
  });

  it('filters by status', () => {
    const mod = reactQueryModule(makeFakeClient(seedQueries()).client);
    const entries = call(mod, 'get_queries', { status: 'pending' }) as Array<
      Record<string, unknown>
    >;
    expect(entries.map((e) => e.hash)).toEqual(['["users","list"]']);
  });

  it('filters by key as a substring of the query hash', () => {
    const mod = reactQueryModule(makeFakeClient(seedQueries()).client);
    const entries = call(mod, 'get_queries', { key: 'users' }) as Array<Record<string, unknown>>;
    expect(entries.map((e) => e.hash)).toEqual(['["users"]', '["users","list"]']);
  });
});

describe('reactQueryModule get_data', () => {
  it('returns the full state for an exact JSON key', () => {
    const mod = reactQueryModule(makeFakeClient(seedQueries()).client);
    expect(call(mod, 'get_data', { key: '["users"]' })).toEqual({
      data: { list: { '${arr}': 2 } },
      dataUpdatedAt: '2023-11-14T22:13:20.000Z',
      error: null,
      fetchStatus: 'idle',
      key: ['users'],
      status: 'success',
    });
  });

  it('stringifies the error and nulls the timestamp when unset', () => {
    const mod = reactQueryModule(makeFakeClient(seedQueries()).client);
    expect(call(mod, 'get_data', { key: '["orders"]' })).toMatchObject({
      dataUpdatedAt: null,
      error: 'boom',
      status: 'error',
    });
  });

  it('returns an error for an unknown key', () => {
    const mod = reactQueryModule(makeFakeClient(seedQueries()).client);
    expect(call(mod, 'get_data', { key: '["nope"]' })).toEqual({
      error: 'Query with key ["nope"] not found',
    });
  });
});

describe('reactQueryModule get_stats', () => {
  it('counts totals by status and fetchStatus', () => {
    const mod = reactQueryModule(makeFakeClient(seedQueries()).client);
    expect(call(mod, 'get_stats')).toEqual({
      byFetchStatus: { fetching: 1, idle: 2 },
      byStatus: { error: 1, pending: 1, success: 1 },
      total: 3,
    });
  });
});

describe('reactQueryModule mutate', () => {
  it.each<[string]>([['invalidate'], ['refetch'], ['remove'], ['reset']])(
    'routes action "%s" to the matching client method with a parsed key filter',
    async (action) => {
      const { calls, client } = makeFakeClient(seedQueries());
      const mod = reactQueryModule(client);
      expect(await call(mod, 'mutate', { action, key: '["users"]' })).toEqual({
        action,
        success: true,
      });
      expect(calls).toEqual([{ filters: { queryKey: ['users'] }, method: action }]);
    }
  );

  it('omitting the key targets every cached query (undefined filters)', async () => {
    const { calls, client } = makeFakeClient(seedQueries());
    const mod = reactQueryModule(client);
    await call(mod, 'mutate', { action: 'remove' });
    expect(calls).toEqual([{ filters: undefined, method: 'remove' }]);
  });

  it('wraps non-array and non-JSON keys into a single-element key', async () => {
    const { calls, client } = makeFakeClient(seedQueries());
    const mod = reactQueryModule(client);
    await call(mod, 'mutate', { action: 'remove', key: '"users"' });
    await call(mod, 'mutate', { action: 'remove', key: 'users' });
    expect(calls).toEqual([
      { filters: { queryKey: ['users'] }, method: 'remove' },
      { filters: { queryKey: ['users'] }, method: 'remove' },
    ]);
  });

  it('rejects an unknown action in the handler default branch', async () => {
    const { calls, client } = makeFakeClient(seedQueries());
    const mod = reactQueryModule(client);
    const result = (await call(mod, 'mutate', { action: 'explode' })) as { error?: string };
    expect(result.error).toContain('mutate.action must be one of');
    expect(result.error).toContain('got explode');
    expect(calls).toEqual([]);
  });

  it('reports a missing action distinctly', async () => {
    const { calls, client } = makeFakeClient(seedQueries());
    const mod = reactQueryModule(client);
    const result = (await call(mod, 'mutate', {})) as { error?: string };
    expect(result.error).toContain('got (missing)');
    expect(calls).toEqual([]);
  });
});
