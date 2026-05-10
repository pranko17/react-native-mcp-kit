# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
yarn build          # tsc + tsc-alias + ./scripts/build-ios-hid.sh → dist/ (incl. dist/bin/ios-hid)
yarn dev            # tsc watch mode
yarn lint           # ESLint (src/**/*.{ts,tsx})
yarn lint:fix       # Auto-fix ESLint violations
yarn lint:ts        # TypeScript type check (tsc --noEmit)
```

No test suite is configured.

## Architecture

`react-native-mcp-kit` is a bidirectional MCP bridge connecting React Native apps to AI agents. The Node server is a proxy for in-app business logic, plus it hosts a *host module* that shells out to `adb` / `xcrun simctl` / a bundled Swift HID injector to drive the device at OS level.

```
AI Agent  --stdio/MCP-->  MCP Server (Node.js)  --WebSocket-->  RN App (device)
                               │
                               └─ host module (adb / xcrun simctl / ios-hid binary) --> device
```

### MCP server tools

The server registers 8 static tools via `this.mcp.registerTool` in `src/server/mcpServer.ts`:

- **`call`** — Universal dispatcher. Format: `call(tool: "module__method", args: {...})`. `args` accepts either a plain object or a JSON string — objects are preferred. Dynamic tools from `useMcpTool` hooks use the `_dynamic_` prefix: `call(tool: "_dynamic_logout")`. When multiple clients are connected, `clientId` must be specified.
- **`wait_until`** — Polls any other tool until a predicate over its result holds or timeout. Leaf predicate `{ op, path?, value? }` supports `equals / notEquals / contains / notContains / exists / notExists / gt / gte / lt / lte`. Compound forms `{ all: [...] } / { any: [...] } / { not: predicate }` nest arbitrarily. Returns `{ ok: true, attempts, elapsedMs, matched? }` on success (matched = resolved path value for leaf predicates only) or `{ ok: false, reason, attempts, elapsedMs, lastResult, lastError? }` on timeout.
- **`assert`** — Single-shot checkpoint with the same predicate vocabulary. Returns `{ pass: true, actual? }` / `{ pass: false, actual, expected?, op?, path?, message?, result }` / `{ pass: false, error, message? }` on dispatch throw.
- **`list_tools`** — Lists all tools across all clients, grouped by module, with compact (schema-less) output. Clients with structurally identical modules are deduplicated into one entry with a `clientIds` array. Optional filters: `module?` (narrow to one module), `clientId?` (narrow to one client), `compact?: boolean` (drop module-level descriptions).
- **`describe_tool`** — Returns the full input schema for a specific tool. For in-app tools, `clientId` only needed when more than one client has the same tool with different schemas.
- **`connection_status`** — Lists connected clients with platform, label, deviceId, bundleId, and the module names they've registered.

Shared server-side helpers live at the top of the file: `parseCallArgs` (object-or-string args), `resolvePath` (dot-path + array-index + `.length`), `evalPredicate` (recursive). `dispatchTool` is the private method that resolves `module__method` against the host map or the client bridge — used by `call`, `wait_until`, `assert`, and exposed to host handlers via `HostContext.dispatch` for tools like `host__tap_fiber` that need to chain.

Server instructions + tool annotations (`readOnlyHint`, `openWorldHint`, `title`) live alongside each `registerTool` call.

### Host module (OS-level control)

Exposed when `hostModule` is passed to `createServer` (the default in `cli.ts`). Adds host-side tools that don't need the RN app to be connected:

- **Input** (`host/tools/input.ts`): `host__tap`, `host__long_press`, `host__swipe`, `host__drag`, `host__type_text`, `host__type_text_batch`, `host__press_key`. All coordinates are **PHYSICAL PIXELS** and match the `bounds` returned by `fiber_tree` — feed `bounds.centerX` / `bounds.centerY` straight into `host__tap`. `long_press` is a zero-distance swipe with default 700ms hold (above RN Pressable's ~500ms threshold). `drag` = swipe with `holdMs + durationMs` total. `type_text_batch` takes `fields: [{ x, y, text, submit? }]` + optional `focusDelayMs` (default 200, bump to 700-800 for navigation-triggering taps). `type_text` on Android is **ASCII-only** (preflight check) because `adb shell input text` routes through a KeyCharacterMap that lacks non-ASCII entries; use `fiber_tree__call({ prop })` on `onChangeText` for Cyrillic/CJK/emoji on Android.
- **Cross-layer** (`host/tools/tapFiber.ts`): `host__tap_fiber({ steps, index?, clientId? })` — chains `fiber_tree__query` → host__tap in one call. On ambiguous match, returns candidate list with bounds so the agent can pick `index` or narrow `steps`. Uses `HostContext.dispatch` internally.
- **Capture** (`host/tools/capture.ts`): `host__screenshot` — WebP, auto-resized (default width 280), diff-cached via SHA-256 per device (returns `unchanged: true` when identical to last capture). Accepts `region: { x, y, width, height }` in original device pixels — crops BEFORE resize; pair with fiber bounds to snapshot one element for ~20-60 vision tokens. Response is `[image, metadataText]` where metadata JSON includes `{ width, height, originalWidth, originalHeight, scale, bytes, region? }`.
- **Lifecycle** (`host/tools/lifecycle.ts`): `host__launch_app`, `host__terminate_app`, `host__restart_app`. `appId` optional when a connected client registered its `bundleId`.
- **Devices** (`host/tools/devices.ts`): `host__list_devices` — annotates each device with `connected: true` / `clientId` when it matches a live client.

### Metro module (`src/server/metro/`)

Talks HTTP to the Metro dev server. The URL is auto-detected per-client at handshake via RN's `getDevServer()` (see `devServer` in the registration message); `resolveMetroUrl()` picks it up, falling back to `http://localhost:8081` when absent (production builds or detection failure). Every tool accepts an explicit `metroUrl` override.

