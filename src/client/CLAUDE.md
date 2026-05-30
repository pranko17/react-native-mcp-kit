# `src/client/` — React Native client

The in-app side of the bridge. Owns the singleton `McpClient`, the `<McpProvider>` React entry point, the two hooks (`useMcpTool`, `useMcpModule`), and the WebSocket / module-runner utilities. The server tree (`src/server/`) is the counterpart; this directory must stay RN-safe (no Node-only imports).

## Public surface

[`index.ts`](index.ts) re-exports five values and three types:

- `McpProvider`, `McpContext` — React provider + context.
- `McpClient` — singleton, used directly only when registering modules outside the React tree.
- `useMcpTool`, `useMcpModule` — registration hooks.
- Types: `McpContextValue`, `McpProviderProps`, `McpModule`, `ToolHandler`.

`McpModule` / `ToolHandler` ([`models/types.ts`](models/types.ts)) is the contract every module fulfils — `{ name, tools: Record<string, ToolHandler>, description? }` with `ToolHandler = { description, handler, inputSchema?, timeout? }`. The optional `description` is markdown and surfaces in `list_tools`.

## `<McpProvider>` — the entry point

[`contexts/McpContext/McpProvider.ts`](contexts/McpContext/McpProvider.ts) is the public mounting point.

```tsx
<McpProvider
  debug
  navigationRef={navigationRef}   // → navigationModule
  queryClient={queryClient}       // → reactQueryModule
  i18n={i18nInstance}             // → i18nextModule
  storages={[{ name: 'mmkv', adapter }]} // → storageModule
  modules={[customModule()]}      // → any extra custom modules
>
  {children}
</McpProvider>
```

Mount-time behaviour (`McpProvider.ts:43-105`):

1. `useMemo` calls `McpClient.initialize({ debug })` — idempotent, returns the singleton on every render.
2. A `useRef<unknown>` (`rootRef`) is forwarded into `fiberTreeModule({ navigationRef, rootRef })`. The provider renders an internal `View` with `collapsable: false` and `ref={rootRef}` wrapping `children` (`McpProvider.ts:100-105`) — that View is what `fiber_tree` walks from. Apps no longer need to plumb a ref manually.
3. Five separate `useEffect`s register modules. The always-on batch (`alert`, `console`, `device`, `errors`, `log_box`, `network`, `fiber_tree`) runs once per `client` / `navigationRef` change. The other four are gated on the corresponding prop and re-run when that prop's identity changes (`McpProvider.ts:52-87`).
4. The context value (`registerTool` / `unregisterTool` thunks bound to the singleton) is memoised on `client` and provided through `McpContext`.

Module factories are imported eagerly at the top of `McpProvider.ts`, which is why this file pulls in every built-in module — keep that in mind when worrying about bundle size, though `stripPlugin` removes the whole tree in production.

### `View` resolution is lazy

`getView()` (`McpProvider.ts:26-32`) lazy-resolves `react-native`'s `View` via `getRN()` from `@/shared/rn/core`. The reason: this file is reachable from the server's import graph in tests, and pulling `react-native` into Node throws. The lazy require keeps the module type-checkable from both sides.

### Three registration paths

All semantically equivalent; pick by where the dependency lives.

1. **Provider props** — the common case. App-root dependencies (navigation container, query client) flow in here.
2. **`useMcpModule(() => module, deps)`** — for dependencies owned deeper in the tree. Example: a feature provider that creates its own `QueryClient` internally can register `reactQueryModule(qc)` from that subtree.
3. **`McpClient.getInstance().registerModule(module)`** — fire-and-forget direct call. Works from anywhere after the provider has mounted; mostly useful in tests.

## `McpClient` singleton

[`core/McpClient.ts`](core/McpClient.ts), ~361 lines, is the heart of the in-app side.

### Lifecycle

- `McpClient.initialize(options?)` (`McpClient.ts:218`) — returns the existing instance if present, otherwise constructs one. The second call only updates `debug`; identity / connection are sticky. This is the only public constructor.
- `McpClient.getInstance()` (`McpClient.ts:266`) — throws if `initialize` hasn't run. `useMcpModule` ([`hooks/useMcpModule.ts`](hooks/useMcpModule.ts)) calls this, so it must be used inside a tree wrapped by `<McpProvider>`.
- `dispose()` (`McpClient.ts:275`) — closes the WebSocket and clears the singleton, allowing a fresh `initialize`. Rare outside tests.

### Auto-detected identity (`autoDetectIdentity`, `McpClient.ts:102-147`)

On `initialize`, the client builds a `ClientIdentity` from three sources, all optional:

