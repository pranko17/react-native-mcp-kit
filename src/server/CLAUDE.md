# src/server/

Node-side MCP server. Two halves:

- **MCP tools layer** — direct top-level registration: every host tool, client-module tool, and `useMcpTool` dynamic tool is a first-class MCP tool with its real Zod schema. `McpServerWrapper` keeps the registry in sync with connected clients via `Bridge` events (refcount + schema-hash dedup across clients) and emits `notifications/tools/list_changed` on every change. Only two "wrapper" tools remain (`wait_until`, `assert`) — they add polling/checkpoint semantics you can't get from a single direct call.
- **Bridge** — the WebSocket server React Native apps connect to.

`host/` (own [CLAUDE.md](host/CLAUDE.md)) and `metro/` (own [CLAUDE.md](metro/CLAUDE.md)) are sibling subsystems exposed as host modules.

## File map

| File                         | Role                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [cli.ts](cli.ts)             | `#!/usr/bin/env node` shim. Parses `--port` / `--no-host`, calls `createServer`.                                  |
| [index.ts](index.ts)         | `createServer(config)` — boots `Bridge`, instantiates `McpServerWrapper`, wires shutdown signals.                 |
| [types.ts](types.ts)         | `ServerConfig` (`port?`, `hostModules?`).                                                                         |
| [bridge.ts](bridge.ts)       | WebSocket server + sticky clientId + pending-request RPC.                                                         |
| [mcpServer.ts](mcpServer.ts) | `McpServerWrapper` — registers host tools at startup, subscribes to `Bridge` events to acquire/release client-module + dynamic tools (refcount, schema-hash dedup), coalesces `list_changed` broadcasts, registers `wait_until`/`assert`. `start()` waits up to 2 s for the first RN client so an already-running app lands its tools in the very first `tools/list`. |
| [instructions.ts](instructions.ts) | `BASE_INSTRUCTIONS` — the markdown prelude the SDK ships to every connected MCP client.                     |
| [dispatch.ts](dispatch.ts)   | `buildHostToolMap` + `createDispatcher` — pure functions producing the `ServerContext.dispatchTool`.              |
| [inputSchemaToZod.ts](inputSchemaToZod.ts) | `convertInputSchema` — wire-format flat schema → Zod raw shape (+ injected `clientId` field); `hashInputSchema` — canonical dedup hash (examples stripped). |
| [helpers.ts](helpers.ts)     | Shared types (`ServerContext`, `HostToolEntry`, `DispatchResult`, `ClientIdsParse`, `BroadcastDispatch`) + utilities (`parseCallArgs`, `parseClientIds`, `buildBroadcastContent`, `jsonError`, `canonicalize`, `formatResult`, `detectShadowedOuterArgs`). |
| [predicate.ts](predicate.ts) | `Predicate` types + `resolvePath` / `evalPredicate` / `isLeafPredicate` — used by `wait_until` + `assert`.        |
| [tools/](tools/)             | The two wrapper tools (`wait_until`, `assert`). Each exports `register<Name>Tool(mcp, ctx)`.                      |

## Direct tool registration (`mcpServer.ts`)

Every tool is registered top-level against the SDK with its real Zod schema:

- **Host tools** — registered once in the constructor; static for the server's lifetime (they work with zero clients connected).
- **Client-module tools + dynamic tools** — acquired/released through `Bridge` events (`clientAdded` / `clientRemoved` / `clientReregistered` / `dynamicToolAdded` / `dynamicToolRemoved`). Two clients shipping the same tool with a matching schema hash share one MCP entry (refcount); a schema mismatch keeps the first registration and logs a warning. `bridgeStopping` drains the registry.
- **`clientId` injection** — `convertInputSchema` adds an optional `clientId` field to every tool. The shared handler (`makeToolHandler`) parses it with `parseClientIds`, so every direct tool supports the same literal / `/regex/` / array broadcast forms the legacy `call` meta-tool had. Broadcast aggregation: text-only results collapse into one `{ okCount, failedCount, results: [...] }` envelope; image results emit per-client `## <clientId>` blocks.
- **`list_changed` coalescing** — `flushToolListChanged` batches per-tool SDK notifications into one explicit broadcast per tick.