- **Symbolication** (`metro/tools/symbolicate.ts`): `metro__symbolicate({ stack? | frames?, metroUrl?, clientId?, maxFrames?, includeFrameworkFrames?, fullPaths? })` — POSTs to `/symbolicate`. Drops `collapse: true` framework frames by default, caps to 10 frames, shortens absolute paths relative to cwd. Graceful no-op `{ skipped: true, error, frames }` when Metro is unreachable.
- **Reload** (`metro/tools/reload.ts`): `metro__reload({ metroUrl?, clientId? })` — POSTs to `/reload`. Triggers a full JS reload on every attached app.
- **Status** (`metro/tools/status.ts`): `metro__status({ metroUrl?, clientId? })` — GETs `/status`. Cheap ping before a chain of Metro calls.
- **Open in editor** (`metro/tools/openInEditor.ts`): `metro__open_in_editor({ file, lineNumber, column?, metroUrl?, clientId? })` — POSTs to `/open-stack-frame`. Jumps `$REACT_EDITOR` to the exact line. Pairs naturally with `metro__symbolicate` output.
- **Reporter events** (`metro/tools/events.ts` + `metro/eventCapture.ts`): `metro__get_events({ type?, since?, path?, depth?, maxBytes?, metroUrl?, clientId? })` — reads from a server-side ring buffer (200 events) fed by a lazy WebSocket to `/events`. Surfaces `bundle_build_failed`, `bundling_error`, `hmr_client_error`, `hmr_update`, `client_log`, etc. Key use: detecting silent HMR failures when the red box doesn't appear. Response goes through the standard `path` / `depth` / `maxBytes` projection (default depth 4); drill via `path: 'events[-3:]'` for the last 3.

### Slice pagination

All tools that return heavy JSON (console, network, errors, storage, reactQuery, fiber_tree props/hooks, log_box, navigation, metro events) share the standard `path` / `depth` / `maxBytes` projection input. Slice is now part of `path` syntax (`[-3:]`, `[10:20]`, etc.) — see `src/shared/projectValue.ts` and `src/shared/resolvePath.ts`. Heavy nested values collapse to `${kind}` markers (`{"${obj}":N}`, `{"${arr}":N}`, `{"${str}":{len,preview}}`, `{"${Date}":...}`, `{"${Err}":{name,msg}}`, `{"${cyc}":true}`, `{"${ref}":{mcpId,name}}`, etc.). Drill via `path: '[-1:][0].request.body.user.email'` from the same tool — no separate by-id fetcher.

**iOS input** goes through `dist/bin/ios-hid` — a Swift CLI (`src/swift/ios-hid.swift`) that injects HID events directly into iOS Simulator via `SimulatorKit` + `CoreSimulator` private frameworks (no WDA, no idb, no Appium). Built during `yarn build` by `scripts/build-ios-hid.sh` as a universal arm64+x86_64 binary. `src/server/host/iosInput.ts` is the TS wrapper that shells out to it.

