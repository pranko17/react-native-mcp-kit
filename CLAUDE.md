# CLAUDE.md

This file orients Claude Code (and any reader) at the top of the repository. The deep documentation has been split per subdirectory — start here, then jump.

## What this is

`react-native-mcp-kit` is a bidirectional MCP bridge connecting React Native apps to AI agents. The Node-side MCP server proxies in-app business logic over a WebSocket and additionally hosts an OS-level control plane that shells out to `adb` / `xcrun simctl` / `xcrun devicectl` / a bundled Swift HID injector to drive the device. Real iOS 17+ devices are reached via a native TS client speaking RemoteXPC + DTX over Apple's CoreDevice tunnel — no `pymobiledevice3`, no WebDriverAgent, no Appium.

```
AI Agent  --stdio/MCP-->  session proxy  --WS-->  shared daemon  --WebSocket-->  RN App (device)
                                                       │
                                                       ├─ host module (adb / xcrun simctl / ios-hid binary) --> sim / emulator / android
                                                       └─ coredevice client (RemoteXPC + DTX over CoreDevice tunnel) --> real iOS 17+ device
```

Each agent session's MCP process is a thin **stdio proxy**; the first one spawns a detached **daemon** that owns the bridge, the tool registry, and all app state. Any number of sessions attach to the one daemon (identical live catalog, one app connection); it exits ~1 min after the last session closes. Single-process embedding via `createServer` still exists for tests. See [`src/server/`](src/server/CLAUDE.md) for the process model.

## Commands

```bash
yarn build          # tsc + tsc-alias + ./scripts/build-ios-hid.sh → dist/ (incl. dist/bin/ios-hid)
yarn dev            # tsc watch mode
yarn lint           # ESLint (src/**/*.{ts,tsx})
yarn lint:fix       # Auto-fix ESLint violations
yarn lint:ts        # TypeScript type check (tsc --noEmit; covers tests/)
yarn test           # vitest — unit + integration (tests/)
```

Tests live in `tests/` (kept out of `dist` — the build compiles `src` only via
`tsconfig.build.json`). Three layers: unit suites for the schema converter /
helpers / predicates / projection / babel plugins, a description-preservation
audit over every module factory (guards the zod JSON-Schema round-trip), and
in-process integration suites driving Bridge + McpServerWrapper through
`InMemoryTransport` and real `ws` clients speaking the wire protocol —
including a multi-session suite (daemon + proxies over real sockets, shared
catalog, idle shutdown, version handshake). UI changes are still verified
manually against a running RN app.

## Subdirectory guides

Each subdirectory has its own `CLAUDE.md` with the concrete details. Skim from the top, drill into the relevant one when you need depth.