Dynamic tools from `useMcpTool` register under their wire name (`DYNAMIC_PREFIX` fallback in `dispatch.ts` still resolves `__dynamic__*` names).

## Wrapper tools (`tools/`)

Both take `(mcp: McpServer, ctx: ServerContext)` and call `mcp.registerTool(...)` once.

- **[tools/waitUntil.ts](tools/waitUntil.ts) → `wait_until`** — polls any tool until a predicate holds or timeout. Leaf predicate `{ op, path?, value? }` supports `equals / notEquals / contains / notContains / exists / notExists / gt / gte / lt / lte`. Compound `{ all }` / `{ any }` / `{ not }` nest. Defaults: `timeoutMs=10000` (min 500, max 60000), `intervalMs=300` (min 50, max 5000). Single client returns `{ ok: true, attempts, elapsedMs, matched? }` (matched = path-resolved value for leaf, omitted for compound) or `{ ok: false, reason, attempts, elapsedMs, lastResult, lastError? }` on timeout. Broadcast (`clientId: string[]` or regex) polls each client in parallel under the shared timeout and returns `{ ok, okCount, failedCount, perClient: [{ clientId, ok, attempts, elapsedMs, matched? | lastResult, lastError? }, ...] }` — overall `ok` is true only when every client matched.
- **[tools/assert.ts](tools/assert.ts) → `assert`** — single-shot checkpoint. Same predicate vocabulary. Single client return shapes: `{ pass: true, actual? }` / `{ pass: false, actual, expected?, op?, path?, message?, result }` / `{ pass: false, error, message? }` on dispatch throw. Broadcast (`clientId: string[]` or regex) returns `{ pass, passedCount, failedCount, perClient: [{ clientId, pass, ... }, ...] }` with `pass` aggregated as `all`.
`connection_status` lives in the host module now ([host/tools/connectionStatus.ts](host/tools/connectionStatus.ts) → `host__connection_status`) — same payload as the legacy meta-tool (clients + lifecycle `status` + `disconnected` ghosts with `expiresInMs`), registered like any other host tool.

`ServerContext` (defined in `helpers.ts`) carries the shared state the wrapper tools need: `bridge`, `dispatchTool`. `McpServerWrapper` builds one in its constructor and threads it to each `register<Name>Tool`.

## Dispatch (`dispatch.ts`)

`createDispatcher(bridge, hostToolMap)` returns the function every registered tool handler funnels through — direct tool handlers (`makeToolHandler`), `wait_until`, `assert`, and host tools that chain via `HostContext.dispatch` (e.g. `host__tap_fiber` invokes `fiber_tree__query` then `host__tap` without a round-trip).

Resolution order for a `tool` argument:
1. **Host tool** — exact name in `hostToolMap`. Handler runs in-process; receives `HostContext` with a `dispatch` callback that defaults to the original `clientId` when the host tool re-enters without specifying one.
2. **Static module on the resolved client** — `bridge.resolveClient(clientId)` picks the explicit client, the unique connected client, or returns an error. `tool` is split on the first `MODULE_SEPARATOR` (`__`); the module is matched by name on the client; the method is looked up on that module.
3. **Dynamic tool** — `tool` prefixed with `__dynamic__` is routed to the client's dynamic-tools map (registered via `useMcpTool`).

`bridge.call(clientId, module, method, args, timeout?)` is the RPC; default timeout 10 s.

Return shape: `{ ok: true, result }` or `{ ok: false, error }`. The MCP-facing tools wrap success via `formatResult` (image-content passthrough for screenshots, otherwise JSON text) and the error via `jsonError`.

## Bridge (`bridge.ts`)

`Bridge` runs a `WebSocketServer` on the configured port (default `8347`, see `DEFAULT_PORT` in `shared/protocol.ts`).

### Handshake & version gate

