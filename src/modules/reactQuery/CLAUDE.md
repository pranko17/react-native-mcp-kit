# `reactQuery/` — React Query cache inspection + mutation

[`reactQuery.ts`](reactQuery.ts) — `reactQueryModule(queryClient: QueryClientLike)`, **registered as `query`** (not `reactQuery`). Agents call `call(tool: "query__get_data")`, never `reactQuery__get_data`. Registered by `<McpProvider>` when the `queryClient` prop is supplied. See [`src/modules/CLAUDE.md`](../CLAUDE.md) for the module interface, projection knobs, and registration conventions.

## Adapter shape

[`types.ts`](types.ts) declares the structural `QueryClientLike` — any object satisfying:

```ts
{
  getQueryCache: () => { getAll: () => Query[] };
  invalidateQueries: (filters?: { queryKey?: readonly unknown[] }) => Promise<void>;
  refetchQueries:    (filters?: { queryKey?: readonly unknown[] }) => Promise<void>;
  removeQueries:     (filters?: { queryKey?: readonly unknown[] }) => void;            // synchronous
  resetQueries:      (filters?: { queryKey?: readonly unknown[] }) => Promise<void>;
}
```

Each `Query` exposes `{ queryHash, queryKey, state: { dataUpdatedAt, errorUpdatedAt, fetchStatus, status, data?, error? } }`. Any TanStack-Query-compatible client (or a hand-rolled mock for tests) drops in without further wrapping. `errorUpdatedAt` is part of the contract but is **not surfaced** by any tool — only `dataUpdatedAt` is returned.

## Query keys

Keys ride through tool args as JSON strings to preserve array structure inside the flat string-keyed schema. `parseKey` ([`reactQuery.ts:53-60`](reactQuery.ts)) runs `JSON.parse`; if the result isn't an array it gets wrapped (`'"users"'` → `["users"]`), and a parse failure falls back to `[keyStr]` (so `users` without quotes degenerates gracefully to `["users"]` rather than throwing). Match against `queryKey` is exact via `JSON.stringify` round-trip — there's no partial-key matching.

## Tools

### `get_queries`

`{ status?, key?, ...projection }` → array of compact metadata entries, **never** `data`. Per-entry fields produced by `serializeQuery` ([`reactQuery.ts:23-46`](reactQuery.ts)): `{ dataUpdatedAt, fetchStatus, hasData, hasError, hash, key, status }`. `dataUpdatedAt` is an ISO string when truthy or `null` when 0/unset; `hasData` / `hasError` are derived from `state.data !== undefined` / `state.error !== undefined`. Filters: `status` is exact-match on `'pending' | 'error' | 'success'`; `key` is a **substring match on `queryHash`** (the TanStack-Query-serialized form), so `'users'` matches `'["users","list"]'`. Default depth 2 — array opened, each entry opened with primitives inline.

### `get_data`

`{ key, ...projection }` → full state for one query: `{ data, dataUpdatedAt, error, fetchStatus, key, status }`. `error` is coerced via `String(query.state.error)` (so `Error` objects become `"Error: msg"`); `dataUpdatedAt` is ISO-or-null as above. Missing key returns `{ error: 'Query with key <raw> not found' }` (no throw — surfaces in the tool response). `data` can be arbitrarily heavy, so default depth 2 walks `data` one level — drill via `path: 'data.user.email'` or bump `depth`.

### `get_stats`

No args. Returns `{ byFetchStatus, byStatus, total }` — counts walked once over the full cache. No projection input.

### `mutate`

`{ action: 'invalidate' | 'refetch' | 'remove' | 'reset', key? }` — consolidates all four cache mutations into one tool ([`reactQuery.ts:155-192`](reactQuery.ts)). Omitting `key` passes `filters: undefined` so the action targets **every** cached query. Returns `{ action, success: true }` on success or `{ error }` when `action` is missing / unrecognised. `invalidate` / `refetch` / `reset` are awaited (the underlying methods are async); `remove` is synchronous but the handler is still `async`, so the response shape is uniform.

| `action`     | Effect                                                              |
| ------------ | ------------------------------------------------------------------- |
| `invalidate` | Marks queries stale — refetches on next mount / focus.              |
| `refetch`    | Refetches immediately, regardless of staleness.                     |
| `remove`     | Drops queries from the cache entirely (synchronous).                |
| `reset`      | Clears `data` + `error` back to the query's initial state.          |
