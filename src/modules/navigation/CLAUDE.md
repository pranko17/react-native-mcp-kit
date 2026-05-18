# `navigation/` — React Navigation control + history

[`navigation.ts`](navigation.ts) — `navigationModule(ref: NavigationRef)`, registered as `navigation` (requires the `navigationRef` prop on `<McpProvider>`, or direct registration). Wraps a React Navigation `NavigationContainerRef`, maintains a 100-entry transition history, and decorates the focused route with a `screen` field that ties the React Navigation route back to the React fiber tree.

`NavigationRef` ([`types.ts`](types.ts)) is the loosely-typed structural subset of `NavigationContainerRef` the module touches (`addListener`, `canGoBack`, `dispatch`, `getCurrentRoute`, `getRootState`, `goBack`, `navigate`, `resetRoot`, optional `isReady`). Generics are widened with `any` so the caller doesn't need an `as never` cast. `resetRoot` is declared on the ref but unused — `reset` dispatches `RESET` instead.

Shared projection / module conventions live in [`../CLAUDE.md`](../CLAUDE.md); this doc only covers navigation-specific behaviour.

## Read tools

All three reads accept the standard `path` / `depth` / `maxBytes` projection knobs ([`navigation.ts:28-30`](navigation.ts)). Per-tool default depths are chosen so one call surfaces the useful shape:

### `get_current_route({ withState? })`

Default. Returns `navigation.getCurrentRoute()` (the leaf-most focused route across nested navigators) decorated via `withScreenInfo` ([`navigation.ts:159-168`](navigation.ts)). Shape: `{ key, name, params?, screen? }`. Default depth 3.

With `withState: true`, calls `getRootState()` and runs `findFocusedRoute` ([`navigation.ts:32-42`](navigation.ts)), which recurses through every nested navigator and stitches in a `focusedChild` chain (unbounded depth — one level per nested navigator). The outermost route gets `screen` enrichment; inner `focusedChild` entries do not. Returns `{ error: 'No navigation state available' }` when `getRootState()` is falsy.

### `get_state`

Raw `navigation.getRootState()`. Default depth 2 — top-level expanded, route children collapse. Use a `path` to drill (e.g. `routes[0].state`).

### `get_history`

Returns `{ entries, total }` where `entries` is the full history array (oldest first). Default depth 4 — `entries` expanded, each entry expanded, but the nested `state` snapshot inside each entry collapses to a marker. History entry shape (per [`types.ts`](types.ts)): `{ route: { key, name, params? }, timestamp, state? }`.

## Action tools

Actions merge by semantic verb instead of mirroring React Navigation's full dispatch vocabulary. Every action that mutates the stack returns `{ success: true, currentRoute }` (with screen enrichment); errors return `{ error: '...' }`.

### `navigate({ screen, params?, mode? })`

Three modes ([`navigation.ts:271-306`](navigation.ts)):

- `'reuse'` (default) — `navigation.navigate(screen, params)`. Jumps back to an existing screen instance if present.
- `'push'` — `dispatch({ type: 'PUSH', payload: { name, params } })`. Always adds a new entry.
- `'replace'` — `dispatch({ type: 'REPLACE', payload: { name, params } })`. Swaps the current screen.

Unknown mode → `{ error: 'navigate.mode must be "reuse" / "push" / "replace", got <mode>.' }`. Returns `{ success: true, mode, currentRoute }`.

### `pop({ to?, params? })`

Single tool collapsing `POP` / `POP_TO` / `POP_TO_TOP` ([`navigation.ts:307-344`](navigation.ts)):

- `to` omitted / `null` → `dispatch({ type: 'POP', payload: { count: 1 } })`.
- `to: <number>` → `dispatch({ type: 'POP', payload: { count: to } })`.
- `to: 'top'` → `dispatch({ type: 'POP_TO_TOP' })` (no payload).
- `to: '<ScreenName>'` → `dispatch({ type: 'POP_TO', payload: { name: to, params: args.params } })`.

Anything else (e.g. boolean) → `{ error: 'pop.to must be a number, a screen name, or "top". got <typeof>.' }`. Note `params` is only honoured for the `POP_TO` form.

### `reset({ routes, index? })`