On connection, the server sends `server_hello`. The client replies with a `registration` carrying `protocolVersion` + module descriptors + identity fields (`platform`, `deviceId`, `bundleId`, `appName`, `appVersion`, `label`, `devServer`, `isSimulator`). Mismatched `protocolVersion` triggers a `version_mismatch` message and WS close with code `WS_CLOSE_PROTOCOL_MISMATCH = 4010` (see `shared/protocol.ts`). Bump `PROTOCOL_VERSION` on any breaking change to the wire format.

### Sticky clientId

The bridge assigns IDs from a per-platform sequence — `ios-1`, `ios-2`, `android-1`, `client-1` (fallback when `platform` absent). On socket close, the `ClientEntry` is moved to a `disconnectedClients` map keyed by `(platform, deviceId, bundleId)` with `RECONNECT_GRACE_MS = 60 * 60_000` (1 hour) TTL. A re-registering client matching all three keys reuses the same ID — so `ios-1` survives Fast Refresh, app backgrounding, Xcode rebuild, brief network blips.

Ghost entries are invisible to `listClients()` / `getClient(id)`, so **in-app** tool dispatch (direct tools / `wait_until` / `assert`, which need the live WS) correctly reports "not connected". Two read paths do see ghosts: `listDisconnected()` (each ghost records `disconnectedAt`; `expiresInMs` is computed) powers `connection_status`' `disconnected` array — a closed app lingers with a countdown. `getDisconnected(id)` returns the retained `ClientEntry`, which the **host** device resolver falls back to — so OS-level tools (`host__launch_app`, `host__screenshot`, `host__tap`, …) still resolve a recently-closed app by its `clientId` and act on its device within the grace window (e.g. relaunch it). In short: ghost = not callable over the socket, but still a usable device handle.

### App lifecycle state

The client pushes an `app_state` message (`{ appState: 'active' | 'background' | 'inactive' }`) on every RN `AppState` change and once per (re)connect. `handleMessage` stores it on the live `ClientEntry` (`appState` + `lastStateAt`). This disambiguates a still-connected-but-backgrounded app (socket open, JS about to be suspended → tool calls will hang) from an active one — the socket-close signal alone can't, since backgrounding doesn't close the socket. The message is additive (no `PROTOCOL_VERSION` bump): the `handleMessage` switch ignores unknown types, so an older server simply drops it.

### Pending requests

Each `bridge.call(...)` allocates a `requestId` and stores `{ clientId, resolve, reject, timer }` in `pendingRequests`. The matching `tool_response` resolves the promise; an absent response trips the timer (default 10 s, overridable per tool via `ToolHandler.timeout`).

### Dynamic tools

`tool_register` / `tool_unregister` messages add / remove entries in `client.dynamicTools` (`Map<fullName, DynamicToolEntry>`) and emit `dynamicToolAdded` / `dynamicToolRemoved` — the wrapper registers/removes the tool in the live MCP catalog under its wire name (e.g. `__dynamic__<name>`).

## Projection (where it lives, why)

The repo-wide projection vocabulary (`path` / `depth` / `maxBytes` / `previewCap` / `objectCap` / `arrayCap`, `${kind}` markers) and its primitives live in [`../shared/projection/`](../shared/CLAUDE.md). The server tools don't apply projection themselves — each in-app and host module that returns heavy JSON owns its own projection. The MCP tools just stream the handler's already-projected result through `formatResult`.

## Refactor history

`mcpServer.ts` originally bundled all six tool registrations + helpers + instructions in one 1086-line file. The current split into `tools/`, `dispatch.ts`, `helpers.ts`, `predicate.ts`, `instructions.ts` keeps each tool ≤200 lines and lets the class shell stay under 70.

## Lint exemption

[`tools/*.ts`](tools/) and `mcpServer.ts` are exempt from `import/extensions` in `.eslintrc.js` because `@modelcontextprotocol/sdk` requires `.js`-suffixed deep imports (ESM layout). The exemption is per-file, not global — keep new server-side SDK imports inside one of these paths or extend the override.
