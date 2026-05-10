import { type McpModule } from '@/client/models/types';
import {
  applyProjection,
  makeProjectionSchema,
  projectAsValue,
  type ProjectionArgs,
} from '@/shared/projectValue';

import { type NamedStorage, type StorageAdapter } from './types';

// `get_item` returns `{ key, value }`. Default depth 2 — outer object
// expanded, value walked one level (top-level fields visible, nested
// containers collapse to markers).
const ITEM_DEFAULT_DEPTH = 2;

// `get_all` returns `{ key1: val1, key2: val2 }`. Default depth 1 —
// keys visible, every value collapses to `${obj}`/`${arr}` marker.
// Drill specific keys via `path: 'key1.foo.bar'`.
const ALL_DEFAULT_DEPTH = 1;

const ITEM_SCHEMA = makeProjectionSchema(ITEM_DEFAULT_DEPTH);
const ALL_SCHEMA = makeProjectionSchema(ALL_DEFAULT_DEPTH);

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
the first-registered one.

\`get_item\` and \`get_all\` accept the standard \`path\` / \`depth\` /
\`maxBytes\` projection args — heavy nested values collapse to
\`\${obj}\`/\`\${arr}\` markers; drill via path. For \`get_item\` the
response is \`{ key, value }\` — path starts from there
(\`path: 'value.user.name'\`). For \`get_all\` the response is the
key→value object — path starts from a key
(\`path: 'session.user.email'\`).`,
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
        description:
          'All key-value pairs; values JSON-parsed when possible. Default projection collapses each value to a marker — use `path` to drill specific keys.',
        handler: async (args) => {
          const storage = getStorage(args.storage as string | undefined);
          if (!storage) return { error: 'Storage not found' };
          if (!storage.getAllKeys) return { error: 'This storage does not support getAllKeys' };
          const keys = await storage.getAllKeys();
          const entries: Record<string, unknown> = {};
          for (const key of keys) {
            entries[key] = tryParseJson(await storage.get(key));
          }
          return applyProjection(
            entries,
            args as ProjectionArgs,
            projectAsValue,
            ALL_DEFAULT_DEPTH
          );
        },
        inputSchema: {
          ...ALL_SCHEMA,
          storage: { description: 'Storage name (default: first).', type: 'string' },
        },
      },
      get_item: {
        description: 'Value for one key; JSON-parsed when possible.',
        handler: async (args) => {
          const storage = getStorage(args.storage as string | undefined);
          if (!storage) return { error: 'Storage not found' };
          const value = await storage.get(args.key as string);
          const result = { key: args.key, value: tryParseJson(value) };
          return applyProjection(
            result,
            args as ProjectionArgs,
            projectAsValue,
            ITEM_DEFAULT_DEPTH
          );
        },
        inputSchema: {
          ...ITEM_SCHEMA,
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
