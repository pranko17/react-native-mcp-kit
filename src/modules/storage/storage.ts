import { type McpModule } from '@/client/models/types';

import { type NamedStorage, type StorageAdapter } from './types';

const tryParseJson = (value: string | undefined | null): unknown => {
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

export const storageModule = (...storages: NamedStorage[]): McpModule => {
  const getStorage = (name?: string): StorageAdapter | null => {
    if (!name) return storages[0]?.adapter ?? null;
    return (
      storages.find((s) => {
        return s.name === name;
      })?.adapter ?? null
    );
  };

  return {
    description: `Multi-storage key-value inspection.

Each registered storage has a name and an adapter (MMKV / AsyncStorage /
custom). Only \`get\` is required on the adapter; \`set\` / \`delete\` /
\`getAllKeys\` are optional — the corresponding tools return an
"unsupported" error when absent. Values are JSON-parsed on read when
possible. The \`storage\` argument picks a named store; omit to target
the first-registered one.`,
    name: 'storage',
    tools: {
      delete_item: {
        description: 'Delete a key.',
        handler: async (args) => {
          const storage = getStorage(args.storage as string | undefined);
          if (!storage) return { error: 'Storage not found' };
          if (!storage.delete) return { error: 'This storage does not support delete' };
          await storage.delete(args.key as string);
          return { key: args.key, success: true };
        },
        inputSchema: {
          key: { description: 'Key to delete.', type: 'string' },
          storage: { description: 'Storage name (default: first).', type: 'string' },
        },
      },
      get_all: {
        description: 'All key-value pairs; values JSON-parsed when possible.',
        handler: async (args) => {
          const storage = getStorage(args.storage as string | undefined);
          if (!storage) return { error: 'Storage not found' };
          if (!storage.getAllKeys) return { error: 'This storage does not support getAllKeys' };
          const keys = await storage.getAllKeys();
          const entries: Record<string, unknown> = {};
          for (const key of keys) {
            entries[key] = tryParseJson(await storage.get(key));
          }
          return entries;
        },
        inputSchema: {
          storage: { description: 'Storage name (default: first).', type: 'string' },
        },
      },
      get_item: {
        description: 'Value for one key; JSON-parsed when possible.',
        handler: async (args) => {
          const storage = getStorage(args.storage as string | undefined);
          if (!storage) return { error: 'Storage not found' };
          const value = await storage.get(args.key as string);
          return { key: args.key, value: tryParseJson(value) };
        },
        inputSchema: {
          key: { description: 'Key to read.', type: 'string' },
          storage: { description: 'Storage name (default: first).', type: 'string' },
        },
      },
      list_keys: {
        description: 'All keys in a storage.',
        handler: async (args) => {
          const storage = getStorage(args.storage as string | undefined);
          if (!storage) return { error: 'Storage not found' };
          if (!storage.getAllKeys) return { error: 'This storage does not support getAllKeys' };
          return { keys: await storage.getAllKeys() };
        },
        inputSchema: {
          storage: { description: 'Storage name (default: first).', type: 'string' },
        },
      },
      list_storages: {
        description: 'Registered storages with key counts.',
        handler: async () => {
          const result = [];
          for (const s of storages) {
            const keyCount = s.adapter.getAllKeys
              ? (await s.adapter.getAllKeys()).length
              : 'unknown';
            result.push({ keyCount, name: s.name });
          }
          return result;
        },
      },
      set_item: {
        description: 'Write a value. Objects/arrays are stringified as JSON.',
        handler: async (args) => {
          const storage = getStorage(args.storage as string | undefined);
          if (!storage) return { error: 'Storage not found' };
          if (!storage.set) return { error: 'This storage does not support set' };
          const value = typeof args.value === 'string' ? args.value : JSON.stringify(args.value);
          await storage.set(args.key as string, value as string);
          return { key: args.key, success: true };
        },
        inputSchema: {
          key: { description: 'Key to set.', type: 'string' },
          storage: { description: 'Storage name (default: first).', type: 'string' },
          value: { description: 'Value (string or JSON-serializable).', type: 'string' },
        },
      },
    },
  };
};
