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

The server registers 6 static tools via `this.mcp.registerTool` in `src/server/mcpServer.ts`:

- **`call`** — Universal dispatcher. Format: `call(tool: "module__method", args: '{...}')`. Args is a JSON string. Dynamic tools from `useMcpTool` hooks use the `_dynamic_` prefix: `call(tool: "_dynamic_logout")`. When multiple clients are connected, `clientId` must be specified.
- **`list_tools`** — Lists all tools across all clients, grouped by module, with compact (schema-less) output. Clients with structurally identical modules are deduplicated into one entry with a `clientIds` array.
- **`describe_tool`** — Returns the full input schema for a specific tool. For in-app tools, `clientId` only needed when more than one client has the same tool with different schemas.
- **`connection_status`** — Lists connected clients with platform, label, deviceId, bundleId, and the module names they've registered.
- **`state_get`** / **`state_list`** — Read state exposed by `useMcpState` hooks. Scoped per client.

Server instructions + tool annotations (`readOnlyHint`, `openWorldHint`, `title`) live alongside each `registerTool` call.

### Host module (OS-level control)

Exposed when `hostModule` is passed to `createServer` (the default in `cli.ts`). Adds host-side tools that don't need the RN app to be connected:

- **Input** (`host/tools/input.ts`): `host__tap`, `host__swipe`, `host__type_text`, `host__press_key`. All coordinates are **PHYSICAL PIXELS** and match the `bounds` returned by `fiber_tree` — feed `bounds.centerX` / `bounds.centerY` straight into `host__tap`. `host__type_text` on Android is **ASCII-only** (preflight check) because `adb shell input text` routes through a KeyCharacterMap that lacks non-ASCII entries; use `fiber_tree__invoke` on `onChangeText` for Cyrillic/CJK/emoji on Android.
- **Capture** (`host/tools/capture.ts`): `host__screenshot` — WebP, auto-resized, diff-cached via SHA-256 per device (returns `unchanged: true` when identical to last capture).
- **Lifecycle** (`host/tools/lifecycle.ts`): `host__launch_app`, `host__terminate_app`, `host__restart_app`. `appId` optional when a connected client registered its `bundleId`.
- **Devices** (`host/tools/devices.ts`): `host__list_devices` — annotates each device with `connected: true` / `clientId` when it matches a live client.

**iOS input** goes through `dist/bin/ios-hid` — a Swift CLI (`src/swift/ios-hid.swift`) that injects HID events directly into iOS Simulator via `SimulatorKit` + `CoreSimulator` private frameworks (no WDA, no idb, no Appium). Built during `yarn build` by `scripts/build-ios-hid.sh` as a universal arm64+x86_64 binary. `src/server/host/iosInput.ts` is the TS wrapper that shells out to it.

**Coordinate system invariant**: the Swift binary passes `(x, y)` pixel coordinates directly to `IndigoHIDMessageForMouseNSEvent` alongside `screenSize` also in pixels — the function internally treats `CGPoint / screenSize` as a ratio. Do not divide by `screenScale` in `createMouseEvent` — that causes the tap to land at 1/9 of the intended position.

**Android** is plain `adb shell input tap/swipe/text/keyevent`, `screencap`, `monkey`.

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
    testIdPlugin.ts         — Adds data-mcp-id="Component:file:line" to capitalized JSX
    stripPlugin.ts          — Removes all MCP code (imports, calls, <McpProvider>, data-mcp-id)
    index.ts                — Barrel
  client/
    core/McpClient.ts       — Singleton: WS connection, module registry, debug log, state/tool APIs
    contexts/McpContext/
      McpProvider.ts        — Owns client init + conditional module registration + context
      McpContext.ts         — React context (consumed by useMcp* hooks)
      types.ts              — McpProviderProps, McpContextValue
    hooks/                  — useMcpState, useMcpTool, useMcpModule
    models/types.ts         — McpModule, ToolHandler
    utils/                  — McpConnection (WS client), ModuleRunner
  server/
    mcpServer.ts            — 6 static MCP tools, server instructions, image-content support
    bridge.ts               — WS server, request/response dispatch, client identity
    host/                   — Host module (OS-level tools that shell out)
      hostModule.ts
      iosInput.ts           — Wraps dist/bin/ios-hid
      deviceResolver.ts     — Resolve target device from clientId / udid / serial / platform
      processRunner.ts      — Abstracted child_process runner (mockable)
      tools/
        input.ts            — tap / swipe / type_text / press_key
        capture.ts          — screenshot (with diff cache)
        lifecycle.ts        — launch / terminate / restart
        devices.ts          — list_devices
    cli.ts                  — #!/usr/bin/env node — parses --port / --no-host, boots server
    index.ts                — createServer()
  swift/
    ios-hid.swift           — HID injector compiled into dist/bin/ios-hid
  modules/
    alert/                  — Native Alert.alert with custom buttons
    console/                — console.log/warn/error/info/debug capture (ring buffer)
    device/                 — Platform facts + open URLs / settings / reload / vibrate / keyboard
    errors/                 — Unhandled JS errors + promise rejections (ErrorUtils + console.error)
    fiberTree/              — Component tree inspection; bounds in physical pixels
    i18next/                — i18next translation inspection + change_language
    navigation/             — React Navigation control + 100-entry history
    network/                — fetch + XMLHttpRequest interception
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
- **Hooks**: camelCase files in `hooks/` (e.g. `useMcpState.ts`).
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