`dispatch({ type: 'RESET', payload: { index, routes } })`. `routes` is mapped to `[{ name, params }]` so extra fields are stripped. `index` defaults to `routes.length - 1` ([`navigation.ts:349`](navigation.ts)) — the last route is focused. JSON Schema enforces `minItems: 1` on `routes`.

### `go_back`

Guarded `navigation.goBack()`. Returns `{ success: true }` when `canGoBack()` is true, otherwise `{ success: false, reason: 'Cannot go back' }`.

## Screen enrichment

Routes returned by `get_current_route` (both modes) and by every action's `currentRoute` field carry a `screen` field:

```
screen: { componentName, mcpId?, filePath?, line? }
```

`getScreenInfoForRouteKey` ([`navigation.ts:98-112`](navigation.ts)) does the work:

1. `getFiberRoot()` (from `fiberTree`) → the current React fiber root.
2. `findScreenFiberByRouteKey(root, route.key)` → the fiber whose memoized props carry the matching `route.key`. React Navigation passes `route` as a prop to every screen component (both the `component={...}` API and the hook API), so matching on `route.key` reliably lands on the rendering screen.
3. `componentName` = `getComponentName(fiber)` from `fiberTree` — RN-internal wrappers (`SceneView`, `StaticContainer`, `Screen`, `ForwardRef`, `Memo`) are skipped so the developer's component name surfaces; see [`../fiberTree/CLAUDE.md`](../fiberTree/CLAUDE.md) for the wrapper list and exact algorithm.
4. `mcpId` = the first `data-mcp-id` descendant via depth-first `child → sibling` walk ([`firstMcpIdDescendant`, navigation.ts:74-85](navigation.ts)) — i.e. the first instrumented JSX element rendered by the screen.
5. `parseMcpId` ([`navigation.ts:87-96`](navigation.ts)) splits the `<name>:<file>:<line>` shape: requires the last segment to be all digits, rejoins everything between index 1 and the last on `:` so file paths containing colons survive. Returns `{}` on shape mismatch.

`mcpId`, `filePath`, and `line` are omitted when missing rather than set to `undefined` — agents can chain them straight into `fiber_tree__query({ steps: [{ scope: 'descendants', criteria: { mcpId } }] })` or `metro__open_in_editor({ file, lineNumber })`.

## History capture

Inside the factory ([`navigation.ts:116-154`](navigation.ts)):

- `history: NavigationHistoryEntry[]` — bounded ring; once `> MAX_HISTORY` (100), the oldest is `shift()`'d.
- `recordEntry(rootState)` walks via `getCurrentRouteFromState` (recursive into nested navigators until a leaf route) and pushes `{ route: { key, name, params }, state: rootState, timestamp: new Date().toISOString() }`. Deduplicates against the previous entry on `route.key` — only key transitions are recorded, so params-only updates inside the same screen don't bloat history.
- `setup()` records the current root state once (so `get_history` is non-empty before the first navigation), then installs `addListener('state', ...)` which re-reads `getRootState()` on every navigator change.
- `waitForReady` polls `navigation.isReady?.() ?? true` every **100ms** via `setTimeout` until ready, then calls `setup`. The poll is unbounded — there's no max attempts. `isReady` is optional on `NavigationRef`; absent → treated as ready immediately.

## Behavior notes

- Line 115 has a stray `console.log('Navigation module initialized')` that fires every time `navigationModule` is invoked. It leaks into user apps (and into `console__get_logs`). Flagged for cleanup.
- Screen enrichment runs synchronously on every call to `get_current_route` / action — there's no cache. With many screens this is a fiber walk per call; on noisy polling it could be measurable.
- The `state` snapshot stored on each history entry is **the live root state object** — not a deep clone. If React Navigation mutates the state in place between captures, older entries see the mutated shape. Treat history `state` as advisory rather than a true historical record.
- `recordEntry` reads `getCurrentRouteFromState` (uses the leaf focused route), while `findFocusedRoute` in `get_current_route({ withState: true })` returns the outer route with `focusedChild` chain — two different shapes for similar walks.
- All five action tools use lowercase wire names (`navigate`, `pop`, `reset`, `go_back`); React Navigation's action types are uppercase (`PUSH` / `REPLACE` / `POP` / `POP_TO` / `POP_TO_TOP` / `RESET`).
