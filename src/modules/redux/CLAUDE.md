# `redux/` — Redux store inspection + dispatch

[`redux.ts`](redux.ts) — `reduxModule(store: StoreLike)`, registered as `redux` (factory base name matches — no divergence). Agents call `call(tool: "redux__get_state")` / `call(tool: "redux__dispatch")`. Registered by `<McpProvider>` when the `store` prop is supplied. See [`src/modules/CLAUDE.md`](../CLAUDE.md) for the module interface, projection knobs, and registration conventions.

## Adapter shape

[`types.ts`](types.ts) declares the structural `StoreLike` — any object satisfying the bare Redux `Store` surface this module touches:

```ts
{
  dispatch: (action: { type: string; [key: string]: unknown }) => unknown;
  getState: () => unknown;
}
```

A Redux Toolkit / vanilla Redux store drops in directly. `subscribe` / `replaceReducer` are part of the real `Store` but unused here, so a hand-rolled mock only needs `getState` + `dispatch`. The return value of `store.dispatch` is ignored.

## Tools

### `get_state`

`{ ...projection }` → the full state tree, keyed by slice, run through the standard projection. Default depth 2 — the top-level slice object is expanded and each slice is walked one level (slice names + their immediate fields visible, nested containers collapse to `${obj}`/`${arr}` markers). Drill into one slice via `path: 'auth.user.email'`, or pass `depth: 1` to get just the slice names with their value markers (a cheap "what slices exist" overview). No redaction is applied — the raw state (including any tokens it holds) projects as-is, matching `query` / `storage`.

### `dispatch`

`{ action }` where `action` is a **JSON object string** (mirroring `query`'s key-as-JSON-string convention) — `parseAction` ([`redux.ts`](redux.ts)) runs `JSON.parse` and requires the result to be a plain object with a string `type`. Anything else (non-string arg, malformed JSON, array, missing/`non-string` `type`) returns `{ error: '…' }` with the expected shape spelled out — no throw, surfaces in the tool response. On success it dispatches and returns `{ action, success: true }` echoing the parsed action. Arbitrary action shapes are supported (top-level FSA fields, nested `payload`, `meta`, …) since the whole object is passed through verbatim.

| arg      | shape                                                                         |
| -------- | ----------------------------------------------------------------------------- |
| `action` | JSON object string, must include a string `type` — e.g. `'{"type":"cart/clear"}'` |