Always-on modules registered by the provider: `alert`, `console`, `device`, `errors`, `network`, `fiber_tree` (with the internal rootRef).

The provider also keeps the context value exposed by `McpContext`, so `useMcpState` / `useMcpTool` / `useMcpModule` keep working.

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
4. `useMcpState` sends `state_update` / `state_remove` messages → server keeps a per-client map → agent reads via `state_get` / `state_list` (no WS roundtrip for reads).
5. `useMcpTool` sends `tool_register` / `tool_unregister` → server tracks dynamic tools → agent calls via `_dynamic_` prefix.
6. Host-module tools bypass the WS entirely — they run in the Node process, shelling out to `xcrun simctl` / `adb` / `dist/bin/ios-hid`.
7. Image results (`host__screenshot`) are detected by `formatResult` and returned as MCP image content blocks.

### Babel plugins

- **`testIdPlugin`** (dev only, `react-native-mcp-kit/babel/test-id-plugin`): auto-adds `data-mcp-id="ComponentName:filePath:line"` to every capitalized JSX element. `fiber_tree` uses this as a stable identifier. Options: `attr`, `separator`, `include`, `exclude`. Default excludes `Fragment`, `StrictMode`, `Suspense`.

- **`stripPlugin`** (prod only, `react-native-mcp-kit/babel/strip-plugin`): removes every trace of mcp-kit from the bundle — imports / requires from `react-native-mcp-kit` and its sub-paths, `useMcpState` / `useMcpTool` / `useMcpModule` calls, `McpClient.*` chains, `client.register*` / `dispose` / `enableDebug` calls, `<McpProvider>` JSX wrappers (children preserved), and `data-mcp-id` attributes. Options: `additionalSources`, `additionalFunctions`. Handles `<McpProvider>` correctly in both JSX and expression contexts — including `() => (<McpProvider>…</McpProvider>)`, multi-child providers (wrapped in a Fragment), single-expression-container children (unwrapped), whitespace-only JSXText (filtered out).

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

### Built-in modules (10)

- **alert** — `alertModule()`: show alerts with default/cancel/destructive buttons. 60s timeout. Tools: `show`.
- **console** — `consoleModule({ maxEntries?, levels?, stackTrace? })`: console.log/warn/error/info/debug ring buffer. Serialises functions, class instances, cyclic refs, Errors, Dates, RegExp, Symbols. Tools: `get_logs`, `get_errors`, `get_warnings`, `get_info`, `get_debug`, `clear_logs`.
- **device** — `deviceModule()`: platform + dimensions (DP + physical px) + pixel ratio + appearance + app state + accessibility + keyboard + URL handling + reload + vibrate. 15 read-only / imperative tools.
- **errors** — `errorsModule({ maxEntries? })`: unhandled JS errors (ErrorUtils.setGlobalHandler) + unhandled promise rejections (console.error sniffing). Deduplicates within 100ms. Tools: `get_errors`, `get_fatal`, `get_stats`, `clear_errors`.
- **fiberTree** — `fiberTreeModule({ rootRef? })`: component tree inspection + interaction. rootRef auto-supplied by `McpProvider`. Search by `mcpId` / `testID` / `name` / `text` / `hasProps`, scope with `within: "Parent/Child:1"`, project output with `select: ["mcpId", "name", "testID", "props", "bounds"]`. `bounds` in physical pixels, pairs with `host__tap`. `invoke` calls props directly (bypasses OS gesture pipeline). Tools: `get_tree`, `get_component`, `get_children`, `get_props`, `find_all`, `invoke`, `call_ref`, `get_ref_methods`.
- **i18next** — `i18nextModule(i18n)`: wraps an i18next instance. Tools: `get_info`, `get_resource`, `get_keys`, `translate` (with interpolation), `search`, `change_language`.
- **navigation** — `navigationModule(ref)`: React Navigation control + 100-entry transition history. Tools: `get_state`, `get_current_route`, `get_current_route_state`, `get_history`, `navigate`, `push`, `pop`, `pop_to`, `pop_to_top`, `replace`, `reset`, `go_back`.
- **network** — `networkModule({ maxEntries?, includeBodies?, ignoreUrls? })`: intercepts `fetch` + `XMLHttpRequest`. Auto-ignores WebSocket, Metro, symbolicate. Tools: `get_requests`, `get_request`, `get_errors`, `get_pending`, `get_stats`, `clear_requests`.
- **reactQuery** — `reactQueryModule(queryClient)`: TanStack Query cache inspection + mutation. Tools: `get_queries`, `get_data`, `get_stats`, `invalidate`, `refetch`, `remove`, `reset`.
- **storage** — `storageModule(...storages)`: multiple named key-value stores. Adapter interface: `get` required; `set` / `delete` / `getAllKeys` optional (corresponding tools report unsupported if missing). Tools: `get_item`, `set_item`, `delete_item`, `list_keys`, `get_all`, `list_storages`.

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
