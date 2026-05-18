# src/shared/CLAUDE.md

Code reachable by both client (RN app) and server (Node). Three concerns: WS protocol types and constants ([protocol.ts](protocol.ts)), projection / slice pagination utilities ([projection/](projection/)), and RN interop helpers ([rn/](rn/)). Nothing here may import from `@/client/*` or `@/server/*` — the dependency flow is one-way (both sides import from shared, neither side appears in shared).

## protocol.ts

Wire-format types + the four well-known constants. Single source of truth for both ends of the WebSocket.

### Constants

- `PACKAGE_NAME = 'react-native-mcp-kit'` — npm identity, reused by `mcpServer.ts` (handshake) and `stripPlugin.ts` (default import source it strips).
- `DEFAULT_PORT = 8347` — WebSocket port. Both `createServer` (server) and `McpClient.initialize` (client) read this, so they always agree.
- `MODULE_SEPARATOR = '__'` — joins module + tool in MCP call format (`module__method`).
- `DYNAMIC_PREFIX = '__dynamic__'` — derived from `MODULE_SEPARATOR`. Marks tools registered via `useMcpTool` (e.g. `call(tool: '_dynamic_logout')`).
- `PROTOCOL_VERSION = 2` — wire-protocol version. Independent of the npm semver — bump on any breaking change to the messages below. Introduced in package v2.0.0; older clients/servers don't send or expect a version field, and the handshake treats their absence as an incompatibility.
- `WS_CLOSE_PROTOCOL_MISMATCH = 4010` — custom WS close code the server uses when refusing a client over protocol mismatch.

### Message types

All messages carry a discriminated `type` field. The two unions at the bottom of [protocol.ts](protocol.ts) (`ClientMessage`, `ServerMessage`) are what the dispatch switches on either side.

**Server → Client**

- `server_hello` (`ServerHelloMessage`) — sent immediately on accept, before any registration. Carries `protocolVersion`. Client compares and disconnects with a clear developer-facing error on mismatch.
- `version_mismatch` (`VersionMismatchMessage`) — sent before the server closes the socket with code `4010` when a `registration` is rejected. Carries `serverVersion`, optional `clientVersion`, `reason`.
- `tool_request` (`ToolRequest`) — `{ id, module, method, args }`. Server-side `dispatchTool` resolves `module__method` against the client's registered modules.

**Client → Server**

- `registration` (`RegistrationMessage`) — first message after `server_hello`. Carries `protocolVersion` (required for the version handshake), `modules: ModuleDescriptor[]`, plus optional identity fields: `platform`, `deviceId`, `bundleId`, `appName`, `appVersion`, `label`, `isSimulator`, `devServer`.
- `tool_response` (`ToolResponse`) — `{ id, result?, error? }`.
- `tool_register` / `tool_unregister` (`ToolRegisterMessage` / `ToolUnregisterMessage`) — incremental dynamic-tool registration from `useMcpTool`.

### Auxiliary descriptors

