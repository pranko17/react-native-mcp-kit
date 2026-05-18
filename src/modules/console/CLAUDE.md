# `console` module

[`console.ts`](console.ts) — `consoleModule({ maxEntries?, levels?, stackTrace? })`, registered as `console`. Ring buffer for `console.{log,warn,error,info,debug,trace,group,groupCollapsed,groupEnd}`. See [`../CLAUDE.md`](../CLAUDE.md) for the module interface, side-effectful capture pattern (this module is one of the three patch-at-import singletons), and the shared projection vocabulary.

## Capture state

All capture state is module-scoped at the top of [`console.ts`](console.ts) (lines 51-55):

- `buffer: LogEntry[]` — the ring itself.
- `nextId` — starts at `1`, increments on every `addEntry`, **never resets** (not by `clear_logs`, not by re-invoking the factory). Monotonically increasing across the process lifetime — agents can use `id` as a stable cursor for "logs since last poll".
- `maxEntries` — defaults to `100` (`DEFAULT_MAX_ENTRIES`).
- `capturedLevels` — `Set<LogLevel>`, defaults to all nine levels (`ALL_LEVELS`).
- `stackLevels` — `Set<LogLevel>`, defaults to `['error', 'trace', 'warn']` (`DEFAULT_STACK_LEVELS`, line 25). `trace` is on by default because that's the point of trace; errors and warns get one so noisy assertions stay debuggable.

`addEntry` (lines 57-76) is the single write path. Level filter runs **before** the entry is built — dropped levels never allocate an entry or bump `nextId`. Ring-buffer eviction is FIFO via `buffer.splice(0, buffer.length - maxEntries)` (line 74) — oldest entries drop when the buffer grows past `maxEntries`.

## Patching

`installPatches()` (lines 79-99) runs at module-import time via the bare `installPatches()` call on line 101 — *before* React mounts and well before `<McpProvider>`'s `useEffect` fires. That's how cold-start logs from bundle evaluation / first render survive. The `patchesInstalled` flag guards reentry — the patches are singleton-by-side-effect.

Two patch shapes:

- `typeof console[level] === 'function'` → wrap: record then forward to the original (`addEntry(level, args); original.apply(console, args)`).
- Missing on the host console (RN may not implement `trace` / `group` / `groupCollapsed` / `groupEnd` depending on RN version + debugger) → install a recording-only stub (line 94) so the agent still sees the structural call.

Note: when the patches forward to the original, the `original` reference is the function as it was *at import time*. If anything else later monkey-patches `console.log` (the `<McpProvider debug>` logger uses the *original* via `originalConsoleLog`, so this isn't a problem in practice — see [`McpClient.ts`](../../client/core/McpClient.ts)), the console module won't see the new wrapper.

## Factory behavior

`consoleModule(options?)` (lines 113-171) does not install patches — it only **adopts** the already-running buffer:

- `options.maxEntries` overwrites the module-level `maxEntries` and immediately trims the buffer.
- `options.levels` replaces `capturedLevels`.
- `options.stackTrace`: `true` → every level (`ALL_LEVELS`), `false` → empty set, `LogLevel[]` → use as-is.

Calling the factory twice is supported but pointless — the second call simply rewrites the shared state. Don't depend on it.

## Stack capture

`captureStack()` (lines 35-41) reads `new Error().stack` and `slice(4)` to drop four frames: `Error`, `captureStack`, `addEntry`, the `console[level]` wrapper. The remaining text is the user's call site. Stack lines are raw — agents that want symbolicated frames should feed the string through `metro__symbolicate`.

## Tools

### `get_logs`

Returns log entries, optionally filtered by level, then projected. Input schema is `makeProjectionSchema(3)` plus an enum `level` filter (lines 160-167). Default depth `3` — top level is the entries array, depth 2 expands each entry (`id` / `level` / `timestamp` inline, `args` / `stack` collapse to markers), depth 3 opens the args array (primitives inline, nested objects → `${obj}` markers).

`level` filtering runs *before* projection by walking `buffer.filter(entry => entry.level === level)` (`filterByLevel`, lines 107-111). When `level` is omitted, the raw `buffer` is projected. Drill via `path: '[-1:][0].args[1]'` for the second argument of the most recent entry; ending a path on a string scalar returns the raw substring (bypasses `previewCap`).

Each entry shape — `{ id, level, timestamp, args, stack? }` — is declared in [`types.ts`](types.ts). `args` is stored **raw** (no per-arg serializer); the projection step at query time collapses Errors / Dates / RegExp / Maps / Sets / cycles / functions / class instances to `${kind}` markers. This keeps the hot path (every `console.log` call in the app) cheap.

### `clear_logs`

Sets `buffer.length = 0`. Does **not** reset `nextId` — the next entry after a clear will pick up where the counter left off, so `id` remains globally monotonic.
