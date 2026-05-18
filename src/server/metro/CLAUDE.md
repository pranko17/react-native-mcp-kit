# Metro module (`src/server/metro/`)

Control plane for the Metro dev server. Five host-side tools that talk HTTP (and one persistent WebSocket) to the bundler the React Native app was loaded from — no RN-side bridge round-trip required, so they work even when the JS context is dead (red box, infinite loop, post-crash).

Exported as a `HostModule` named `metro` from [metroModule.ts](metroModule.ts); registered by `createServer` when `hostModule` is enabled.

## URL resolution

Every tool resolves its target URL through [resolveMetroUrl.ts](resolveMetroUrl.ts) (`resolveMetroUrl(args, ctx)`). Priority order:

1. `args.metroUrl` — explicit override.
2. `ctx.bridge.resolveClient(clientId).client.devServer?.url` — origin reported in the handshake (RN's `getDevServer()` via `scriptURL`). `clientId` resolves from `args.clientId` or `ctx.requestedClientId`.
3. `http://localhost:8081` (exported as `DEFAULT_METRO_URL`).

Trailing slash is stripped so call sites can safely template `${url}/reload`. Per-client detection means non-default ports and LAN-attached physical devices Just Work; the fallback only kicks in for production builds or when handshake detection failed.

## Tools

### `metro__symbolicate` — [tools/symbolicate.ts](tools/symbolicate.ts)

POSTs to `/symbolicate`. Maps bundled paths like `http://localhost:8081/index.bundle:12345:67` back to `src/components/Foo.tsx:42:10`.

Inputs (one of `stack` or `frames` required; `frames` wins when both are present):

- `stack?: string` — raw `Error.stack` blob. Parsed via two regex passes (V8 first, Hermes/JSC fallback) inside `parseStackString`.
- `frames?: StackFrame[]` — pre-parsed `{ file, lineNumber, column, methodName? }`.
- `maxFrames?: number` — default `10`, min `1`, max `100`.
- `includeFrameworkFrames?: boolean` — default `false`; drops every frame Metro marks `collapse: true` (node_modules + RN internals).
- `fullPaths?: boolean` — default `false`; absolute paths get shortened relative to `process.cwd()` (URLs untouched; `cwd` becomes `.`).
- `metroUrl?`, `clientId?` — standard URL-resolution knobs.

Stack-parser details:

- `stripErrorHeader` drops a leading line matching `/^\s*[A-Z][A-Za-z]*Error:?(\s|$)/` when it doesn't itself look like a frame (`@` / `at ` absent). V8 and Hermes both prepend this on `Error.stack`.
- V8 regex: `/^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/gm` — handles both `at method (file:L:C)` and bare `at file:L:C`.
- Hermes regex: `/^(.*?)@(\??[^:\n]+?):(\d+):(\d+)$/gm` — accepts `method@file:L:C`, bare `@file:L:C`, `anonymous@…` (method name normalized to `undefined`), and packager-rooted `?anon_N_/abs/path.tsx:L:C` (the `\??` prefix preserves the leading `?` so Metro's `/symbolicate` sees the same string the runtime emitted).

Response:

- Happy path: `{ frames, totalFrames, droppedFrameworkFrames?, truncated? }`. `totalFrames` counts post-`collapse` filtering; `droppedFrameworkFrames` is only present when framework filtering is on; `truncated: true` flags that `maxFrames` clipped the tail.
- Metro reachable but non-2xx: `{ error: "Metro responded <status>", frames: <trimmed input>, skipped: true }`.
- Metro unreachable / fetch threw: `{ error: "Metro at <url> unreachable: <msg>", frames: <trimmed input>, skipped: true }`.
- No frames parseable: `{ error: "No frames parsed from input.", frames: [], skipped: true }`.

5s HTTP timeout (`AbortController`); tool `timeout` is set to 6s so the dispatcher's outer timeout doesn't fire first.

### `metro__reload` — [tools/reload.ts](tools/reload.ts)

POSTs to `/reload`. Equivalent to shaking + tapping Reload. Metro broadcasts, so every attached app reloads — not just the targeted `clientId`. Returns `{ metroUrl, ok: true }` on success, `{ error, metroUrl, ok: false, skipped: true }` on non-2xx or fetch failure. 5s timeout.

### `metro__status` — [tools/status.ts](tools/status.ts)

GETs `/status`. Body must equal the literal `packager-status:running` constant; anything else returns `{ body, error: 'unexpected body: "..."', metroUrl, running: false }`. Reachable + 2xx + correct body → `{ metroUrl, running: true }`. Unreachable → `{ error, metroUrl, running: false }` (note: no `skipped` field here, unlike the other tools — `running` is the only signal). 3s timeout. Cheap pre-flight before a chain of Metro calls.

### `metro__open_in_editor` — [tools/openInEditor.ts](tools/openInEditor.ts)

POSTs to `/open-stack-frame`, which Metro forwards to `$REACT_EDITOR` / `$EDITOR` on the dev machine. Required inputs:

- `file: string` — absolute or repo-relative; paths from `metro__symbolicate` output plug in directly.
- `lineNumber: number` — 1-based.
- `column?: number` — 1-based, optional.

Returns `{ file, lineNumber, metroUrl, ok: true }` on success. Returns `{ error: "`file` is required." }` / `{ error: "`lineNumber` is required (number)." }` for missing inputs (no HTTP attempted). 3s timeout. Pairs naturally with the symbolication flow: `errors__get_errors` → `metro__symbolicate` → `metro__open_in_editor` on the top user frame.

### `metro__get_events` — [tools/events.ts](tools/events.ts) + [eventCapture.ts](eventCapture.ts)

Reads from a server-side ring buffer fed by Metro's `/events` WebSocket. The capture is lazy — first call opens the socket — and auto-reconnects on close with a fixed 3s backoff (`RECONNECT_MS`). Buffer holds the last 200 entries (`DEFAULT_BUFFER_LIMIT`), trimmed FIFO via `splice` when overflowed. Captures are memoized in a module-level `Map<metroUrl, MetroEventCapture>` so multiple clients sharing a URL share one socket.

Each entry: `{ id: <monotonic>, receivedAt: <Date.now()>, type: <string>, data: <rest of the payload> }`. Messages without a string `type` field are silently dropped; malformed JSON is swallowed.

Inputs:

- `type?: string | string[]` — exact-match filter, OR semantics across array elements.
- `since?: number` — ms-epoch lower bound on `receivedAt`.
- `path?` / `depth?` / `maxBytes?` / `previewCap?` / `objectCap?` / `arrayCap?` — standard projection knobs from `makeProjectionSchema(4)`; default depth is `4` so outer (1) → `events` array (2) → event (3) → `data` (4) all expand. Heavier payloads collapse to `${kind}` markers; drill via `path: 'events[-3:]'` for the tail.

Response: `{ metroUrl, connected, events, lastError, total }` — `connected` reports the WebSocket's current `OPEN` state, `lastError` carries the last socket-level error message (cleared on successful reconnect), `total` is the post-filter count.

Event types Metro emits (non-exhaustive): `bundle_build_started`, `bundle_build_done`, `bundle_build_failed`, `bundling_error`, `hmr_update`, `hmr_client_error`, `initial_update_done`, `transform_cache_reset`, `dep_graph_loading`, `dep_graph_loaded`, `client_log`, `worker_stdout_chunk`, `worker_stderr_chunk`. The killer use case: silent HMR failures where the red box never fires — `bundling_error` / `hmr_client_error` already explains the cause.

`MetroEventCapture` also exposes `clear()` and `dispose()`, but neither is currently wired to a tool — buffers live for the process lifetime.

## Conventions shared across tools

- All HTTP tools use `AbortController` + `setTimeout` for hard timeouts (3s for status / open_in_editor, 5s for reload / symbolicate). The MCP tool-level `timeout` is set to `METRO_TIMEOUT_MS + 1_000` so the dispatcher doesn't kill the request before the abort fires.
- All tools return `{ ..., skipped: true, error }` envelopes on unreachable Metro — except `status`, which uses `running: false` as the signal. Callers can treat `skipped` as "no work done, retry later" without distinguishing network errors from non-2xx responses.
- Every input schema has `clientId` and `metroUrl` overrides documented identically. `metroUrl` always wins over `clientId`-derived resolution.
