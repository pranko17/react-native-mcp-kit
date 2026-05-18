# `network/` — fetch + XMLHttpRequest capture

[`network.ts`](network.ts) — `networkModule({ maxEntries?, bodyMaxBytes?, ignoreUrls?, redactHeaders?, redactBodyKeys? })`, registered as `network`. Defaults: `maxEntries: 100`, `bodyMaxBytes: 20_000`, body preview 200 chars. Capture installs at module-import time (`installPatches()` at the bottom of the file), so traffic issued before `<McpProvider>` mounts is still seen — see `src/modules/CLAUDE.md` for the shared side-effectful-capture note. The factory adopts the running buffer and applies options retroactively; `maxEntries` shrinks the buffer in place if lowered.

Entry shape ([types.ts](types.ts)): `{ id, method, url, status: 'pending' | 'success' | 'error', startedAt: ISO string, duration: number | null, request: { headers, body?, bodyBytes? }, response: { status, headers, body?, bodyBytes? } | null }`. `id` is a monotonic counter (`nextId++`), `duration` is filled in once the response settles (or on throw).

## Capture targets

Both hooks live in [network.ts](network.ts) inside `installPatches` (line 167).

`global.fetch` (line 174) is replaced with an async wrapper. The URL is read from a `string` / `URL` / `Request`-shaped input (line 175-176), the method defaults to `'GET'`. After the entry is added with `status: 'pending'`, the original `fetch` is awaited; on success the response is `.clone()`'d and `.text()` is read for body capture (line 211-216) — any clone/text failure leaves `resBody` undefined. On throw, the entry is closed with `status: 'error'`, `response.status: 0`, body set to the error message, and the error is re-thrown.

`XMLHttpRequest` is patched at the prototype level (line 245-340): `open` stashes `__mcp_method` / `__mcp_url` / `__mcp_headers` on the instance; `setRequestHeader` mirrors into that bag; `send` registers a `loadend` listener that records the response. Final status is `success` when `200 <= xhr.status < 400`, else `error`. Response body branches on `responseType`:

- `''` / `'text'` — `responseText`
- `'json'` — `response` (already parsed by the runtime)
- `'blob'` / `'arraybuffer'` / `'document'` — recorded as the literal string `[blob]` / `[arraybuffer]` / `[document]` with `bodyBytes: 0` (the raw payload is never serialized)

Response headers are parsed out of `getAllResponseHeaders()` (CRLF-split, `'<key>: <value>'` reduce).

`shouldIgnore(url, ignoreUrls)` (line 54) gates both paths — string entries are matched via `url.includes`, RegExp entries via `pattern.test`. Default ignore list (line 20): `/^ws:/`, `/^wss:/`, `/localhost:8081/`, `/symbolicate/`. The `ignoreUrls` option **appends** to defaults (line 368: `[...DEFAULT_IGNORE_URLS, ...options.ignoreUrls]`) — there's no way to drop a built-in pattern.

## Body capture

`captureBody(raw, bodyMaxBytes, compiledBodyRedact)` (line 106) is the single funnel for both request and response bodies:

1. `null` / `undefined` raw → return `undefined` (no body field on the entry).
2. `bodyMaxBytes <= 0` → return `undefined`. Pass `bodyMaxBytes: 0` to disable body capture entirely.
3. If `raw` is a string, `tryParseJson` (line 75) attempts `JSON.parse`; on failure the original string is kept.
4. `redactValue(parsed, compiledBodyRedact)` from [`@/shared/projection/redact`](../../shared/projection/redact.ts) walks the value recursively, replacing matching keys with `'[redacted]'`.
5. `byteLengthOf(redacted)` measures size — string length for strings, `JSON.stringify(...).length` otherwise, `0` on stringify failure (cycles / BigInt).
6. If `bytes > bodyMaxBytes`, the body collapses to `{ "${str}": { len: bytes, preview: <first 200 chars> } }` (preview is the redacted string for strings, or `JSON.stringify(redacted).slice(0, 200)` for objects). Otherwise the redacted value is stored raw.

`bodyBytes` always reflects the **redacted** captured size (not the pre-redact size), and is preserved even when the body collapses to a marker — `get_stats` reads it for byte totals.

Bodies are stored raw (no `projectValue` walk) so query-time `path` / `depth` drills freely; projection runs once at handler exit via `applyProjection` (line 345).

## Redaction

`compileRedact(patterns)` from [`@/shared/projection/redact`](../../shared/projection/redact.ts) builds a matcher used at capture time. `resolveRedactList(override, defaults)` (line 349) implements: `undefined` → defaults; `false` → empty matcher (disabled); array → caller's exact list (replaces, does not extend).

Header defaults (line 27, case-insensitive): `authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`, `x-access-token`. Matched values are replaced with `'[redacted]'` via `redactHeadersMap` on the parsed headers object.

Body-key defaults (line 35): `accessToken`, `apiKey`, `otp`, `password`, `pin`, `refreshToken`, `secret`, `token`. `redactValue` recurses into nested objects and arrays without depth limit — any key match at any depth gets replaced. The match runs against the redacted shape, so the bytes count for `${str}` overflow reflects the post-redact size.

## Tools

Description (line 378) doubles as agent-facing guidance. `inputSchema` uses the shared `makeProjectionSchema(NETWORK_DEFAULT_DEPTH)` (default depth 3 — array → entry → request/response expanded; headers map and body collapse to markers; drill via `path` or bump `depth`).

### get_requests

`get_requests({ method?, status?, url?, path?, depth?, maxBytes? })` (line 399). Filters: `method` is uppercased then compared against `entry.method`; `status` matches one of `'pending' | 'success' | 'error'`; `url` is a substring match. Filter order is method → status → url, all applied as `Array.filter`. The result array is projected with default depth 3. Drill examples: `path: '[-1:][0].response.body'` for the last response body, `path: '[-1:][0].request.headers'` to see one request's headers.

### get_stats

`get_stats` (line 437). One linear pass over the buffer building:

- `total: buffer.length`
- `byStatus` — pre-seeded with `{ error: 0, pending: 0, success: 0 }` so the shape is stable
- `byMethod` — sparse, accumulated on demand
- `bytes` — sum of `request.bodyBytes ?? 0` plus `response?.bodyBytes ?? 0`
- `durationMs.{min, p50, p95, max}` — durations sorted ascending; `percentile(sorted, p)` (line 135) returns `sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]`. Note this is a floor-index estimator (no interpolation), so `p50` on 4 samples reads index 2 (not the average of index 1 and 2). `min`/`max` are `sorted[0]` / `sorted[length - 1]`; all four fields return `null` when no entries have a numeric `duration` (pending requests excluded).

### clear_requests

`clear_requests` (line 392). `buffer.length = 0`; `nextId` is not reset, so IDs keep monotonically increasing across clears.