| Directory                                                 | Focus                                                                                                                  |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [`src/babel/`](src/babel/CLAUDE.md)                       | Babel plugins: `testIdPlugin` (data-mcp-id JSX attr + `__mcp_hooks` metadata emit) and `stripPlugin` (prod-strip).      |
| [`src/client/`](src/client/CLAUDE.md)                     | RN side: `<McpProvider>`, `McpClient` singleton, `useMcpTool` / `useMcpModule`, registration paths, debug logging.     |
| [`src/server/`](src/server/CLAUDE.md)                     | MCP server: session-proxy / shared-daemon process model, tool registry (host + client-module + dynamic tools, refcount-dedup'd, live via `list_changed`), MCP fronts, the `wait_until`/`assert` wrappers, bridge, dispatcher. |
| [`src/server/host/`](src/server/host/CLAUDE.md)           | Host module: OS-level tools (`input`, `capture`, `lifecycle`, `devices`, `tap_fiber`), device resolver, Swift HID, real-iOS CoreDevice tunnel. |
| [`src/server/metro/`](src/server/metro/CLAUDE.md)         | Metro dev-server control plane: `symbolicate`, `reload`, `status`, `open_in_editor`, `get_events`.                    |
| [`src/modules/`](src/modules/CLAUDE.md)                   | In-app modules — index + module-interface contract + side-effectful-capture pattern + projection refresher. Each of the 12 modules has its own per-folder `CLAUDE.md` (alert / console / device / errors / fiberTree / i18next / logBox / navigation / network / reactQuery / redux / storage). |
| [`src/shared/`](src/shared/CLAUDE.md)                     | Code reachable by both sides: WS `protocol.ts`, projection (path drill + `${kind}` markers), RN lazy-require helpers. |

## Package entry points

Multiple bundles ship from one `package.json`:

| Subpath                  | Source                  | Audience                                                       |
| ------------------------ | ----------------------- | -------------------------------------------------------------- |
| `react-native-mcp-kit`   | `src/index.ts`          | App code — re-exports client + modules (RN-safe).              |
| `…/client`               | `src/client/index.ts`   | Just the client subset (`<McpProvider>`, hooks, `McpClient`).  |
| `…/modules`              | `src/modules/index.ts`  | Module factories only.                                         |
| `…/jest`                 | `src/jest/index.ts`     | Jest mock — no-op, type-compliant stubs of the whole public API (RN/Node-safe, no react import). |
| `…/server`               | `src/server/index.ts`   | Node-side `createServer` — **not** bundled into RN.            |
| `…/babel`                | `src/babel/index.ts`    | Both Babel plugins.                                            |
| `…/babel/test-id-plugin` | `src/babel/testIdPlugin/index.ts` | Direct plugin import.                                 |
| `…/babel/strip-plugin`   | `src/babel/stripPlugin.ts`  | Direct plugin import.                                       |

`react-native-mcp-kit` CLI binary (`bin/react-native-mcp-kit`) resolves to `dist/server/cli.js`.

## File & folder conventions

- **Contexts**: `contexts/ContextName/` folder with separate files for context, provider, types + `index.ts` barrel.
- **Hooks**: camelCase files in `hooks/` (e.g. `useMcpTool.ts`).
- **Models**: types in `models/types.ts`.
- **Modules**: each module gets its own folder (e.g. `modules/navigation/`) with `<name>.ts`, `types.ts`, `index.ts`. Complex modules split utilities into sibling files — see `modules/fiberTree/` (13 files).
- **Server tools**: each MCP tool in `src/server/tools/<name>.ts`, exporting `register<Name>Tool(mcp, ctx)`.
- **Host tools**: each host tool in `src/server/host/tools/<name>.ts`.

## Code style

- **Path aliases**: `@/*` maps to `./src/*`. Relative `../` imports are lint-restricted (`no-restricted-imports`) — use `@/` for cross-directory, `./` for same-directory.
- **Type imports**: inline — `import { type Foo }`, not `import type { Foo }`. Same for re-exports.
- **Import order**: `eslint-plugin-import` enforces builtin → external → internal → parent → sibling, alphabetized, with blank lines between groups.
- **Object / interface keys**: sorted alphabetically (`sort-keys-fix`, `typescript-sort-keys`).
- **Formatting**: Prettier with 100-char `printWidth`, single quotes, 2-space indent, ES5 trailing commas.
- **Arrow functions**: always block body — `() => { return …; }`.
- **`.ts` only**: library avoids `.tsx` (no jsx transform configured). React components render via `createElement`. Lazy-require `react-native` so server entries don't pull it on Node.

## Key dependencies

- `@modelcontextprotocol/sdk` — MCP protocol (server-only). MCP fronts use the low-level `Server` (a passthrough serving a catalog owned by the registry, which the high-level `McpServer` can't express). Deep imports keep the `.js` extension (SDK ESM layout); module resolution for eslint runs through `eslint-import-resolver-typescript`.
- `@babel/core` — devDep for the Babel plugins.
- `ws` — WebSocket server (server-only; RN uses its built-in WebSocket).
- `zod` — Schema validation for MCP tool input schemas.
- `sharp` — server-side WebP encoding for `host__screenshot`.
- `bplist-creator` / `bplist-parser` — used by the CoreDevice NSKeyedArchiver codec.
- `tsc-alias` — resolves `@/` path aliases in compiled output (Metro and Node don't understand them).
- **Peer**: `react >= 19`, `react-native >= 0.79`, `react-native-device-info >= 10`.

## Module-naming footguns

The factory name and the registered module name diverge for three modules — agents calling `<factory-name>__method` will fail. See [`src/modules/CLAUDE.md`](src/modules/CLAUDE.md) for the full table.

| Factory             | Registered name |
| ------------------- | --------------- |
| `i18nextModule`     | `i18n`          |
| `reactQueryModule`  | `query`         |
| `logBoxModule`      | `log_box`       |

## See also

- `README.md` — user-facing pitch + quick-start.
- [`src/server/host/coredevice/README.md`](src/server/host/coredevice/README.md) — real-iOS protocol layer (already-existing standalone doc).
- [`src/server/host/coredevice/PROTOCOL.md`](src/server/host/coredevice/PROTOCOL.md) — bytewise wire-format reference for RSD / XpcWrapper / DTX / NSKeyedArchiver.