**Coordinate system invariant**: the Swift binary passes `(x, y)` pixel coordinates directly to `IndigoHIDMessageForMouseNSEvent` alongside `screenSize` also in pixels — the function internally treats `CGPoint / screenSize` as a ratio. Do not divide by `screenScale` in `createMouseEvent` — that causes the tap to land at 1/9 of the intended position.

**Android** is plain `adb shell input tap/swipe/text/keyevent`, `screencap`, `monkey`.

**HostContext** (extended): host tool handlers receive `{ bridge, dispatch, requestedClientId? }`. `dispatch(tool, args, clientId?)` resolves against host + client tools — that's how `host__tap_fiber` chains `fiber_tree__query` + `host__tap` without plumbing.

### Package structure

The package has multiple entry points (see `package.json` exports):

- **Root** (`./` → `src/index.ts`) — re-exports client + modules (RN-safe)
- **Client** (`./client` → `src/client/index.ts`) — client-only subset
- **Modules** (`./modules` → `src/modules/index.ts`) — just the module factories
- **Server** (`./server` → `src/server/index.ts`) — Node.js MCP server (not bundled into RN)
- **Babel** (`./babel` → `src/babel/index.ts`) — both plugins
- **Babel subentries** — `./babel/test-id-plugin`, `./babel/strip-plugin` for direct plugin import

```
src/
  babel/
    testIdPlugin.ts         — Adds data-mcp-id="Component:file:line" to capitalized JSX + emits __mcp_hooks metadata on component/custom-hook functions (runs on node_modules too)
    stripPlugin.ts          — Removes all MCP code (imports, calls, <McpProvider>, data-mcp-id, __mcp_hooks assignments)
    index.ts                — Barrel
  client/
    core/McpClient.ts       — Singleton: WS connection, module registry, debug log, state/tool APIs
    contexts/McpContext/
      McpProvider.ts        — Owns client init + conditional module registration + context
      McpContext.ts         — React context (consumed by useMcp* hooks)
      types.ts              — McpProviderProps, McpContextValue
    hooks/                  — useMcpTool, useMcpModule
    models/types.ts         — McpModule, ToolHandler
    utils/                  — McpConnection (WS client), ModuleRunner
  server/
    mcpServer.ts            — 6 static MCP tools (call / wait_until / assert / list_tools / describe_tool / connection_status), dispatchTool helper used by meta-tools and host tools, image-content support
    bridge.ts               — WS server, request/response dispatch, client identity
    host/                   — Host module (OS-level tools that shell out)
      hostModule.ts
      iosInput.ts           — Wraps dist/bin/ios-hid
      deviceResolver.ts     — Resolve target device from clientId / udid / serial / platform
      processRunner.ts      — Abstracted child_process runner (mockable)
      tools/
        input.ts            — tap / long_press / swipe / drag / type_text / type_text_batch / press_key
        capture.ts          — screenshot (WebP, default width 280, diff cache, region crop)
        lifecycle.ts        — launch / terminate / restart
        devices.ts          — list_devices
        tapFiber.ts         — fiber_tree__query + host__tap one-shot (uses HostContext.dispatch)
    metro/                  — Metro dev-server control plane (HTTP + WS)
      metroModule.ts
      resolveMetroUrl.ts    — per-client devServer.url (from handshake) → HTTP base
      eventCapture.ts       — lazy WS to /events, 200-entry ring buffer
      tools/
        symbolicate.ts      — /symbolicate wrapper with collapse-filter + maxFrames trim
        reload.ts           — POST /reload
        status.ts           — GET /status health check
        openInEditor.ts     — POST /open-stack-frame → $REACT_EDITOR
        events.ts           — reads the ring buffer with slice + type + since filters
    cli.ts                  — #!/usr/bin/env node — parses --port / --no-host, boots server
    index.ts                — createServer()
  swift/
    ios-hid.swift           — HID injector compiled into dist/bin/ios-hid
  modules/
    alert/                  — Native Alert.alert with custom buttons
    console/                — console.log/warn/error/info/debug capture (ring buffer)
    device/                 — Platform facts + open URLs / settings / reload / vibrate / keyboard
    errors/                 — Unhandled JS errors + promise rejections (ErrorUtils + console.error); parsed stackFrames
    fiberTree/              — Component tree inspection; bounds in physical pixels; chained query with scopes
    i18next/                — i18next translation inspection + change_language
    logBox/                 — LogBox overlay control (get/dismiss/ignore/install); dev-only surface
    navigation/             — React Navigation control + 100-entry history + screen component enrichment
    network/                — fetch + XMLHttpRequest interception with body cap + header/body redaction
    reactQuery/             — React Query cache inspection + invalidate/refetch/remove/reset
    storage/                — Multi-storage key-value inspection (MMKV / AsyncStorage / custom)
    index.ts                — Barrel
  shared/
    protocol.ts             — WS message types (RegistrationMessage, ToolRequest, etc.)
  scripts/
    build-ios-hid.sh        — Compiles Swift CLI to universal binary in dist/bin/
```

