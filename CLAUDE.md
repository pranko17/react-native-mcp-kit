# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
yarn build          # Compile TypeScript (output to dist/, then tsc-alias resolves @/ paths)
yarn dev            # Watch mode compilation
yarn lint           # ESLint check (src/**/*.{ts,tsx})
yarn lint:fix       # Auto-fix ESLint violations
yarn lint:ts        # TypeScript type check (tsc --noEmit)
```

No test suite is configured.

## Architecture

`react-native-mcp` is a bidirectional MCP bridge connecting React Native apps to AI agents. The server is a proxy — all business logic (state collection, command execution) runs inside the RN app.

```
AI Agent  --stdio/MCP-->  MCP Server (Node.js)  --WebSocket-->  RN App (device)
```

### MCP Server Tools

The server exposes 5 static tools (always available, no dynamic registration needed):

- **`call`** — Universal proxy to call any tool registered by the RN app. Format: `call(tool: "module_method", args: '{"key": "value"}')`. Args is a JSON string.
- **`list_tools`** — Lists all available tools from all registered modules, grouped by module.
- **`connection_status`** — Check if the RN app is connected and which modules are registered.
- **`state_get`** / **`state_list`** — Read state exposed by `useMcpState` hooks.

This design avoids dynamic tool registration issues — all module tools are accessed through the universal `call` tool.

### Package Structure

The package has three entry points:

- **Root** (`src/index.ts`) — re-exports client + modules (RN-safe, no server code)
- **Server** (`src/server/`) — Node.js MCP server + WebSocket bridge (not bundled into RN)
- **Modules** (`src/modules/`) — built-in RN modules

```
src/
  client/
    core/                   — McpClient singleton (connection, module registration)
    contexts/McpContext/    — McpContext, McpProvider (context for hooks only)
    hooks/                  — useMcpState, useMcpTool, useMcpModule (noop in prod)
    models/                 — McpModule, ToolHandler interfaces
    utils/                  — McpConnection (WS client), ModuleRunner
  server/
    bridge.ts               — WebSocket server, request/response dispatch
    mcpServer.ts            — 5 static MCP tools (call, list_tools, connection_status, state_get, state_list)
    cli.ts                  — CLI entry point (npx react-native-mcp)
  modules/
    components/             — React fiber tree inspection, invoke callbacks, call ref methods
    console/                — Console log capture (log/warn/error/info/debug)
    device/                 — Device info, app state, keyboard, linking, reload, vibrate
    errors/                 — Unhandled errors and promise rejections
    navigation/             — Navigation state, navigate, push, pop, replace, reset
    network/                — HTTP request interception (fetch + XMLHttpRequest)
  shared/
    protocol.ts             — WebSocket message types (RegistrationMessage, ToolRequest, etc.)
```

### File & Folder Conventions

- **Contexts**: `contexts/ContextName/` folder with `ContextName.ts`, types, provider, and `index.ts` barrel export.
- **Hooks**: camelCase files in `hooks/` (e.g. `useMcpState.ts`).
- **Models**: types in `models/types.ts`.
- **Modules**: each module gets its own folder in `modules/` (e.g. `modules/navigation/`) with `navigation.ts`, `types.ts`, and `index.ts`. This allows splitting complex modules across multiple files.

### Initialization & Module Registration

`McpClient` is a singleton that manages the WebSocket connection and module registry.

```typescript
// 1. Initialize (creates connection, must be called first)
McpClient.initialize({ port: 8347, debug: true });

// 2. Register modules (global, can be called from anywhere after init)
McpClient.getInstance().registerModules([
  componentsModule(),
  navigationModule(ref),
  consoleModule(),
  deviceModule(),
  errorsModule(),
  networkModule(),
]);

// 3. McpProvider only provides context for hooks (useMcpState, useMcpTool)
<McpProvider>{children}</McpProvider>
```

Calling `McpClient.getInstance()` before `initialize()` throws an error with a console message.

Three ways to register modules:
- **Global**: `McpClient.getInstance().registerModule(module)` — from anywhere after init
- **Hook**: `useMcpModule(() => module, deps)` — tied to component lifecycle
- **Init time**: Register right after `McpClient.initialize()`

### Data Flow

1. `McpClient.initialize()` opens WebSocket to bridge (port 8347)
2. On connect + module registration, sends `RegistrationMessage` with module descriptors
3. AI agent calls `call` tool → server sends `ToolRequest` over WS → RN app executes handler → returns `ToolResponse`
4. `useMcpState` sends `state_update` messages → server stores in memory → AI reads via `state_get` (no WS roundtrip)

### Dev vs Production

- `useMcpState`, `useMcpTool`, `useMcpModule` check `typeof __DEV__ !== 'undefined' && __DEV__` — in production they are `() => {}` (noop)
- `McpClient.initialize()` and `McpProvider` are wrapped in `if (__DEV__)` by the consuming app
- Metro tree-shakes the dev branch entirely from production bundles

### Module Interface

Modules are plain objects with named tools. Each tool has a handler that runs in the RN runtime:

```typescript
interface McpModule {
  name: string;
  tools: Record<string, ToolHandler>;
}