- `ModuleDescriptor` — `{ name, tools, description? }`.
- `ModuleToolDescriptor` — `{ name, description, inputSchema?, timeout? }`. `timeout` is per-tool in ms (default 10s, see `mcpServer.ts`).
- `DevServerInfo` — `{ host, port, url, bundleLoadedFromServer }`. Filled client-side from `getDevServer()` (`react-native/Libraries/Core/Devtools/getDevServer`, loaded via [rn/core.ts](rn/core.ts)'s `loadRNInternal`). Absent in production builds or when detection fails. Server's `metro__*` tools read this via `resolveMetroUrl()` instead of hardcoding `localhost:8081`.
- `isSimulator` — auto-detected client-side via `react-native-device-info`'s `isEmulatorSync()` (loaded via [rn/deviceInfo.ts](rn/deviceInfo.ts)). The host's `deviceResolver.ts` reads this to route iOS clients to the simulator path vs. the CoreDevice tunnel.

### Bumping the protocol

Bump `PROTOCOL_VERSION` for **any** field-rename / removed message / changed semantics. The server's handshake rejects `protocolVersion !== PROTOCOL_VERSION` (including `undefined`) before the registration is processed. Add a one-line entry near the constant explaining what changed in that bump.

## projection/

The shared "render heavy JSON in an agent-friendly way" primitive. Every tool that returns a non-trivial payload (console, network, errors, storage, reactQuery, fiber_tree props/hooks, log_box, navigation, metro events, device) goes through it at handler exit.

Three files:

- [projection/projectValue.ts](projection/projectValue.ts) — the walker + marker emission + `makeProjectionSchema` + `applyProjection`.
- [projection/resolvePath.ts](projection/resolvePath.ts) — dot-path / bracket / slice parser + resolver applied **before** projection.
- [projection/redact.ts](projection/redact.ts) — shared key-name redaction (used by `projectValue` directly and by network for headers/bodies).

### makeProjectionSchema + applyProjection

`makeProjectionSchema(defaultDepth)` returns the six standard knobs as a JSONSchema fragment. Modules spread it into their tool's `inputSchema` so agents see machine-readable `default:` + `minimum:` (and `maximum:` on `depth`) via `describe_tool`. The standalone exported `PROJECTION_SCHEMA` is `makeProjectionSchema()` with the default depth (1) baked in — used by tools that don't override depth.

Defaults (constants exported from [projection/projectValue.ts](projection/projectValue.ts)):

- `DEFAULT_DEPTH = 1`
- `MAX_DEPTH = 8` — `depth` is clamped to `[0, 8]` by `clampDepth`.
- `DEFAULT_OBJECT_CAP = 30`
- `DEFAULT_ARRAY_CAP = 50`
- `DEFAULT_PREVIEW_CAP = 250`
- `DEFAULT_MAX_BYTES = 50_000`

`applyProjection(result, args, projector, defaultDepth?)` is the standard handler-exit hook. It pulls `path` / `depth` / `maxBytes` / `previewCap` / `objectCap` / `arrayCap` from `args` and forwards to the given projector. Modules that need domain-specific collapse rules (fiberTree component refs) wrap `projectValue` into a `Projector` with `collapse` pre-bound — see `projectFiberValue` in the fiberTree module.

### projectValue walk

`projectValue(input, options): { value, bytes, truncated }`. Walks the input to `depth` (default 1, max 8). Decrement-before-recurse means `depth: 1` expands the top-level container and renders its children as markers; `depth: 0` collapses the root itself.

Walk order in `walk()` ([projection/projectValue.ts:293](projection/projectValue.ts)):

1. Primitives (`null`, `undefined`, `number`, `boolean`) — returned raw.
2. `bigint` → `{ "${bigint}": "<value>" }`.
3. `string` → `projectString` (raw if ≤ `previewCap`, else `{ "${str}": { len, preview } }`).
4. Specials via `projectSpecial`: `Date`, `RegExp`, `Error`, `Map`, `Set`, `function`, `symbol`. Each produces a typed marker. Then any pluggable `collapse` rules (e.g. fiberTree component refs).
5. Cycle check via `WeakSet`. Repeat objects → `{ "${cyc}": true }`.
6. If `remainingDepth <= 0` and value is a container → `collapsedContainer` marker. Otherwise recurse via `walkContainer`.
7. Wide containers: `walkArray` slices to `arrayCap`, `walkObject` slices to `objectCap`. Truncation adds `{ "${truncated}": { slice: [0, cap], total } }` as the FIRST entry. `walkObject` also applies `skipKeys` (exact + regex) and `redact` (compiled via `compileRedact`).
8. Final soft cap: the projected output is `JSON.stringify`-ed; if it exceeds `maxBytes`, the entire result is replaced with one `${str}` marker carrying the full serialised length + a `min(maxBytes, 200)`-char preview.

### Marker catalogue

Every collapsed-content marker uses the `${kind}` prefix so agents can recognise them without sniffing types. `isMarker` is exported for tooling that needs to differentiate. Markers emitted today:

| Marker | Meaning | Where |
| --- | --- | --- |
| `{"${obj}": N}` | Plain object collapsed past depth, `N` = key count | `collapsedContainer` |
| `{"${cls}": { name, len }}` | Class instance with a non-Object prototype | `collapsedContainer` |
| `{"${arr}": N}` | Array collapsed past depth, `N` = length | `collapsedContainer` |
| `{"${str}": { len, preview }}` | String above `previewCap`, or the byte-cap escape hatch | `projectString` + final-cap fallback |
| `{"${truncated}": { slice: [0, cap], total }}` | Width-cap hit on array/object | `walkArray` / `walkObject` |
| `{"${Date}": "<ISO>"}` | `Date` instance | `projectSpecial` |
| `{"${RegExp}": "<toString()>"}` | `RegExp` instance | `projectSpecial` |
| `{"${Err}": { name, msg }}` | `Error` (only `name` + `message`; full `stack` lives elsewhere) | `projectSpecial` |
| `{"${map}": N}` | `Map`, `N` = `size` | `projectSpecial` |
| `{"${set}": N}` | `Set`, `N` = `size` | `projectSpecial` |
| `{"${fun}": "<name>"}` | Function (`<anon>` when nameless) | `projectSpecial` |
| `{"${sym}": "<toString()>"}` | Symbol | `projectSpecial` |
| `{"${bigint}": "<value>"}` | BigInt | `walk` |
| `{"${cyc}": true}` | Cycle (already-seen object) | `walk` |
| `{"${ref}": { mcpId, name?, testID? }}` | Component-ref shape, emitted by fiberTree's pluggable `collapse` rule | external rule |

### CollapseRule

The `collapse: ReadonlyArray<CollapseRule>` option lets modules inject domain-specific shape detectors **before** the generic container walk runs. fiberTree uses this to detect "looks like a fiber instance / component ref" and replace it with the `${ref}` marker so agents can follow up via `fiber_tree__query`. Rules return either `undefined` (no match, continue) or a `{ "${kind}": ... }` object to be emitted as-is.

### Path drill (`resolvePath`)

`resolvePath(root, path)` parses then walks. Used by `projectValue` to navigate inside `input` BEFORE the depth walk runs — the resolved subtree is what gets projected.

Path syntax (see [projection/resolvePath.ts](projection/resolvePath.ts) header):

- `foo.bar` — object key.
- `foo[3]` — array index, object Nth key (insertion order), or single string char. Negative indexes count from the end.
- `foo[1:5]` / `foo[3:]` / `foo[:5]` — Python-style slice over arrays, objects, or strings.
- `foo["key.with.dots"]` / `foo['k']` — bracket-quoted key for names that contain `.` / `[` / `]`.

Slice + chained access has special semantics (`stepKey` in `resolvePath.ts`):

- Array slice + `.key` → **map** (apply key to every element). Each element must be an object.
- Array slice + `[N]` → Nth element of the window (regular indexing on the sliced array).
- Object slice + `.key` → key from the sliced sub-object (no map).
- Object slice + `[N]` → Nth key in window.
- String slice + anything further → step errors (`Cannot ... on non-container` etc.).

The result carries `endsInSlice: boolean`. `projectValue` uses this: when the path ends in a slice AND the resolved value is a string, the substring is returned raw (only the `maxBytes` cap applies — `previewCap` is bypassed because the agent explicitly asked for a window). Other paths that land on a string still go through `previewCap`. This is what lets `path: 'errors[-1].stack[0:500]'` dump a clean 500-char window of a long stack.

On failure, `resolvePath` returns `{ ok: false, error, validUpTo, actual }` — `validUpTo` is the path prefix that did resolve, useful for "did you mean..." style errors. `projectValue` surfaces this as `{ error, validUpTo }` instead of throwing.

### Redaction (`redact.ts`)

`RedactPatterns = ReadonlyArray<string | RegExp> | false`:

- Array — strings are lowercased + matched as substring on lowercased keys; regexes are matched verbatim against the original key.
- `false` — disables redaction entirely.
- `undefined` — falls back to provided defaults.

`compileRedact(list, defaults)` returns a `{ exact, regexes, empty }` triple (or `null` when disabled). `matchesRedact(key, compiled)` does the actual O(1) Set check + regex sweep. `projectValue.walkObject` inlines `matchesRedact` — matched keys get `[redacted]` in place of the value, and the recursion stops there.

`redactValue` and `redactHeaders` are exported for modules that need to redact at capture time (network module redacts request/response bodies + headers before storing them in its ring buffer — the projection layer then doesn't see secrets at all).

## rn/

Centralises the two optional lazy-requires the library performs at runtime. Both files exist so the require sites are NOT scattered across modules, and so server-only entry points (`server/index.ts`, `host/*`, `cli.ts`) don't end up pulling `react-native` on Node when they `import` a shared utility.

### core.ts

`react-native` is a peer dependency. In-app it's always present; in server / SDK / test contexts it isn't.

- `getRN()` — bare `require('react-native')`. Throws if missing. Use from modules that are only ever invoked in-app (alert, device, logBox, fiberTree, etc.).
- `loadRN()` — try-wrapped + memoised. Returns `null` when RN can't be resolved. Use from code that needs to tolerate the absence (handshake / SDK-level paths that may run before bundle).
- `loadRNInternal(subPath)` — try-loads a private RN sub-module. Backed by `RN_INTERNAL_LOADERS`, a hand-maintained map of literal `require('react-native/<path>')` thunks. Reason: Metro can't statically resolve template-literal requires — `require('react-native/' + subPath)` silently drops at bundle time and throws `Invalid call at ...` at runtime. To add a new private path, add the literal `require` to `RN_INTERNAL_LOADERS` AND extend the `RNInternalPath` union. Currently registered: `Libraries/Core/Devtools/getDevServer` (used by the client to populate `DevServerInfo` at handshake), `Libraries/LogBox/Data/LogBoxData` (used by `logBox` module).
- `__resetRNCache()` — test-only cache reset.

Both module-level caches (`cachedRN`, `cachedInternals`) use `undefined` as "not yet loaded", `null` as "tried and failed" so a single load attempt is performed per (sub-)module across the entire process lifetime.

### deviceInfo.ts

`react-native-device-info` is an **optional** peer dependency. The handshake's `autoDetectIdentity`, the `device.info` aggregate, and any future consumer reach for it via this loader instead of inlining the try/require.

- `loadDeviceInfo()` — `null` if not installed; otherwise the unwrapped namespace (handles `.default` if the bundler attached one).
- `callDI(fn, fallback?)` / `callDIAsync(fn, fallback?)` — safe-call helpers. Older DI versions may not have specific getters; these silently return `fallback` (default `null`) when the function is missing or throws. Saves every call site re-implementing the try/typeof check.
- `DEVICE_INFO_UNAVAILABLE = { unavailable: true, reason: '...' }` — standard "package not installed" payload the device module returns so the absence is surfaced consistently.
- `__resetDeviceInfoCache()` — test-only.

### Why this isolation matters

The server entry point exports the host module + the MCP wiring without ever pulling RN — running `import { createServer } from 'react-native-mcp-kit/server'` from a plain Node script must succeed even when `react-native` isn't installed. Any new server-side code that touches an RN-only API must go through `loadRN()` or `loadRNInternal()` (or live behind a runtime gate in a module the server never imports) — never `import 'react-native'` at the top of a file that's reachable from `server/index.ts`.