### File & folder conventions

- **Contexts**: `contexts/ContextName/` folder with separate files for context, provider, types + `index.ts` barrel.
- **Hooks**: camelCase files in `hooks/` (e.g. `useMcpTool.ts`).
- **Models**: types in `models/types.ts`.
- **Modules**: each module gets its own folder (e.g. `modules/navigation/`) with `<name>.ts`, `types.ts`, `index.ts`. Complex modules split utilities into sibling files (see `modules/fiberTree/utils.ts`).

### Initialization & module registration

The public entry point is `<McpProvider />`. It owns the client lifecycle, captures a root View ref internally (so `fiber_tree` doesn't need a manual ref), and registers modules based on supplied props.

```tsx
<McpProvider
  debug
  navigationRef={navigationRef}   // → navigationModule
  queryClient={queryClient}       // → reactQueryModule
  i18n={i18nInstance}             // → i18nextModule
  storages={[{ name: 'mmkv', adapter }]} // → storageModule
  modules={[customModule()]}      // → extra custom modules
>
  {children}
</McpProvider>
```

Always-on modules registered by the provider: `alert`, `console`, `device`, `errors`, `log_box`, `network`, `fiber_tree` (fiberTree picks up the internal rootRef + navigationRef when provided, so `scope: "screen"` resolves automatically).

The provider also keeps the context value exposed by `McpContext`, so `useMcpTool` / `useMcpModule` keep working.

Three entry points for module registration, equivalent semantically:

1. **Provider props** — listed above. The common case for dependencies that live at the app root.
2. **`useMcpModule(() => module, deps)`** — for dependencies owned deeper in the tree (a context provider that creates its own `QueryClient` internally, for example).
3. **Direct** — `McpClient.getInstance().registerModule(module)` from anywhere after the provider has mounted. Rarely needed outside of tests.

`McpClient.initialize` is idempotent — re-calls return the same singleton. `McpClient.getInstance()` throws before `initialize` has run.

### Dynamic tools (`useMcpTool`)

Tools registered from inside components via `useMcpTool` are reachable through `call` with the `_dynamic_` prefix:

```ts
useMcpTool('logout', () => ({
  description: 'Log out the current user',
  handler: () => { logout(); return { success: true }; },
}), [logout]);

// Agent: call(tool: "_dynamic_logout")
```

They appear in `list_tools` under a `(dynamic)` section.

### Data flow

1. `<McpProvider>` mounts → `McpClient.initialize()` opens a WebSocket to the bridge (port 8347 by default).
2. Provider effects run → module registrations are batched into `RegistrationMessage` with module descriptors + their tool schemas.
3. Agent calls `call` → server sends `ToolRequest` over WS → RN executes the handler → returns `ToolResponse`.
4. `useMcpTool` sends `tool_register` / `tool_unregister` → server tracks dynamic tools → agent calls via `_dynamic_` prefix.
5. Host-module tools bypass the WS entirely — they run in the Node process, shelling out to `xcrun simctl` / `adb` / `dist/bin/ios-hid`.
6. Image results (`host__screenshot`) are detected by `formatResult` and returned as MCP image content blocks.

### Babel plugins

- **`testIdPlugin`** (dev only, `react-native-mcp-kit/babel/test-id-plugin`): two transforms in one pass.
  1. Auto-adds `data-mcp-id="ComponentName:filePath:line"` to every capitalized JSX element (stable identifier consumed by `fiber_tree`). Options: `attr`, `separator`, `include`, `exclude`. Default excludes `Fragment`, `StrictMode`, `Suspense`.
  2. Emits `Component.__mcp_hooks = [{ name, kind, hook, fn? }, ...]` after every function/arrow declaration that (a) has a capitalized name + JSX body OR a body containing hook calls (covers portal-like components that `return null`), or (b) has a `/^use[A-Z]/` name + hook calls in body (custom hook). HOC-wrapped components are unwrapped name-agnostically: any callee that's an `Identifier` (`memo`, `forwardRef`, `observer`, `withAuth`, …) or import-namespaced `MemberExpression` (`React.memo`) is treated as a wrapper, recursing into its first argument. The unwrap also walks transparently through `_c = arrow` / sequence-expression wraps that react-refresh injects, and through TS casts (`memo(...) as Type`, `<Foo>...`, `satisfies`, `!`). For `const Foo = anyHoc(InnerFn)` the plugin emits `Object.defineProperty(Foo, '__mcp_hooks', { get: () => InnerFn.__mcp_hooks })` (wrapped in try/catch for frozen / primitive returns) so the lookup is order/scope/wrapper-shape agnostic. Hook calls are matched as direct identifiers (`useState(...)`) and MemberExpressions (`React.useState(...)`) so bundle-compiled library hooks are covered. `hook` records the source-level hook function name (`useState`, `useAnimatedStyle`); `fn` references the hook function when the callee resolves to a module-scoped binding — runtime reads `fn.__mcp_hooks` to recursively expand custom-hook sub-metadata. All metadata writes are deferred to `Program:exit` via a per-file queue so they survive `replaceWith` calls from upstream plugins (notably react-refresh re-traversing rebuilt subtrees). Metro runs the plugin on node_modules by default, so `react-redux`, `@tanstack/react-query`, etc. get annotated automatically (first build pays a few-second cost; cached after).

- **`stripPlugin`** (prod only, `react-native-mcp-kit/babel/strip-plugin`): removes every trace of mcp-kit from the bundle — imports / requires from `react-native-mcp-kit` and its sub-paths, `useMcpTool` / `useMcpModule` calls, `McpClient.*` chains, `client.register*` / `dispose` / `enableDebug` calls, `<McpProvider>` JSX wrappers (children preserved), `data-mcp-id` attributes, and `X.__mcp_hooks = [...]` assignments emitted by the test-id-plugin. Options: `additionalSources`, `additionalFunctions`. Handles `<McpProvider>` correctly in both JSX and expression contexts — including `() => (<McpProvider>…</McpProvider>)`, multi-child providers (wrapped in a Fragment), single-expression-container children (unwrapped), whitespace-only JSXText (filtered out).

With the strip plugin, `if (__DEV__)` wrappers are not needed — the plugin handles removal.

### Module interface

```ts
interface McpModule {
  name: string;
  description?: string;
  tools: Record<string, ToolHandler>;
}

interface ToolHandler {
  description: string;
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
  inputSchema?: Record<string, unknown>;
  timeout?: number;   // per-tool timeout in ms (default: 10s)
}
```

Module `description` surfaces in `list_tools` output. Use markdown with examples for complex modules (see `fiberTree.ts` — its description walks callers through finding, interacting, coordinates, and selects).

### Built-in modules (11)

- **alert** — `alertModule()`: show alerts with default/cancel/destructive buttons. 60s timeout. Tools: `show`.
- **console** — `consoleModule({ maxEntries?, levels?, stackTrace? })`: console.log/warn/error/info/debug ring buffer. Each entry carries a monotonic `id`. Args are stored raw and projected at query time via the shared `projectValue` — Errors / Dates / RegExp / Maps / Sets / class instances / cycles / functions / Symbols collapse to compact `${kind}` markers. `get_logs({ level?, path?, depth?, maxBytes? })` returns entries (default depth 3); drill via `path: '[-1:][0].args[1]'` etc. Path-drill to a string scalar returns the raw string. Tools: `get_logs`, `clear_logs`. (Per-level shortcuts `get_debug` / `get_info` / `get_warnings` / `get_errors` removed — pass `level` to `get_logs`.)
- **device** — `deviceModule()`: device / platform introspection + a handful of imperative actions. Reads collapsed into one `info({ select? })` returning `{ platform, dimensions, pixelRatio, appearance, appState, accessibility, keyboard, initialUrl, dev }` — pass `select: [...]` to limit fields. `dimensions` carries both DP (raw RN) and physical pixels (matches `host__tap` coords). Actions: `open_url({ url, dryRun? })` (dryRun checks Linking.canOpenURL only), `open_settings`, `dismiss_keyboard`, `reload`, `vibrate`. Tools: `info`, `open_url`, `open_settings`, `dismiss_keyboard`, `reload`, `vibrate`. (`get_platform` / `get_dimensions` / `get_pixel_ratio` / `get_appearance` / `get_app_state` / `get_accessibility_info` / `get_keyboard_state` / `get_initial_url` / `get_device_info` / `can_open_url` all removed — folded into `info` + `open_url({ dryRun })`.)
- **errors** — `errorsModule({ maxEntries? })`: unhandled JS errors (ErrorUtils.setGlobalHandler) + unhandled promise rejections (console.error sniffing). Deduplicates within 100ms. Every entry has a monotonic `id`, parsed `stackFrames` (V8 + Hermes formats) ready for `metro__symbolicate`, and the raw `stack` string. Listing tools accept the standard `path` / `depth` / `maxBytes` projection args (default depth 4 — entries + stackFrames expanded; long `stack` auto-wraps in `${str}` marker). Drill via `path: '[-1:][0].stack'` for the full stack string. Tools: `get_errors` (filters: `source`, `fatal`, `since`, `until`), `get_stats`, `clear_errors`. (`get_fatal` removed — `get_errors({ fatal: true })` covers it. `slice` and `includeStack` removed too — path drill covers both.)
- **fiberTree** — `fiberTreeModule({ rootRef?, navigationRef?, redactHookNames?, additionalRedactHookNames? })`: component tree inspection + interaction. rootRef auto-supplied by `McpProvider`; navigationRef enables `scope: "screen"`. The flagship `query` tool runs chained steps (each step: `scope` + criteria), dedup wrapper cascades, supports `not`/`any` criteria, `onlyVisible` viewport filter, `cache` (root-pointer keyed). Scopes: descendants / children / parent / ancestors / siblings / self / root / screen / nearest_host. `root` matches the React fiber root regardless of the previous step — use as the first step to start from the top of the tree. `waitFor: { until: 'appear' | 'disappear', timeout?, interval?, stable? }` wraps the same query in a polling loop (cache always bypassed inside) for UI-level waits — response gains `{ waited, attempts, elapsedMs, timedOut, stableFor? }`. `bounds` in physical pixels, pairs with `host__tap`. `call({ prop })` invokes prop callbacks, `call({ method })` invokes native-ref methods — both bypass the OS gesture pipeline. **Per-field projection** — `select` accepts strings (`"mcpId"`, light fields with no options) or objects with per-field options. Heavy fields (`props`, `hooks`) get their own `path` / `depth` / `maxBytes` knobs; the rest of the response (matches array, mcpId/name/total/...) stays raw and always visible. Projection runs handler-side via the shared `projectValue` (heavy nested values → `${kind}`-keyed markers like `{"${arr}":47}` / `{"${fun}":"name"}`). `select.props.{path,depth,maxBytes}` projects props (default depth=1); `select.hooks.{path,depth,maxBytes,kinds,names,withValues,expansionDepth,format}` projects hook values + filters. **Hook inspection** walks a fiber's `memoizedState` chain and pairs each slot with `__mcp_hooks` metadata emitted by the test-id-plugin. Reads metadata across the full HOC chain via candidate fallback: `fiber.type` → `fiber.elementType` → `fiber.type.render` (forwardRef) → `fiber.type.type` (memo wrapping non-function), so `memo(fn)`, `memo(forwardRef(fn))`, and identifier-ref forms all work. Custom-hook entries with annotated `fn` are recursively flattened, emitting both the parent (marked `expanded: true`) and its sub-hooks so the call-site stays visible. Black-box library hooks without `__mcp_hooks` get their slot count estimated by `countHookSlots(fn)` — first via recursive metadata, then `fn.toString()` regex over `useXxx(` calls (works on already-bundled libs because property names like `_react.useState` aren't mangled), cached per-fn in a WeakMap. Each entry is `{ kind, name, hook?, via?, expanded? }`. Hook options: `kinds?` / `names?` (filters), `withValues?` adds resolved values (each value projected with `select.hooks.{path,depth,maxBytes}`), `expansionDepth?` (cap recursion — `0` = top-level only, default `Infinity`), `format?: "flat" | "tree"` (default flat with `via:`; tree returns nested `children:`). Sensitive names — defaults `[/password/i, /token/i, /jwt/i, /secret/i, /Pin$/, /credential/i, /apiKey/i, /authorization/i]` matched against entry `name` AND every `via` ancestor — get `value: "[redacted]"` instead of the real value. Replace via `redactHookNames` (pass `[]` to disable) or extend via `additionalRedactHookNames`; both accept `Array<string | RegExp>` (strings = case-insensitive substring). Values that look like component refs collapse to `{"${ref}":{ mcpId, testID, name? }}` so agents can follow up via `query`. Alignment is shape-verified per kind — slots that don't match their expected shape (effect record for Effect, `{ current }` for Ref, `[v, deps]` for Memo, and obvious mismatches on State/Custom) are skipped. Metadata entries left over after the fiber chain runs dry are emitted without a `value` (visible to the agent rather than silently dropped). **Recursive children walker** — `select` accepts `{ children: N }` (short form, treeDepth=N, default fields ['mcpId','name']) or `{ children: { treeDepth?, select?, itemsCap? } }` to dump a light-only tree-of-tree from each match. select inside children may include only `mcpId` / `name` / `testID` / `bounds` / nested `children` — props/hooks throw at parse time (run a second query against a child mcpId to inspect them). At the last level, sub-children appear as `{ "${arr}": N }` so the agent sees there's more to drill. **`refMethods` field** in select returns the native-ref method list (focus / blur / measure / scrollTo / ...) for use with `call({ method })`; null when fiber has no native instance. Tools: `query`, `call`. (`get_props` / `get_tree` / `get_component` / `get_children` / `get_ref_methods` / `invoke` / `call_ref` all removed — covered by `query` with `select.children` + `scope:'root'` / `select.props.path` / `select: ['refMethods']`, and a single `call` with `prop` xor `method`.)
- **i18next** — `i18nextModule(i18n)`: wraps an i18next instance. Tools: `get_info`, `get_resource`, `get_keys`, `translate` (with interpolation), `search`, `change_language`.
- **log_box** — `logBoxModule()`: inspect + control the RN LogBox overlay. `get_logs` accepts standard `path` / `depth` / `maxBytes` projection args (default depth 4 — rows + stack frames expanded; long messages auto-wrap in `${str}` markers; drill via `path: '[0].stack[0]'` for one frame). Tools: `status`, `get_logs` (filter: `level`), `clear({ level? })` (omit / `"all"` clears every row; `"warn"` / `"error"` / `"syntax"` for surgical cleanup), `dismiss` (by index), `ignore` (substrings + `/regex/flags`), `ignore_all` (global mute), `set_installed({ enabled })`. Dev-only surface; production = no-op. (`clear_warnings` / `clear_errors` / `clear_syntax_errors` / `install` / `uninstall` removed — folded into `clear({ level })` / `set_installed({ enabled })`.)
- **navigation** — `navigationModule(ref)`: React Navigation control + 100-entry transition history. Current-route responses include a `screen` field with `{ componentName, mcpId?, filePath?, line? }` — skipping RN-internal wrappers (SceneView/StaticContainer/Screen/ForwardRef/Memo). Reads (`get_state`, `get_history`, `get_current_route`) accept standard `path` / `depth` / `maxBytes` (defaults: state 2, history 4, routes 3); `get_current_route({ withState?: boolean })` adds focused-route state + `focusedChild` chain when `withState:true`. Actions are merged by semantic verb: `navigate({ screen, params?, mode?: 'reuse' | 'push' | 'replace' })` (default mode reuses existing screen); `pop({ to?, params? })` — `to` is number (pop N), screen name (pop_to that name), or `"top"` (pop_to_top); plus `reset({ routes, index? })` and `go_back`. Tools: `get_state`, `get_current_route`, `get_history`, `navigate`, `pop`, `reset`, `go_back`. (`get_current_route_state` / `push` / `replace` / `pop_to` / `pop_to_top` removed — pass `withState` / `mode` / `to` to the surviving tools.)
- **network** — `networkModule({ maxEntries?, bodyMaxBytes?, ignoreUrls?, redactHeaders?, redactBodyKeys? })`: intercepts `fetch` + `XMLHttpRequest`. Auto-ignores WebSocket, Metro, symbolicate. Each entry has monotonic `id`. Bodies are stored raw (post JSON-parse + redact) up to `bodyMaxBytes` (default 20KB) — larger payloads collapse at capture time to `{ "${str}": { len, preview } }`. Headers and body-keys redacted at capture time (defaults: `authorization/cookie/set-cookie/x-api-key/x-auth-token/x-access-token` + `password/token/accessToken/refreshToken/apiKey/secret/otp/pin`). Listing tools (`get_requests`, `get_request`, `get_errors`, `get_pending`) accept the standard `path` / `depth` / `maxBytes` projection args (default depth 3 — entries expanded, headers map and bodies collapse to `${obj}` markers). Drill into a body via `path: '[-1:][0].response.body'` or bump `depth` to expand inline. Tools: `get_requests` (filters: `method`, `status`, `url`), `get_stats` (counts + duration percentiles + bytes), `clear_requests`. (`get_request` / `get_errors` / `get_pending` removed — pass `status: 'error' | 'pending' | 'success'` or `url: '...'` to `get_requests`. `get_body` and `includeBodies` also removed — drill-down via `path` covers the same use case.)
- **reactQuery** — `reactQueryModule(queryClient)`: TanStack Query cache inspection + mutation. `get_queries` returns metadata only (no `data`). `get_data` returns the full state for one key — its `data` field can be heavy, so the response goes through the standard `path` / `depth` / `maxBytes` projection (default depth 2 — outer expanded, data walked one level; drill via `path: 'data.user.email'`). `mutate({ action: 'invalidate' | 'refetch' | 'remove' | 'reset', key? })` consolidates all cache mutations into a single tool; omit `key` to target every cached query. Tools: `get_queries`, `get_data`, `get_stats`, `mutate`. (Per-action shortcuts `invalidate` / `refetch` / `remove` / `reset` removed — pass `action` to `mutate`.)
- **storage** — `storageModule(...storages)`: multiple named key-value stores. Adapter interface: `get` required; `set` / `delete` / `getAllKeys` optional (corresponding tools report unsupported if missing). Values JSON-parsed when possible. `get_item` and `get_all` accept the standard `path` / `depth` / `maxBytes` projection args (`get_item` default depth 2 — `{ key, value }` outer expanded, value walked one level; `get_all` default depth 1 — keys visible, values collapse to `${obj}`/`${arr}` markers, drill via `path: 'session.user.email'`). Tools: `get_item`, `set_item`, `delete_item`, `list_keys`, `get_all`, `list_storages`.

