# `src/modules/` — Built-in MCP modules

Each module factory produces an `McpModule` with a fixed `name` and a flat `tools` map. Modules ship with `<McpProvider>` (the always-on batch — `alert`, `console`, `device`, `errors`, `log_box`, `network`, `fiber_tree`) or get registered when the matching provider prop is supplied (`navigation` via `navigationRef`, `i18n` via `i18n`, `query` via `queryClient`, `redux` via `store`, `storage` via `storages`). Custom modules can be slotted in via the `modules` prop, [`useMcpModule`](../client/hooks/useMcpModule.ts), or `McpClient.getInstance().registerModule(...)` directly.

Each module has its own `CLAUDE.md` with the concrete tool list, defaults, edge cases, and gotchas — drill into the relevant one when you need depth.

## Module name divergence

A few factory names diverge from the registered module name. Agents reach a tool through the **registered** name:

| Factory             | Registered name | Example tool           |
| ------------------- | --------------- | ---------------------- |
| `i18nextModule`     | `i18n`          | `i18n__translate`      |
| `reactQueryModule`  | `query`         | `query__get_data`      |
| `logBoxModule`      | `log_box`       | `log_box__get_logs`    |

All other modules use their factory's base name (e.g. `networkModule` → `network`).

## Built-in modules (12)

| Module          | Registered as | Doc                                                    | Provided automatically                                  |
| --------------- | ------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| `alertModule`       | `alert`       | [`alert/CLAUDE.md`](alert/CLAUDE.md)               | always-on                                               |
| `consoleModule`     | `console`     | [`console/CLAUDE.md`](console/CLAUDE.md)           | always-on (side-effectful capture)                      |
| `deviceModule`      | `device`      | [`device/CLAUDE.md`](device/CLAUDE.md)             | always-on                                               |
| `errorsModule`      | `errors`      | [`errors/CLAUDE.md`](errors/CLAUDE.md)             | always-on (side-effectful capture)                      |
| `fiberTreeModule`   | `fiber_tree`  | [`fiberTree/CLAUDE.md`](fiberTree/CLAUDE.md)       | always-on (rootRef auto-supplied)                       |
| `i18nextModule`     | `i18n`        | [`i18next/CLAUDE.md`](i18next/CLAUDE.md)           | when `<McpProvider i18n={…}>`                           |
| `logBoxModule`      | `log_box`     | [`logBox/CLAUDE.md`](logBox/CLAUDE.md)             | always-on (dev only)                                    |
| `navigationModule`  | `navigation`  | [`navigation/CLAUDE.md`](navigation/CLAUDE.md)     | when `<McpProvider navigationRef={…}>`                  |
| `networkModule`     | `network`     | [`network/CLAUDE.md`](network/CLAUDE.md)           | always-on (side-effectful capture)                      |
| `reactQueryModule`  | `query`       | [`reactQuery/CLAUDE.md`](reactQuery/CLAUDE.md)     | when `<McpProvider queryClient={…}>`                    |
| `reduxModule`       | `redux`       | [`redux/CLAUDE.md`](redux/CLAUDE.md)               | when `<McpProvider store={…}>`                          |
| `storageModule`     | `storage`     | [`storage/CLAUDE.md`](storage/CLAUDE.md)           | when `<McpProvider storages={…}>`                       |

## Module interface

[`client/models/types.ts`](../client/models/types.ts):

```ts
interface McpModule {
  name: string;
  tools: Record<string, ToolHandler>;
  description?: string;
}

interface ToolHandler {
  description: string;
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
  inputSchema?: ZodType;
  timeout?: number;   // per-tool timeout in ms (default: 10s)
}
```

The module `description` is markdown. Per-tool `description` + `inputSchema` surface directly in the agent's MCP catalog (tools are registered top-level) — use them for any non-obvious behaviour (defaults, mode flags, output shape); see `fiberTreeModule` for the most elaborate example.

Returning `null` / `undefined` is fine. Throwing turns into a `tool_response` with `error: error.message`. Tools that need more than 10s for the agent to wait should set an explicit `timeout` (e.g. `alert.show` uses 60s).

## File & folder convention

One folder per module, lowerCamelCase to match the factory name. Inside each folder: `<name>.ts` exports the factory, optional `types.ts` holds public shapes, `index.ts` re-exports the factory, `CLAUDE.md` documents tools / options / behaviour. Complex modules (fiberTree, network, console, errors) split capture state and helpers into siblings.

The root barrel [`index.ts`](index.ts) re-exports every factory; the package-level [`../index.ts`](../index.ts) re-exports the lot for RN consumers.

## Side-effectful capture modules

`console`, `errors`, and `network` install their patches at **module-import time**, not inside the factory. That window matters: anything `console.log`'d, thrown, or `fetch`'d during bundle evaluation (analytics bootstrap, OAuth refresh, etc.) lands in the ring buffer before `<McpProvider>` mounts. The factory then *adopts* the running buffer and applies caller options (max entries, redaction lists, captured levels) retroactively. Don't call the factory more than once — it's a singleton-by-side-effect.

The per-module `CLAUDE.md` files document the install guard, retroactive-adopt semantics, and how `nextId` survives `clear_*` (intentional: stable cursor for "since last poll").

## Projection refresher

Every tool that returns heavy JSON (`console`, `errors`, `network`, `reactQuery`, `storage`, `navigation`, fiberTree props/hooks, `log_box`) shares the standard projection input via `makeProjectionSchema(defaultDepth)`. Knobs: `path` / `depth` / `maxBytes` / `previewCap` / `objectCap` / `arrayCap`. Each module sets a per-tool `defaultDepth` chosen so the typical query returns useful structure without a follow-up — drill via `path` (`[-1:][0].request.body.user.email`, `data.user.email`, `events[-3:]`) or bump `depth` for deeper expansion. See [`../shared/CLAUDE.md`](../shared/CLAUDE.md) for the full marker vocabulary (`${obj}` / `${arr}` / `${str}` / `${fun}` / `${Err}` / `${cyc}` / `${ref}` / `${Date}` / …).
