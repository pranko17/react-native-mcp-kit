import { describe, expect, it } from 'vitest';

import { type McpModule } from '@/client/models/types';
import { storageModule, type StorageAdapter } from '@/modules/storage';

interface MapAdapter {
  adapter: StorageAdapter;
  map: Map<string, string>;
}

const makeSyncAdapter = (initial: Record<string, string> = {}): MapAdapter => {
  const map = new Map(Object.entries(initial));
  return {
    adapter: {
      delete: (key) => {
        map.delete(key);
      },
      get: (key) => {
        return map.get(key);
      },
      getAllKeys: () => {
        return [...map.keys()];
      },
      set: (key, value) => {
        map.set(key, value);
      },
    },
    map,
  };
};

const makeAsyncAdapter = (initial: Record<string, string> = {}): MapAdapter => {
  const map = new Map(Object.entries(initial));
  return {
    adapter: {
      delete: async (key) => {
        map.delete(key);
      },
      get: async (key) => {
        return map.get(key) ?? null;
      },
      getAllKeys: async () => {
        return [...map.keys()];
      },
      set: async (key, value) => {
        map.set(key, value);
      },
    },
    map,
  };
};

interface Harness {
  asyncMap: Map<string, string>;
  mod: McpModule;
  syncMap: Map<string, string>;
}

const makeHarness = (): Harness => {
  const sync = makeSyncAdapter({
    count: '42',
    plain: 'not-json',
    user: '{"id":1,"name":"Ann"}',
  });
  const asyncStore = makeAsyncAdapter({ session: '{"active":true}' });
  const readOnlyAdapter: StorageAdapter = {
    get: (key) => {
      return key === 'frozen' ? 'ice' : undefined;
    },
  };
  const mod = storageModule(
    { adapter: sync.adapter, name: 'mmkv' },
    { adapter: asyncStore.adapter, name: 'async' },
    { adapter: readOnlyAdapter, name: 'readonly' }
  );
  return { asyncMap: asyncStore.map, mod, syncMap: sync.map };
};

const call = (mod: McpModule, tool: string, args: Record<string, unknown> = {}): unknown => {
  return mod.tools[tool]!.handler(args);
};

describe('storageModule get_item', () => {
  it('JSON-parses object values (default depth expands one level)', async () => {
    const { mod } = makeHarness();
    expect(await call(mod, 'get_item', { key: 'user' })).toEqual({
      key: 'user',
      value: { id: 1, name: 'Ann' },
    });
  });

  it('keeps non-JSON strings raw and parses numeric strings', async () => {
    const { mod } = makeHarness();
    expect(await call(mod, 'get_item', { key: 'plain' })).toEqual({
      key: 'plain',
      value: 'not-json',
    });
    expect(await call(mod, 'get_item', { key: 'count' })).toEqual({ key: 'count', value: 42 });
  });

  it('returns undefined value for a missing key', async () => {
    const { mod } = makeHarness();
    const result = (await call(mod, 'get_item', { key: 'ghost' })) as {
      key: string;
      value: unknown;
    };
    expect(result.key).toBe('ghost');
    expect(result.value).toBeUndefined();
  });

  it('targets a named storage explicitly and works with an async adapter', async () => {
    const { mod } = makeHarness();
    expect(await call(mod, 'get_item', { key: 'session', storage: 'async' })).toEqual({
      key: 'session',
      value: { active: true },
    });
  });

  it('returns an error for an unknown storage name', async () => {
    const { mod } = makeHarness();
    expect(await call(mod, 'get_item', { key: 'user', storage: 'nope' })).toEqual({
      error: 'Storage not found',
    });
  });
});

describe('storageModule set_item', () => {
  it('stores strings as-is on the default (first) storage', async () => {
    const { mod, syncMap } = makeHarness();
    expect(await call(mod, 'set_item', { key: 'greeting', value: 'hello' })).toEqual({
      key: 'greeting',
      success: true,
    });
    expect(syncMap.get('greeting')).toBe('hello');
  });

  it('stringifies non-string values via JSON.stringify', async () => {
    const { mod, syncMap } = makeHarness();
    await call(mod, 'set_item', { key: 'obj', value: { a: 1 } });
    await call(mod, 'set_item', { key: 'num', value: 42 });
    expect(syncMap.get('obj')).toBe('{"a":1}');
    expect(syncMap.get('num')).toBe('42');
  });

  it('writes to an async adapter', async () => {
    const { asyncMap, mod } = makeHarness();
    await call(mod, 'set_item', { key: 'fresh', storage: 'async', value: 'v' });
    expect(asyncMap.get('fresh')).toBe('v');
  });
});

describe('storageModule delete_item', () => {
  it('deletes a key from sync and async adapters', async () => {
    const { asyncMap, mod, syncMap } = makeHarness();
    expect(await call(mod, 'delete_item', { key: 'plain' })).toEqual({
      key: 'plain',
      success: true,
    });
    expect(syncMap.has('plain')).toBe(false);
    await call(mod, 'delete_item', { key: 'session', storage: 'async' });
    expect(asyncMap.has('session')).toBe(false);
  });
});

describe('storageModule listing', () => {
  it('list_keys returns all keys of the targeted storage', async () => {
    const { mod } = makeHarness();
    expect(await call(mod, 'list_keys')).toEqual({ keys: ['count', 'plain', 'user'] });
    expect(await call(mod, 'list_keys', { storage: 'async' })).toEqual({ keys: ['session'] });
  });

  it('get_all parses values; default depth 1 collapses object values to markers', async () => {
    const { mod } = makeHarness();
    expect(await call(mod, 'get_all')).toEqual({
      count: 42,
      plain: 'not-json',
      user: { '${obj}': 2 },
    });
    expect(await call(mod, 'get_all', { depth: 2 })).toEqual({
      count: 42,
      plain: 'not-json',
      user: { id: 1, name: 'Ann' },
    });
  });

  it('list_storages reports key counts and "unknown" for adapters without getAllKeys', async () => {
    const { mod } = makeHarness();
    expect(await call(mod, 'list_storages')).toEqual([
      { keyCount: 3, name: 'mmkv' },
      { keyCount: 1, name: 'async' },
      { keyCount: 'unknown', name: 'readonly' },
    ]);
  });
});

describe('storageModule unsupported adapter operations', () => {
  it('reads still work on a get-only adapter', async () => {
    const { mod } = makeHarness();
    expect(await call(mod, 'get_item', { key: 'frozen', storage: 'readonly' })).toEqual({
      key: 'frozen',
      value: 'ice',
    });
  });

  it('write and enumeration tools return "unsupported" errors', async () => {
    const { mod } = makeHarness();
    expect(await call(mod, 'set_item', { key: 'k', storage: 'readonly', value: 'v' })).toEqual({
      error: 'This storage does not support set',
    });
    expect(await call(mod, 'delete_item', { key: 'k', storage: 'readonly' })).toEqual({
      error: 'This storage does not support delete',
    });
    expect(await call(mod, 'list_keys', { storage: 'readonly' })).toEqual({
      error: 'This storage does not support getAllKeys',
    });
    expect(await call(mod, 'get_all', { storage: 'readonly' })).toEqual({
      error: 'This storage does not support getAllKeys',
    });
  });
});
