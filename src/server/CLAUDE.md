# src/server/

Node-side MCP server. Three layers:

- **Tool registry core** (`ToolRegistry` + `DaemonCore`) — the single catalog: every host tool, client-module tool, and `useMcpTool` dynamic tool with its real Zod schema (+ serialized wire JSON Schema). `DaemonCore` keeps it in sync with connected clients via `Bridge` events (refcount + schema-hash dedup across clients); the registry emits a coalesced `changed` per tick. Only two "wrapper" tools remain (`wait_until`, `assert`) — they add polling/checkpoint semantics you can't get from a single direct call.
- **MCP fronts** (`McpFront` over a `FrontBackend`) — one per agent session; serve `tools/list` / `tools/call` from a backend and forward `changed` as `notifications/tools/list_changed`. Backends: `localBackend` (in-process core — embedding and tests) and `RemoteBackend` (session proxy → shared daemon over WS).
- **Bridge** — the WebSocket server React Native apps connect to; also routes session-proxy connections (`PROXY_PATH`) to the daemon's `ProxyService`.

**Process model (CLI):** each agent session spawns `cli.js` as a thin stdio **proxy**; the first proxy spawns a detached **daemon** (`cli.js --daemon`) that owns the bridge, the registry, and all app state. Every subsequent session attaches to the same daemon — N sessions, one catalog, one app connection. The daemon exits on its own once the last proxy has been gone for `DAEMON_IDLE_TIMEOUT_MS` (60 s).

`host/` (own [CLAUDE.md](host/CLAUDE.md)) and `metro/` (own [CLAUDE.md](metro/CLAUDE.md)) are sibling subsystems exposed as host modules.

## File map

| File                         | Role                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [cli.ts](cli.ts)             | `#!/usr/bin/env node` shim. Default mode runs the session proxy (`runProxy`); `--daemon` runs the daemon (`runDaemon`); `--doctor` runs the human-facing diagnosis (`runDoctorCli`). `--port` / `--no-host` pass through. |
| [proxyMain.ts](proxyMain.ts) | `runProxy` — connects to the daemon (via `connectOrSpawnDaemon`), serves MCP over stdio through a backend shim that survives daemon restarts; respawn + reconnect loop on daemon loss. |
| [daemonSpawn.ts](daemonSpawn.ts) | `spawnDaemon` (detached `cli.js --daemon`, stderr → `DAEMON_LOG_PATH` in os tmpdir) + `connectOrSpawnDaemon` (connect, spawn once if silent, retry; rethrows `VersionMismatchError`). Shared by the proxy and the `--doctor` CLI. |
| [doctorCli.ts](doctorCli.ts) | `runDoctorCli` — connects like a session (spawning a daemon if needed), waits a bounded window for the app to (re)connect, calls `host__doctor`, prints `formatDoctorReport` (pure, unit-tested), exits 0/1. The doctor's own transient proxy is counted in `sessions`. |
| [daemonMain.ts](daemonMain.ts) | `runDaemon` — bridge + core + `ProxyService`; quiet exit on the spawn race (`EADDRINUSE` → another daemon won); graceful shutdown on signals / idle. |
| [proxyService.ts](proxyService.ts) | Daemon side of the proxy protocol: answers `list_tools` / `call_tool`, pushes `tools_changed`, counts proxies, arms the idle-shutdown timer. First `list_tools` gated once per daemon on `waitForFirstClient(2000)`. |
| [remoteBackend.ts](remoteBackend.ts) | Proxy side: `FrontBackend` over the WS connection; request correlation + timeouts; `VersionMismatchError` when daemon and session run different package versions (they must match exactly); emits `down` on socket loss. |
| [toolRegistry.ts](toolRegistry.ts) | `ToolRegistry` — name → { description, Zod validator, wire JSON Schema, handler }; validates args (invalid → in-band `isError` text with the Zod issues JSON; unknown tool → MethodNotFound via fronts); coalesced `changed` event. |
| [daemonCore.ts](daemonCore.ts) | `DaemonCore` — registry + bridge subscription (acquire/release with refcount + schema-hash dedup), host-tool + wrapper-tool registration, `makeToolHandler` dispatch pipeline, `waitForFirstClient`. |
| [mcpFront.ts](mcpFront.ts)   | `McpFront` — low-level SDK `Server` per session over a `FrontBackend`; `localBackend(core)` adapter. The deprecated low-level `Server` is intentional: a passthrough front serves a catalog owned elsewhere, which `McpServer` cannot express. |
| [index.ts](index.ts)         | `createServer(config)` — single-process embedding mode (bridge + `McpServerWrapper` + stdio); not used by the CLI anymore. |
| [types.ts](types.ts)         | `ServerConfig` (`port?`, `hostModules?`).                                                                         |
| [bridge.ts](bridge.ts)       | WebSocket server + sticky clientId + pending-request RPC + proxy-connection routing.                              |
| [mcpServer.ts](mcpServer.ts) | `McpServerWrapper` — compat composition (`DaemonCore` + local `McpFront`) for embedding and the integration tests (`connectTransport`); also exports `PACKAGE_VERSION`. |
| [instructions.ts](instructions.ts) | `BASE_INSTRUCTIONS` — the markdown prelude served to every connected MCP client.                     |
| [dispatch.ts](dispatch.ts)   | `buildHostToolMap` + `createDispatcher` — pure functions producing the `ServerContext.dispatchTool`.              |
| [inputSchemaToZod.ts](inputSchemaToZod.ts) | `convertInputSchema` — a Zod schema (host tools) or the wire JSON Schema node (clients serialize their Zod schemas via `z.toJSONSchema`); restored with `z.fromJSONSchema`, permissive fallback + stderr warning on failure. Root forced loose + injected `clientId`; undeclared args pass through to handlers. `hashInputSchema` — canonical dedup hash (examples stripped recursively). |
| [helpers.ts](helpers.ts)     | Shared types (`ServerContext`, `HostToolEntry`, `DispatchResult`, `ClientIdsParse`, `BroadcastDispatch`) + utilities (`parseCallArgs`, `parseClientIds`, `buildBroadcastContent`, `jsonError`, `canonicalize`, `formatResult`, `detectShadowedOuterArgs`). |
| [predicate.ts](predicate.ts) | `Predicate` types + `resolvePath` / `evalPredicate` / `isLeafPredicate` — used by `wait_until` + `assert`.        |
| [tools/](tools/)             | The two wrapper tools (`wait_until`, `assert`). Each exports `register<Name>Tool(mcp, ctx)`.                      |