- `loadRN()` → `Platform.OS` (skipped if RN isn't loadable, e.g. running under Node).
- `detectDevServer()` (`McpClient.ts:78-100`) calls RN's internal `Libraries/Core/Devtools/getDevServer`, parses the URL, and emits `{ bundleLoadedFromServer, host, port, url }` when the bundle actually came from Metro. Production / file-backed bundles return `undefined`.
- `react-native-device-info` (optional) → `appName`, `appVersion`, `bundleId`, `label` (deviceName, falling back to manufacturer + model), `deviceId` (unique id), `isSimulator` (`isEmulatorSync()`). `isUsefulString` (`McpClient.ts:70-72`) treats the literal `"unknown"` that DI returns on emulators as absent.

Caller-supplied `options` win over auto-detected values for every field except `isSimulator` (it's always taken from DI). `host` defaults to `auto.devServer?.host ?? 'localhost'` (`McpClient.ts:247`) — Wi-Fi-connected iOS devices reach the Mac's LAN IP for free since the server binds to `0.0.0.0`. Android over `adb reverse` still resolves `localhost`. `port` defaults to `DEFAULT_PORT = 8347` (from [`shared/protocol.ts`](../shared/protocol.ts)).

### Connection wiring

In the constructor (`McpClient.ts:157-194`) the client wires three handlers on a new `McpConnection`:

- `onOpen` → log "Connected" and call `sendRegistration`.
- `onMessage` switches on `message.type`:
  - `server_hello` (`McpClient.ts:168`) — verifies `protocolVersion`. Mismatch logs an error, calls `connection.stopReconnect()` + `dispose()`, and never tries again.
  - `version_mismatch` (`McpClient.ts:180`) — server rejected us; log and stop reconnect.
  - `tool_request` (`McpClient.ts:187`) — delegate to `handleToolRequest`.
- Finally, `connection.connect()`.

`handleToolRequest` (`McpClient.ts:196-216`) runs `moduleRunner.handleRequest(message)`, then sends back a `tool_response` with either `result` or `error: error.message`.

### `sendRegistration`

`sendRegistration` (`McpClient.ts:337-360`) is called once on connect and again after every `registerModule(s)` / `registerTool` call. It snapshots `moduleRunner.getModuleDescriptors()` and emits a full `RegistrationMessage` with `protocolVersion: PROTOCOL_VERSION` plus every identity field. This re-blast is intentional — the server-side bridge takes the latest registration as authoritative and rewires its tool map; partial / incremental registration messages are not part of the protocol.

### Module / tool registration API

- `registerModule(module)` / `registerModules(modules)` (`McpClient.ts:285-329`) → `moduleRunner.registerModules` then `sendRegistration`. **Each returns a disposer** `() => void` that removes the just-registered module(s) from `ModuleRunner` and re-blasts `sendRegistration`; since the server full-replaces its module list on every registration (`bridge.ts:252`), the module drops out of `list_tools` / `call`. `unregisterModule(name)` / `unregisterModules(names)` (`McpClient.ts:314-329`) expose the same removal by name without holding the disposer — symmetric with the dynamic-tool pair.
- `registerTool(name, tool)` (`McpClient.ts:331`) — for dynamic tools from `useMcpTool`. Stores in `moduleRunner.dynamicTools` (no module namespace), then sends a `tool_register` message with `module: "__dynamic"` (i.e. `${MODULE_SEPARATOR}dynamic`). Server-side, the tool becomes callable as `call(tool: "__dynamic__<name>")` — the prefix is `DYNAMIC_PREFIX = "__dynamic__"` from `shared/protocol.ts:15`. They show up in `list_tools` under `(dynamic)`.
- `unregisterTool(name)` (`McpClient.ts:345`) — symmetric `tool_unregister`.

## `useMcpTool` / `useMcpModule`

### [`hooks/useMcpTool.ts`](hooks/useMcpTool.ts)

```ts
useMcpTool('logout', () => ({
  description: 'Log out the current user',
  handler: () => { logout(); return { success: true }; },
}), [logout]);
```

The factory is `useMemo`'d on `deps` (`useMcpTool.ts:13`) and the registration `useEffect` runs whenever `ctx`, `name`, or the memoised `tool` changes (`useMcpTool.ts:15-21`). Cleanup calls `unregisterTool`. Because cleanup runs before the next `registerTool`, replacing a tool's handler triggers `unregister` → `register` on the next render — fine in steady state but worth knowing if you're chasing transient state on the server side.

Calling `useMcpTool` outside `<McpProvider>` is a silent no-op (`ctx` is `null`).

### [`hooks/useMcpModule.ts`](hooks/useMcpModule.ts)

Same shape as `useMcpTool` but for full modules: `useMemo` on the factory, `useEffect` registers via `McpClient.getInstance().registerModule(module)` and returns that call's disposer as the effect cleanup. So the module is **unregistered on unmount**, and on a dependency change React tears down (unregister) then re-registers. Both `registerModule` and the disposer re-blast `sendRegistration`, and the server full-replaces its module list (`bridge.ts:252`) — so for a same-named re-bind the two sends (without → with the module) run synchronously back-to-back and the agent never observes the gap. Earlier versions had no cleanup and the module leaked past unmount; the disposer fixes that, which matters for modules registered from a feature subtree that owns its own `QueryClient` / store.

`useMcpModule` calls `McpClient.getInstance()` at the top of the hook, so it throws if the provider hasn't mounted yet.

## `McpConnection` — WebSocket transport

[`utils/connection.ts`](utils/connection.ts), 88 lines.

- Plain RN `WebSocket` (the global, not `ws`). Auto-reconnect via `RECONNECT_INTERVAL = 3000` (`connection.ts:3`).
- Reconnect loops are disabled in two cases: `dispose()` (intentional teardown) and `stopReconnect()` (fatal protocol-version mismatch — retrying won't help and would spam the dev console).
- `send()` silently drops messages when the socket isn't `OPEN` (`connection.ts:46-50`). The implication: `registerTool` calls made before `onOpen` fires never reach the server. In practice `sendRegistration` re-runs on every `onOpen`, so this only affects dynamic tools created during the first open window — `useMcpTool` consumers don't notice because the next state-change re-registration will catch them up via the registration message anyway. Worth keeping in mind for any future "send something exactly once" path.
- Malformed inbound messages are silently swallowed (`connection.ts:29`).

## `ModuleRunner` — request dispatcher

[`utils/moduleRunner.ts`](utils/moduleRunner.ts), 68 lines.

- Holds three maps: `modules` (name → tools), `moduleDescriptions` (name → markdown), `dynamicTools` (name → handler).
- `handleRequest` (`moduleRunner.ts:26`) — dynamic tools are checked first (no module namespace), then the module map. Unknown module / method throws a descriptive `Error` that bubbles to `handleToolRequest` and becomes the response's `error` field.
- `getModuleDescriptors` (`moduleRunner.ts:47`) — serialises module → tool metadata for `RegistrationMessage`. Each tool reports `description`, `inputSchema?`, `timeout?` but not the handler.

Dynamic tools are intentionally flat (no module): the server stitches them into the global `_dynamic_` prefix space when they arrive via `tool_register`.

## Data flow recap

1. `<McpProvider>` mounts → `McpClient.initialize()` opens a WebSocket to `ws://${host}:${port}` (defaults: bundle host or `localhost`, port `8347`).
2. Server sends `server_hello` with `protocolVersion`. Client either continues (versions match) or stops reconnecting and logs an error.
3. Built-in module effects fire → `client.registerModules(...)` accumulates into `ModuleRunner` and `sendRegistration` ships the full descriptor list (including `isSimulator` for iOS host routing).
4. Agent calls `call(...)` → server sends `tool_request` → `ModuleRunner.handleRequest` resolves and runs the handler → client sends `tool_response`.
5. `useMcpTool` sends `tool_register` / `tool_unregister`; agent calls them via the `__dynamic__<name>` form.
6. On WS close the client reconnects every 3s unless told otherwise. After reconnect, `sendRegistration` re-blasts the current state — server-side sticky-clientId (matched on `platform` + `deviceId` + `bundleId`) reuses the same client id, so dynamic tools survive Fast Refresh seamlessly as long as the component re-mounts and re-runs `useMcpTool`.

## Debug logging

`<McpProvider debug>` sets `McpClient.debug = true`. Logs go through `originalConsoleLog` captured at module load (`McpClient.ts:54`), **before** the `console` module's interceptor runs — debug lines never appear in `console__get_logs`.

Format:
- Tag `[rn-mcp-kit]` in bold purple.
- Module names cycle through 8 bold ANSI colors (`MODULE_COLORS`, `McpClient.ts:20-29`), assigned in registration order via a per-instance `moduleColorMap`. (Root CLAUDE.md says "12 colors" — actual count is 8.)
- Method names bold.
- `→` cyan = incoming `tool_request`, `←` green = outgoing `tool_response`, `✕` red = handler threw.
- Registration also logs the descriptor list (one line per module, name padded to 12 chars + tool count).

`enableDebug(enabled)` (`McpClient.ts:281`) flips the flag at runtime if you didn't pass `debug` to the provider.