### Debug logging

`<McpProvider debug>` toggles colored console output for every WS request/response. Captured via the original `console.log` (before the console module intercepts it), so debug lines never land in `console__get_logs`.

Tag `[rn-mcp-kit]` is bold purple; module names take one of 12 bold ANSI colors assigned in registration order; method names are bold; cyan `→` = incoming request, green `←` = response, red `✕` = error.

## Code style

- **Path aliases**: `@/*` maps to `./src/*`. Relative `../` imports are lint-restricted — use `@/` for cross-directory, `./` for same-directory.
- **Type imports**: inline — `import { type Foo }`, not `import type { Foo }`. Same for re-exports.
- **Import order**: `eslint-plugin-import` enforces builtin → external → internal → parent → sibling, alphabetized, with blank lines between groups.
- **Object/interface keys**: sorted alphabetically (`sort-keys-fix`, `typescript-sort-keys`).
- **Formatting**: Prettier with 100-char printWidth, single quotes, 2-space indent, ES5 trailing commas.
- **Arrow functions**: always block body — `() => { return …; }`.
- **`.ts` only**: library avoids `.tsx` (no jsx transform configured). React components render via `createElement`. Lazy-require `react-native` so server entries don't pull it on Node.

## Key dependencies

- `@modelcontextprotocol/sdk` — MCP protocol (server-only). `registerTool` API. Imports require `.js` extension because of the SDK's ESM layout.
- `@babel/core` — dev dependency for the babel plugins.
- `ws` — WebSocket server (server-only; RN uses its built-in WebSocket).
- `zod` — Schema validation for MCP tool input schemas.
- `sharp` — server-side WebP encoding for `host__screenshot`.
- `tsc-alias` — resolves `@/` path aliases in compiled output (Metro and Node don't understand them).
- Peer: `react >= 19`, `react-native >= 0.79`, `react-native-device-info >= 10`.
