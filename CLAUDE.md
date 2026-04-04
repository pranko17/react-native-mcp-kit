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

### Package Structure

The package has three entry points:

- **Root** (`src/index.ts`) — re-exports client + modules (RN-safe, no server code)
- **Server** (`src/server/`) — Node.js MCP server + WebSocket bridge (not bundled into RN)
- **Modules** (`src/modules/`) — built-in RN modules (navigation, console)

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
    mcpServer.ts            — McpServer wrapper, built-in tools (state_get, state_list, connection_status)
    cli.ts                  — CLI entry point (npx react-native-mcp)
  modules/
    console/                — Console log capture module (get_logs, get_errors, etc.)
    navigation/             — Navigation module (get_state, navigate, push, pop, replace, reset)
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
McpClient.initialize(port?);

// 2. Register modules (global, can be called from anywhere after init)
McpClient.getInstance().registerModules([navigationModule(ref), consoleModule()]);
McpClient.getInstance().registerModule(myModule);

// 3. McpProvider only provides context for hooks (useMcpState, useMcpTool)
<McpProvider>{children}</McpProvider>
```

Calling `McpClient.getInstance()` before `initialize()` throws an error with a console message.

Three ways to register modules:
- **Global**: `McpClient.getInstance().registerModule(module)` — from anywhere after init
- **Hook**: `useMcpModule(() => module, deps)` — tied to component lifecycle
- **Init**: Pass modules array when initializing

### Data Flow

1. `McpClient.initialize()` opens WebSocket to bridge (port 8347)
2. On connect + module registration, sends `RegistrationMessage` with module descriptors
3. MCP server registers tools dynamically based on registration
4. AI agent calls a tool → server sends `ToolRequest` over WS → RN app executes handler → returns `ToolResponse`
5. `useMcpState` sends `state_update` messages → server stores in memory → AI reads via `state_get` tool (no WS roundtrip)
6. `useMcpTool` sends `tool_register`/`tool_unregister` → server adds/removes tools dynamically

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
}
```

### Built-in Modules

- **navigation** — `navigationModule(navigationRef)`: get_state, get_current_route, get_current_route_state, navigate, push, pop, pop_to, pop_to_top, replace, reset
- **console** — `consoleModule(options?)`: intercepts console.log/warn/error/info/debug, ring buffer (default 100), stack traces for error/warn. Tools: get_logs, get_errors, get_warnings, get_info, get_debug, clear_logs. Serializes functions, class instances, circular refs, Errors, Dates, RegExp, Symbols.

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
