# `src/modules/logBox/` — LogBox overlay control

[`logBox.ts`](logBox.ts) — `logBoxModule()`, registered as **`log_box`** (with underscore). Agents call `call(tool: "log_box__get_logs")`, not `logBox__get_logs`. The factory name and registered name diverge — this is the one place that bites first-time callers. See [`../CLAUDE.md`](../CLAUDE.md) for the cross-module pattern (alongside `i18nextModule` → `i18n` and `reactQueryModule` → `query`).

Inspect and control the React Native LogBox overlay so warning toasts don't block the UI during tests, suppress noisy warnings with ignore patterns, or mute LogBox entirely.

## Dev-only gate

LogBox is a development surface. The factory reaches the runtime control plane via two indirections:

- Public: `getRN().LogBox` (from `@/shared/rn/core`) — install / uninstall / ignoreLogs / ignoreAllLogs / clearAllLogs / isInstalled.
- Private: `loadRNInternal('Libraries/LogBox/Data/LogBoxData')` ([`logBox.ts:52`](logBox.ts)) — the underlying singleton that owns the log list, ignore patterns, dismiss / clear-by-level / disabled state. RN ships an empty stub at this path in release bundles, so every call is guarded with optional chaining (`data?.getLogs?.()`, `data?.dismiss?.(log)`, etc.). Production = silent no-op, no exceptions.

`status` will return `installed: null` / `disabled: null` when the underlying methods don't exist (release builds, or RN versions that have moved the path); a non-null pair means the dev module is present.

## Tools

### `status`

LogBox state — `{ installed, disabled, logCount, ignorePatterns }`. `ignorePatterns` is normalized to strings via `String(p)` so a stored `RegExp` round-trips to its `/.../flags` form. Cheap; safe to poll.

### `get_logs({ level?, path?, depth?, maxBytes? })`

Reads the live `LogBoxData.getLogs()` Set, serializes each row to `{ index, level, category, message, count, stack? }`, then runs the result through the shared `projectValue` ([`../CLAUDE.md` projection refresher](../CLAUDE.md)). Default `depth: 4` so rows + frames expand in one shot; drill with `path: '[0].stack[0]'` for a single frame.

- `level` filter accepts `warn` / `error` / `fatal` / `syntax` (filter applied post-serialization).
- `index` is **0-based array order** in the current list — feed it back into `dismiss`. It changes when rows are dismissed or cleared.
- `message` comes from `log.message.content ?? String(log.message ?? '')` — RN wraps the rendered text in a content object ([`logBox.ts:67`](logBox.ts)).
- `count` is RN's row dedupe counter (defaults to 1).
- `stack` is **capped at 20 frames** ([`logBox.ts:69`](logBox.ts)); each frame is `{ file, line, column, method }` — note the rename from RN's native `lineNumber`/`methodName`. Frames are ready to feed into `metro__symbolicate`.

### `clear({ level? })`

Omit `level` (or pass `"all"`) → `LogBox.clearAllLogs()`. Otherwise routes to `LogBoxData.clearWarnings` / `clearErrors` / `clearSyntaxErrors`. Note: `level: "fatal"` is **not** accepted by `clear` (no `clearFatals` on `LogBoxData`) even though `get_logs` filters on it — unknown levels return `{ error: 'Unknown level "…"…' }`.

### `dismiss({ index })`

Drops one row by 0-based index. Resolves the index against the live `getLogsArray()` snapshot, then calls `LogBoxData.dismiss(log)`. Validates `index >= 0` and that a row exists at that position before dispatching.

### `ignore({ patterns })`

Non-empty array of strings. Each string runs through `parsePattern` ([`logBox.ts:34`](logBox.ts)):

- Matches `/^\/(.+)\/([gimsuy]*)$/` → `new RegExp(body, flags)`. Malformed regex falls back to the raw string (substring match).
- Anything else → kept as a literal substring.

Mixed arrays are fine: `['VirtualizedLists should never be nested', '/^Warning: /', '/useNativeDriver/i']`. Matching logs are hidden from the overlay but still print to the JS console.

### `ignore_all({ value? })`

Global mute. `value` defaults to `true` (silence everything); pass `false` to unmute. Calls `LogBox.ignoreAllLogs(value)`; console logging is unaffected.

### `set_installed({ enabled })`

Strict `enabled === true` check. `true` → `LogBox.install()`, `false` (or anything truthy-but-not-boolean-true) → `LogBox.uninstall()`. Uninstalled means the overlay stops appearing; warnings still log to console. RN treats repeated install / uninstall as a no-op when the requested state already holds.

## Patterns

Pre-test cleanup: `log_box__clear({})` then `log_box__ignore_all({ value: true })` if a flow is known to spam warnings you don't want recorded. To inspect what got muted later, call `log_box__status` — the underlying log list keeps growing in the background as long as the module is installed; `ignore_all` only suppresses the overlay rendering.

Pairs naturally with `metro__symbolicate`: feed `get_logs[i].stack` straight in for source-mapped frames, then `metro__open_in_editor` to jump.
