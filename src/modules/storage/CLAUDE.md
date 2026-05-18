# `src/modules/storage/` — Multi-storage key-value inspection

[`storage.ts`](storage.ts) exports `storageModule(...storages: NamedStorage[])`, registered as `storage`. Several named key-value stores (MMKV, AsyncStorage, secure stores, custom in-memory caches) share one module — every tool takes an optional `storage` argument to pick which one. See [`src/modules/CLAUDE.md`](../CLAUDE.md) for the shared module / projection conventions; this file documents only the storage-specific contracts.

## Adapter contract

[`types.ts`](types.ts):

```ts
interface StorageAdapter {
  get: (key: string) => string | undefined | null | Promise<string | undefined | null>;
  delete?: (key: string) => void | Promise<void>;
  getAllKeys?: () => string[] | Promise<string[]>;
  set?: (key: string, value: string) => void | Promise<void>;
}

interface NamedStorage {
  adapter: StorageAdapter;
  name: string;
}
```

Only `get` is required. `set` / `delete` / `getAllKeys` are optional capabilities — the corresponding tools return `{ error: 'This storage does not support <set|delete|getAllKeys>' }` ([storage.ts:62, 79, 128, 156](storage.ts)) when the adapter omits them. Adapters may be sync or async; the module always `await`s. The value channel is `string` only — non-string values get JSON-stringified on write and JSON-parsed on read.

This shape happens to align cleanly with both MMKV (`getString` / `set` / `delete` / `getAllKeys`, all sync) and AsyncStorage (`getItem` / `setItem` / `removeItem` / `getAllKeys`, all async returning `Promise<…>`). Method renames are the caller's job — wire them into the adapter object.

## Multi-storage selection

`getStorage(name?)` ([storage.ts:34](storage.ts)) resolves the target adapter: passing `storage` looks up the first match by `name`; omitting it defaults to `storages[0]`. When no match exists every tool returns `{ error: 'Storage not found' }` ([storage.ts:61](storage.ts)). Registration order matters — the first-registered store is the implicit default, so put the app's primary store first.

## Tools

### `get_item({ key, storage?, path?, depth?, maxBytes? })`

Returns `{ key, value }` where `value` is JSON-parsed when possible, raw string otherwise; `value: undefined` when the adapter returns `null` / `undefined` ([storage.ts:24-31](storage.ts)). Projected with default depth 2 — outer object expanded, value walked one level (top-level fields visible, nested containers collapse to `${obj}` / `${arr}` markers). Drill deeper via `path: 'value.user.email'` or bump `depth`.

### `set_item({ key, value, storage? })`

Writes a value. Strings are passed through unchanged; non-strings (objects / arrays / numbers / booleans) are `JSON.stringify`-ed ([storage.ts:157](storage.ts)) so a subsequent `get_item` round-trips the structure. Returns `{ key, success: true }`. Errors with `'This storage does not support set'` when `adapter.set` is missing.

### `delete_item({ key, storage? })`

Returns `{ key, success: true }`. Errors with `'This storage does not support delete'` when `adapter.delete` is missing. No-op semantics if the key doesn't exist are the adapter's call — the module doesn't check first.

### `list_keys({ storage? })`

Returns `{ keys: string[] }`. Errors with `'This storage does not support getAllKeys'` when the capability is missing.

### `get_all({ storage?, path?, depth?, maxBytes? })`

Returns a flat `{ key1: parsedValue1, key2: parsedValue2, … }` object, JSON-parsed per key. Iterates `getAllKeys()` then calls `get` per key sequentially ([storage.ts:80-84](storage.ts)) — costly on large stores; prefer `list_keys` + targeted `get_item` for big MMKV instances. Requires `getAllKeys`. Default depth 1: keys visible, every value collapses to a marker — drill via `path: 'session.user.email'`.

### `list_storages`

No args. Returns `Array<{ keyCount, name }>` for every registered store; `keyCount` is `'unknown'` (string) when the adapter lacks `getAllKeys` ([storage.ts:142-147](storage.ts)). Useful when an agent doesn't know which `storage` name to pass.

## Behavior notes

- **JSON-parse fallback**: `tryParseJson` returns `undefined` for null / undefined, the parsed value on success, and the original string on `JSON.parse` throw — agents see structured data when the stored value is `'{"foo":1}'` and a plain string when it's `'hello'`.
- **String values round-trip raw**: `set_item({ value: '{"foo":1}' })` writes `{"foo":1}` literally; `get_item` then parses it back into an object. To store a literal JSON-looking string, the caller must accept that round-trip.
- **No bulk write / delete**: `set_all` / `clear` aren't exposed — agents loop `set_item` / `delete_item` per key, or call adapter-specific tools out-of-band.
- **Error envelope vs throw**: every "unsupported" / "not found" path returns `{ error: '…' }` rather than throwing, so the agent sees the failure inline in the tool response instead of as a top-level MCP error.
- **No write hooks**: writes don't trip any capture / notification — there's no equivalent of the `console` / `errors` / `network` ring buffer here. Reads always hit the adapter live.
