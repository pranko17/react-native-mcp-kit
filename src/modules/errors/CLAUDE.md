# `errors/`

`errorsModule({ maxEntries? })` — see [errors.ts](errors.ts), [types.ts](types.ts). Registered as `errors`; default `maxEntries: 50`. Captures unhandled JS errors plus unhandled promise rejections into a ring buffer, with stack traces pre-parsed into structured frames ready for `metro__symbolicate`.

See [`src/modules/CLAUDE.md`](../CLAUDE.md) for the shared side-effectful-capture rules and the projection vocabulary.

## Capture sources

Patches are installed at **module-import time** behind a `patchesInstalled` guard ([errors.ts:84-134](errors.ts)) so a single install survives repeated `errorsModule()` calls. The factory only adopts caller options retroactively — passing a smaller `maxEntries` immediately splices the running buffer down to size ([errors.ts:141-146](errors.ts)). The buffer, ID counter, and `maxEntries` are all module-level singletons.

Two interception points feed `addEntry`:

1. **`ErrorUtils.setGlobalHandler`** ([errors.ts:91-108](errors.ts)) — wraps any existing handler and forwards to `originalHandler` after recording, so the RN red box still renders. Source is `'promise'` if `error.message?.includes('in promise')`, else `'global'` — even fatal errors are reclassified as `promise` when the message says so.
2. **`console.error` sniff** ([errors.ts:111-131](errors.ts)) — RN reports unhandled promise rejections through `console.error` with an Error-shaped first argument. The patch only records when `firstArg.message?.includes('in promise')`; everything else passes through to the original `console.error` untouched (so the `console` module still sees the same log).

Both paths produce `{ id, isFatal, message, source, timestamp, stack?, stackFrames? }` ([types.ts](types.ts)). `isFatal` from `ErrorUtils` flows through verbatim; the `console.error` path hardcodes `isFatal: false`.

### Dedup window

`addEntry` ([errors.ts:70-82](errors.ts)) compares the new entry's `message` only against `buffer[buffer.length - 1]`. If they match and `Math.abs(timeDiff) < 100ms` (parsed from the ISO `timestamp`), the new entry is dropped. This is intentionally narrow — it collapses the `ErrorUtils` + `console.error` double-report of the same rejection, but does not dedup distant duplicates with unrelated entries in between.

## Stack parsing

`parseStack` ([errors.ts:31-57](errors.ts)) runs two regex passes against the raw `stack` string in order; the first format that yields any frames wins:

- **V8** — `/^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/gm` matches `    at method (file:line:col)` and the anonymous variant `    at file:line:col`.
- **Hermes / JSC** — `/^(.*?)@(.+?):(\d+):(\d+)$/gm` matches `method@file:line:col`.

Each frame becomes `{ column, file, lineNumber, methodName? }` — `methodName` is trimmed and dropped when empty (anonymous frames). Parsing is intentionally lightweight; the bundled paths and minified line numbers it produces are meant to feed straight into `metro__symbolicate`, which resolves them against Metro's sourcemaps on demand. The raw `stack` string is kept alongside `stackFrames` for callers that want the original text.

## Tools

### `get_errors`

`get_errors({ source?, fatal?, since?, until?, path?, depth?, maxBytes? })` ([errors.ts:167-220](errors.ts)). Returns the (filtered) buffer projected with default depth 4 — entries + stackFrames expanded, long `stack` strings auto-collapse to `${str}` markers; drill via `path: '[-1:][0].stack'` for the raw text. Filters: `source` (`global` / `promise`), `fatal` (boolean), `since` / `until` (ISO timestamps, parsed via `Date.parse`; invalid values silently skip the filter). The tool description nudges agents toward `metro__symbolicate` for any `stackFrames` they want to resolve.

### `get_stats`

`get_stats()` ([errors.ts:221-239](errors.ts)) — returns `{ total, fatal, bySource: { global, promise } }`. Cheap counter pass over the buffer, no projection.

### `clear_errors`

`clear_errors()` ([errors.ts:160-166](errors.ts)) — empties the buffer (`buffer.length = 0`); the monotonic `nextId` counter is **not** reset, so post-clear entries keep climbing.