## Direct tool registration (`daemonCore.ts` + `toolRegistry.ts`)

Every tool lives top-level in the registry with its real Zod schema:

- **Host tools** — registered once in the `DaemonCore` constructor; static for the server's lifetime (they work with zero clients connected).
- **Client-module tools + dynamic tools** — acquired/released through `Bridge` events (`clientAdded` / `clientRemoved` / `clientReregistered` / `dynamicToolAdded` / `dynamicToolRemoved`). Two clients shipping the same tool with a matching schema hash share one registry entry (refcount); a schema mismatch keeps the first registration and logs a warning. `bridgeStopping` drains module tools.
- **`clientId` injection** — `convertInputSchema` adds an optional `clientId` field to every tool. The shared handler (`makeToolHandler`) parses it with `parseClientIds`, so every direct tool supports the same literal / `/regex/` / array broadcast forms the legacy `call` meta-tool had. Broadcast aggregation: text-only results collapse into one `{ okCount, failedCount, results: [...] }` envelope; image results emit per-client `## <clientId>` blocks.
- **Validation at the registry** — fronts don't validate; `registry.call` parses raw args through the entry's Zod schema. Failure returns the issues JSON as an in-band `isError` text result (the shape the high-level SDK produced); an unknown tool surfaces as an MCP MethodNotFound protocol error with a recovery hint.
- **`list_changed` coalescing** — the registry batches same-tick set/delete into one `changed`; every front (local and each proxy session) forwards it as its own `notifications/tools/list_changed`.

Dynamic tools from `useMcpTool` register under their wire name (`DYNAMIC_PREFIX` fallback in `dispatch.ts` still resolves `__dynamic__*` names).

## Multi-session daemon