interface ToolHandler {
  description: string;
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
  inputSchema?: Record<string, unknown>;
  timeout?: number; // per-tool timeout in ms (default: 10s)
}
```

### Built-in Modules (10)

- **alert** — `alertModule()`: show alerts with custom buttons and styles (default/cancel/destructive). Returns pressed button. 60s timeout. Tools: show

- **components** — `componentsModule()`: React fiber tree inspection. Tools:
  - `get_tree` / `get_component` / `get_children` / `get_props` / `find_all` — inspect component tree
  - `invoke` — call any callback prop (onPress, onChangeText, etc.) with custom args
  - `call_ref` / `get_ref_methods` — call methods on native instance (focus, blur, measure, etc.)
  - Search supports: `name`, `testID`, `text`, `index` (N-th match), `within` (parent path with "/" separator and ":N" index, e.g. `"Checkbox/Pressable"`, `"Button:1/View"`)

- **console** — `consoleModule(options?)`: intercepts console.log/warn/error/info/debug, ring buffer (default 100), stack traces for error/warn. Serializes functions, class instances, circular refs, Errors, Dates, RegExp, Symbols. Tools: get_logs, get_errors, get_warnings, get_info, get_debug, clear_logs

- **device** — `deviceModule()`: get_device_info, get_platform, get_dimensions, get_pixel_ratio, get_appearance, get_app_state, get_accessibility_info, get_keyboard_state, dismiss_keyboard, open_url, can_open_url, get_initial_url, open_settings, reload, vibrate

- **errors** — `errorsModule()`: captures unhandled JS errors (ErrorUtils) and promise rejections (console.error interception). Tools: get_errors, get_fatal, get_stats, clear_errors

- **i18next** — `i18nextModule(i18n)`: accepts i18next instance. Tools: get_info, get_resource, get_keys, translate (with interpolation), search (keys and values), change_language

- **navigation** — `navigationModule(navigationRef)`: get_state, get_current_route, get_current_route_state, navigate, push, pop, pop_to, pop_to_top, replace, reset

- **network** — `networkModule(options?)`: intercepts fetch and XMLHttpRequest, captures request/response bodies, headers, status, duration. Auto-ignores WebSocket, Metro, symbolicate. Tools: get_requests, get_request, get_errors, get_pending, get_stats, clear_requests

- **reactQuery** — `reactQueryModule(queryClient)`: accepts QueryClient instance. Cache inspection and management. Tools: get_queries, get_data, get_stats, invalidate, refetch, remove, reset

- **storage** — `storageModule(...storages)`: accepts multiple named storage adapters (MMKV, AsyncStorage, or custom). Async-compatible. Tools: get_item, set_item, delete_item, list_keys, get_all, list_storages

### Debug Logging

`McpClient.initialize({ debug: true })` enables colored console output showing all tool requests/responses. Uses original `console.log` (captured before console module intercepts it) so debug logs don't appear in the console module buffer.

## Code Style

- **Path aliases**: `@/*` maps to `./src/*`. Relative `../` imports are lint-restricted — use `@/` for cross-directory, `./` for same-directory.
- **Type imports**: Always inline — `import { type Foo }` not `import type { Foo }`. Same for re-exports: `export { type Foo }`.
- **Import order**: Enforced by `eslint-plugin-import` — builtin → external → internal → parent → sibling, with blank lines between groups, alphabetized.
- **Object/interface keys**: Sorted alphabetically (enforced by `sort-keys-fix` and `typescript-sort-keys`).
- **Formatting**: Prettier with 100-char printWidth, single quotes, 2-space indent, es5 trailing commas.
- **Arrow functions**: Always use block body `() => { return ...; }`, never concise body.

## Key Dependencies

- `@modelcontextprotocol/sdk` — MCP protocol implementation (server-side only). Imports require `.js` extension.
- `ws` — WebSocket server (server-side only, RN uses built-in WebSocket).
- `zod` — Schema validation for MCP tool input schemas.
- `tsc-alias` — Resolves `@/` path aliases in compiled output (Metro doesn't understand them).
- `react` — Peer dependency (>=19), optional (server can run without it).
