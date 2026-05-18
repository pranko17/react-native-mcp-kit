# src/server/

Node-side MCP server. Two halves:

- **MCP tools layer** — the 6 static tools (`call`, `wait_until`, `assert`, `list_tools`, `describe_tool`, `connection_status`) registered against `@modelcontextprotocol/sdk`. They dispatch to either host tools (in-process) or client tools (over WS).
- **Bridge** — the WebSocket server React Native apps connect to.

`host/` (own [CLAUDE.md](host/CLAUDE.md)) and `metro/` (own [CLAUDE.md](metro/CLAUDE.md)) are sibling subsystems exposed as host modules.

## File map

| File                         | Role                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [cli.ts](cli.ts)             | `#!/usr/bin/env node` shim. Parses `--port` / `--no-host`, calls `createServer`.                                  |
| [index.ts](index.ts)         | `createServer(config)` — boots `Bridge`, instantiates `McpServerWrapper`, wires shutdown signals.                 |
| [types.ts](types.ts)         | `ServerConfig` (`port?`, `hostModules?`).                                                                         |
| [bridge.ts](bridge.ts)       | WebSocket server + sticky clientId + pending-request RPC.                                                         |
| [mcpServer.ts](mcpServer.ts) | `McpServerWrapper` shell — builds `hostToolMap`, builds dispatcher, builds `ServerContext`, registers all 6 tools.|
| [instructions.ts](instructions.ts) | `BASE_INSTRUCTIONS` — the markdown prelude the SDK ships to every connected MCP client.                     |
| [dispatch.ts](dispatch.ts)   | `buildHostToolMap` + `createDispatcher` — pure functions producing the `ServerContext.dispatchTool`.              |
| [helpers.ts](helpers.ts)     | Shared types (`ServerContext`, `HostToolEntry`, `ToolGroup`, `ToolDescriptorShape`, `DispatchResult`) + utilities (`parseCallArgs`, `jsonError`, `canonicalize`, `canonicalizeGroup`, `findToolInClient`, `buildToolGroups`, `formatResult`). |
| [predicate.ts](predicate.ts) | `Predicate` types + `resolvePath` / `evalPredicate` / `isLeafPredicate` — used by `wait_until` + `assert`.        |
| [tools/](tools/)             | One file per registered MCP tool. Each exports `register<Name>Tool(mcp, ctx)`.                                    |

## MCP tools (`tools/`)

All six tools take `(mcp: McpServer, ctx: ServerContext)` and call `mcp.registerTool(...)` once. The split exists to keep each tool's z-schema + handler legible — every file is self-contained and reads top-to-bottom.

- **[tools/call.ts](tools/call.ts) → `call`** — universal dispatcher. Format: `call(tool: "module__method", args: {...})`. `args` is either a plain object or a JSON string (`parseCallArgs` in `helpers.ts` normalises). Dynamic tools from `useMcpTool` hooks use the `__dynamic__` prefix: `call(tool: "__dynamic__logout")` (the literal constant is `DYNAMIC_PREFIX` in [`shared/protocol.ts`](../shared/protocol.ts)). When multiple clients are connected, `clientId` must be specified.
- **[tools/waitUntil.ts](tools/waitUntil.ts) → `wait_until`** — polls any tool until a predicate holds or timeout. Leaf predicate `{ op, path?, value? }` supports `equals / notEquals / contains / notContains / exists / notExists / gt / gte / lt / lte`. Compound `{ all }` / `{ any }` / `{ not }` nest. Defaults: `timeoutMs=10000` (min 500, max 60000), `intervalMs=300` (min 50, max 5000). Returns `{ ok: true, attempts, elapsedMs, matched? }` (matched = path-resolved value for leaf, omitted for compound) or `{ ok: false, reason, attempts, elapsedMs, lastResult, lastError? }` on timeout.
- **[tools/assert.ts](tools/assert.ts) → `assert`** — single-shot checkpoint. Same predicate vocabulary. Three return shapes: `{ pass: true, actual? }` / `{ pass: false, actual, expected?, op?, path?, message?, result }` / `{ pass: false, error, message? }` on dispatch throw.
- **[tools/listTools.ts](tools/listTools.ts) → `list_tools`** — lists all tools across all clients, grouped by module, with compact (schema-less) output. Clients with structurally identical modules are deduplicated into one entry with a `clientIds` array (canonical key via `canonicalizeGroup`). Filters: `module?`, `clientId?`, `compact?: boolean` (drop module-level descriptions). Always includes connected-client metadata + host modules.
- **[tools/describeTool.ts](tools/describeTool.ts) → `describe_tool`** — full input schema for one tool. Three-step resolve: (1) host tool by exact name in `hostToolMap`, (2) explicit `clientId` lookup, (3) auto-pick by canonicalising matching descriptors across clients — single canonical shape returns; multiple shapes ask for `clientId`.
- **[tools/connectionStatus.ts](tools/connectionStatus.ts) → `connection_status`** — connected clients with `id`, `platform`, `label`, `deviceId`, `bundleId`, `appName`, `appVersion`, `devServer`, `connectedAt`, and registered module names; plus host module names.