- **Same port, two protocols**: RN apps connect to the WS root; session proxies connect on `PROXY_PATH` (`/mcp-proxy`, `shared/proxyProtocol.ts`) and the bridge routes them to `ProxyService` via the `proxyConnection` event. One port to configure, no second listener. The bridge also counts live proxy sockets (`proxySessionCount()`, exposed for `host__doctor`) independently of `ProxyService` — it's the router and exists in embedding mode too, where the count is 0.
- **Spawn race is by design**: two first-sessions may both spawn a daemon; the loser exits quietly on `EADDRINUSE` (exit 0 — not an error), both proxies connect to the winner. Don't "fix" the quiet exit into a verdict — the verdict path belongs to the proxy (`formatProxyStartupVerdict`), which fires only when the port holder doesn't speak the proxy protocol.
- **Version handshake is exact-match on the npm package version** (`proxy_hello`). Proxy and daemon ship in one package; a mismatch means two installs are alive (typically a stale daemon) — the proxy refuses with a message naming the daemon pid rather than serving a catalog whose schemas may differ.
- **Idle lifecycle**: the daemon exits 60 s after it goes *fully* idle — no session proxies AND no app clients (`isAnyClientConnected()`). A daemon with a live app but no agent session stays up, so the next session attaches to a connected app with full sticky state instead of killing the app connection and forcing a reconnect to a fresh daemon. The timer is re-evaluated on proxy churn AND on `clientAdded`/`clientRemoved`; arming is a no-op while a countdown runs (an idle-keeping event doesn't reset the clock), and the fire callback re-checks idle. Ghosts don't count as clients (`isAnyClientConnected` reads live clients only), so a closed app still lets the daemon idle-exit. Zombie proxies (host keeps the pipe open) hold the daemon alive but harm nothing: they own no port.
- **Death of an *established* daemon is survivable**: `reconnectForever` (proxyMain) catches the backend `down`, respawns the daemon, reconnects, re-broadcasts `list_changed`; the MCP session stays up. Apps re-register on reconnect, so the catalog rebuilds itself — daemon state (sticky ghosts) is the only loss.
- **`connectOrSpawnDaemon` spawns exactly once per call** — no spawn storm. Corollary edge: if the very first daemon dies *during the proxy's initial connect* (before it's established, so before `reconnectForever` is wired), that single call exhausts its ~10 s window and throws → the proxy exits → the host restarts the session. That's session-level self-heal, deliberately not a proxy-level respawn (respawning inside the connect loop would risk a storm). Sub-second window, benign in practice.
- **`Bridge.stop()` terminates sockets** — `wss.close()` alone only stops accepting; without explicit `terminate()` of live app + proxy sockets, daemon shutdown would hang until every peer left on its own.

These lifecycle edges are exercised by the `multiSession` integration suite and were additionally chaos-verified manually (real `cli.js` processes on an isolated port): concurrent spawn race → one daemon serves both; N=8 concurrent proxies → one daemon, identical catalog; version skew → mismatched proxy refused by pid, daemon keeps serving; established-daemon SIGKILL → proxy respawns a fresh daemon and stays alive; full idle (no proxies AND no clients) → daemon exits within the 60 s window, while a live app with no session keeps it up.

## Wrapper tools (`tools/`)

Both export a def factory (`waitUntilToolDef(ctx)` / `assertToolDef(ctx)`) returning `{ name, description, annotations, schema, handler }` — `DaemonCore` registers them into the registry like every other tool.

- **[tools/waitUntil.ts](tools/waitUntil.ts) → `wait_until`** — polls any tool until a predicate holds or timeout. Leaf predicate `{ op, path?, value? }` supports `equals / notEquals / contains / notContains / exists / notExists / gt / gte / lt / lte`. Compound `{ all }` / `{ any }` / `{ not }` nest. Defaults: `timeoutMs=10000` (min 500, max 60000), `intervalMs=300` (min 50, max 5000). Single client returns `{ ok: true, attempts, elapsedMs, matched? }` (matched = path-resolved value for leaf, omitted for compound) or `{ ok: false, reason, attempts, elapsedMs, lastResult, lastError? }` on timeout. Broadcast (`clientId: string[]` or regex) polls each client in parallel under the shared timeout and returns `{ ok, okCount, failedCount, perClient: [{ clientId, ok, attempts, elapsedMs, matched? | lastResult, lastError? }, ...] }` — overall `ok` is true only when every client matched.
- **[tools/assert.ts](tools/assert.ts) → `assert`** — single-shot checkpoint. Same predicate vocabulary. Single client return shapes: `{ pass: true, actual? }` / `{ pass: false, actual, expected?, op?, path?, message?, result }` / `{ pass: false, error, message? }` on dispatch throw. Broadcast (`clientId: string[]` or regex) returns `{ pass, passedCount, failedCount, perClient: [{ clientId, pass, ... }, ...] }` with `pass` aggregated as `all`.
`connection_status` lives in the host module now ([host/tools/connectionStatus.ts](host/tools/connectionStatus.ts) → `host__connection_status`) — same payload as the legacy meta-tool (clients + lifecycle `status` + `disconnected` ghosts with `expiresInMs`), registered like any other host tool.

`ServerContext` (defined in `helpers.ts`) carries the shared state the wrapper tools need: `bridge`, `dispatchTool`. `DaemonCore` builds one in its constructor and threads it to each tool def factory.

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

## Lint note

`@modelcontextprotocol/sdk` deep imports keep their `.js` suffix (ESM layout); `import/extensions` runs in `ignorePackages` mode so package imports pass everywhere. Module resolution for eslint-plugin-import goes through `eslint-import-resolver-typescript` (reads `tsconfig.json` paths and package `exports` maps) — don't reintroduce the alias resolver, it chokes on exports-mapped subpaths.