`ServerContext` (defined in `helpers.ts`) carries the shared state every tool file needs: `bridge`, `dispatchTool`, `formatResult`, `hostModules`, `hostToolMap`, `listToolGroups`. `McpServerWrapper` builds one in its constructor and threads it to every `register<Name>Tool`.

## Dispatch (`dispatch.ts`)

`createDispatcher(bridge, hostToolMap)` returns the function used by every tool that needs to invoke another tool — `call`, `wait_until`, `assert`, and host tools that chain via `HostContext.dispatch` (e.g. `host__tap_fiber` invokes `fiber_tree__query` then `host__tap` without a round-trip).

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

The bridge assigns IDs from a per-platform sequence — `ios-1`, `ios-2`, `android-1`, `client-1` (fallback when `platform` absent). On socket close, the `ClientEntry` is moved to a `disconnectedClients` map keyed by `(platform, deviceId, bundleId)` with `RECONNECT_GRACE_MS = 10 * 60_000` TTL. A re-registering client matching all three keys reuses the same ID — so `ios-1` survives Fast Refresh, app backgrounding, Xcode rebuild, brief network blips.

Ghost entries are invisible to `listClients()` while alive; `getClient(id)` returns only live entries too.

### Pending requests

Each `bridge.call(...)` allocates a `requestId` and stores `{ clientId, resolve, reject, timer }` in `pendingRequests`. The matching `tool_response` resolves the promise; an absent response trips the timer (default 10 s, overridable per tool via `ToolHandler.timeout`).

### Dynamic tools

`tool_register` / `tool_unregister` messages add / remove entries in `client.dynamicTools` (`Map<fullName, DynamicToolEntry>`). The agent reaches them via `call(tool: "__dynamic__<name>")`.

## Projection (where it lives, why)

The repo-wide projection vocabulary (`path` / `depth` / `maxBytes` / `previewCap` / `objectCap` / `arrayCap`, `${kind}` markers) and its primitives live in [`../shared/projection/`](../shared/CLAUDE.md). The server tools don't apply projection themselves — each in-app and host module that returns heavy JSON owns its own projection. The MCP tools just stream the handler's already-projected result through `formatResult`.

## Refactor history

`mcpServer.ts` originally bundled all six tool registrations + helpers + instructions in one 1086-line file. The current split into `tools/`, `dispatch.ts`, `helpers.ts`, `predicate.ts`, `instructions.ts` keeps each tool ≤200 lines and lets the class shell stay under 70.

## Lint exemption

[`tools/*.ts`](tools/) and `mcpServer.ts` are exempt from `import/extensions` in `.eslintrc.js` because `@modelcontextprotocol/sdk` requires `.js`-suffixed deep imports (ESM layout). The exemption is per-file, not global — keep new server-side SDK imports inside one of these paths or extend the override.
