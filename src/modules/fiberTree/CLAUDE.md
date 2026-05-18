# fiberTree

Component-tree inspection and interaction surface — the flagship module of `react-native-mcp-kit`. Wraps the React fiber root in a chained query language for finding components, projecting their props / hooks, walking shallow subtrees, polling for appearance / disappearance, and invoking either prop callbacks or native-ref methods. 13 files, ~2900 lines.

The module exposes two MCP tools:

- **`query`** — chained-step search with per-field projection and optional waitFor polling.
- **`call`** — single-fiber dispatch to either a prop callback (`prop: 'onPress'`) or a native-ref method (`method: 'focus'`).

Factory entry point: `fiberTreeModule({ rootRef?, navigationRef?, redactHookNames?, additionalRedactHookNames? })`. `rootRef` is auto-supplied by `McpProvider` (the root `View` ref it captures internally); `navigationRef` enables `scope: "screen"`. See [fiberTree.ts](fiberTree.ts) for the public surface.

## File map

| File | Role |
| --- | --- |
| [index.ts](index.ts) | Barrel — exports `fiberTreeModule` plus low-level helpers (`findAllFibers`, `findHostFiber`, `getAncestors`, `getFiberRoot`, `matchesQuery`, `findScreenFiberByRouteKey`, …) for cross-module use (navigation reads them to enrich the current route). |
| [fiberTree.ts](fiberTree.ts) | Module factory: long-form tool descriptions, root-pointer cache wiring, both handler bodies, projection plumbing for `select.props` / `select.hooks` / `select.children`. |
| [query.ts](query.ts) | Chained-step runner. Defines `QueryScope` / `QueryStep` / `QueryRuntime`, `validateSteps`, `collectByScope`, `runQueryChain`, `dedupAncestors`, `resolveScreenFiber`. |
| [finder.ts](finder.ts) | Single-fiber lookup used by `call` and any other imperative tool. `FIND_SCHEMA` spread, `findComponent` (with `within: "Parent/Child:N"` path), `requireRoot` guard. |
| [utils/](utils/) | Fiber traversal primitives split per concern: [root.ts](utils/root.ts) (rootRef store + `getFiberRoot`), [naming.ts](utils/naming.ts) (`getComponentName`, `getComponentType`), [constants.ts](utils/constants.ts) (fiber tag constants), [traverse.ts](utils/traverse.ts) (`findFiber`, `findAllFibers`, `find*By*`, `getDirectChildren`, `getSiblings`, `getAncestors`, `findHostFiber`), [serialize.ts](utils/serialize.ts) (`serializeFiber` + tree skip logic + `getTextContent`), [match.ts](utils/match.ts) (`matchesQuery`, `findAllByQuery`, `matchPropValue`, `matchStringCriterion`), [screen.ts](utils/screen.ts) (`findScreenFiberByRouteKey` + RN-Navigation wrapper list), [native.ts](utils/native.ts) (`getNativeInstance`, `measureFiber`, `getAvailableMethods`), [projection.ts](utils/projection.ts) (`projectFiberValue` wrapper + fiber collapse rule), and [index.ts](utils/index.ts) (barrel). |
| [hooks.ts](hooks.ts) | Hook walker. `extractHooks` pairs `fiber.memoizedState` with `__mcp_hooks` metadata, with shape-check alignment, `countHookSlots` for unannotated library hooks, `flattenHookMeta` for custom-hook recursion, `flatHooksToTree` for the tree-format output, and `buildHooksOptions` to normalise raw user options. |
| [children.ts](children.ts) | `select.children` recursive light-only walker. `parseChildrenOptions` / `parseChildrenSelect` / `walkChildren`. Heavy fields (`props`/`hooks`) rejected at parse time. |
| [projection.ts](projection.ts) | `parseProjection` — normalises `select` array into `{ fields, props, hooks, children }`; orchestrates `buildHooksOptions` and `parseChildrenOptions`. |
| [redact.ts](redact.ts) | Hook-value redaction. `DEFAULT_REDACT_HOOK_NAMES`, `compileRedactPatterns`, `matchesAnyRedactPattern`. |
| [waitFor.ts](waitFor.ts) | `query.waitFor` polling loop — `runWaitForLoop` drives `runOnce` until predicate holds (with optional stability window) or timeout. |
| [viewport.ts](viewport.ts) | `onlyVisible` filter — `getVisibleRect` reads `Dimensions.get('window') × PixelRatio`; `intersectsRect` AABB check. |
| [constants.ts](constants.ts) | Numeric tunables — `QUERY_LIMIT_DEFAULT/MAX`, `WAIT_TIMEOUT_*` / `WAIT_INTERVAL_*`, `FIBER_DEFAULT_DEPTH`. No HOOK_KIND table — kinds are resolved by shape-matching in `hooks.ts`. |
| [types.ts](types.ts) | Shared types — `Fiber` (deliberately `any`), `ComponentType`, `Bounds`, `SerializedComponent`, `ComponentQuery`, `PropMatcher`. |

## query — chained search

### Steps and scopes

`query({ steps: [...] })` accepts an ordered array of `QueryStep` objects. Each step contributes a `scope` (which fibers to consider relative to the previous step's matches) plus criteria from `ComponentQuery` (`name` / `mcpId` / `testID` / `text` / `hasProps` / `props` / `any` / `not`). [query.ts](query.ts) drives the chain via `runQueryChain`:

1. Start with `current = [runtime.root]`.
2. For each step: collect candidates from every fiber in `current` via `collectByScope`, dedup with a `Set<Fiber>` to preserve DFS order, apply `matchesQuery`, optionally pick `step.index`.
3. If a step ends with no matches, short-circuit and return `[]`.

Valid scopes are validated up-front in `validateSteps` so a typo surfaces as a structured error instead of silently degrading to the default `descendants`:

- `descendants` (default) — every fiber below the previous match, excluding the match itself.
- `children` — direct children only (one level).
- `parent` — `fiber.return`.
- `ancestors` — walked upward via `fiber.return`, nearest first.
- `siblings` — same-parent children, excluding the fiber itself.
- `self` — the fiber itself.
- `root` — the React fiber root, regardless of the previous step. Use as the first step to start from the top (e.g. dump the whole tree via `[{ scope: 'root' }] + select: [{ children: 5 }]`).
- `screen` — descendants of the currently focused React Navigation screen fiber. Available only when `navigationRef` was passed in. Reads `navigationRef.getCurrentRoute().key` and walks the fiber root via `findScreenFiberByRouteKey`, which skips RN-internal wrappers (`SceneView`, `StaticContainer`, `Screen`, `ForwardRef`, `Memo`, `Anonymous`) to land on the user's component.
- `nearest_host` — `findHostFiber` walks down to the first mounted `HOST_COMPONENT` fiber. Useful before `call({ method })` (focus/blur/measure/scrollTo) since those need a host instance.

### Step criteria

`matchesQuery` in [utils/match.ts](utils/match.ts) is the central predicate. All string criteria — `name`, `mcpId`, `testID`, `text` — go through `matchStringCriterion`, which accepts either:

- a bare string (strict equality for `name`/`mcpId`/`testID`; substring for `text`), or
- a `/pattern/flags` slash form (`name: "/^Pressable/"` matches `Pressable`, `PressableView`, …).

Malformed regex falls back to the literal comparison so users always get a result. The same syntax is reused for `select.hooks.names` and `select.hooks.mcpIds` via `parseNamePattern` — one consistent regex convention across the tool.

Other criteria fields:

- **`hasProps: string[]`** — every name must exist as an own-key on `memoizedProps`.
- **`props: Record<string, PropMatcher>`** — per-prop match. A primitive value means strict equality; `{ contains: "X" }` / `{ regex: "Y" }` matches via `String(value)`. By default non-primitive values don't match; add `deep: true` to JSON-serialize the value first (circular-safe, functions/symbols replaced, capped at 10KB via `MATCH_STRING_CAP`) so nested values become searchable.
- **`any: ComponentQuery[]`** — OR semantics; recurses through `matchesQuery`.
- **`not: ComponentQuery | ComponentQuery[]`** — negation. Array form excludes any fiber matching any pattern (equivalent to `not: { any: [...] }`). Composes with the other AND-ed criteria.
- **`index: number`** — pick the N-th match; otherwise every match fans out into the next step.

`matchesQuery` is wrapped in `try/catch` so a thrown matcher (rare — usually a bad regex) returns `false` instead of breaking the traversal.

### Dedup

After step evaluation, `dedupAncestors` in [query.ts](query.ts) optionally collapses wrapper cascades. A fiber is dropped when any ancestor (`fiber.return` chain) is also in the match set. PressableView → Pressable → View → RCTView collapses to the topmost `PressableView`. Independent siblings with overlapping bounds (e.g. absolute overlays) are kept. Pass `dedup: false` to see every layer.

### Cache (root-pointer keyed)

`runCachedQuery` in [fiberTree.ts](fiberTree.ts) memoises match sets per (`runtime.root`, `JSON.stringify(steps)`). On every call:

1. If `cache: false` or `waitFor` is active, bypass entirely (`runQueryChain` direct).
2. If `cacheRoot !== runtime.root`, the React tree has committed — clear the entire cache map.
3. Hit → return the stored `Fiber[]`. Miss → run the chain, store, return.

The cache key is the fiber root pointer because React swaps the HostRoot fiber on every commit, so a mismatched pointer is proof the tree has changed. The cache holds raw `Fiber[]` — projection (props / hooks / bounds / children) always runs fresh after the cache lookup, so per-call options like `select.props.path` never get baked in.

### Projection

`parseProjection` in [projection.ts](projection.ts) walks the agent's `select` array and produces a `Projection { fields, props, hooks, children }`. The `select` array is heterogeneous:

- bare string (`"mcpId"`) → include the field with defaults
- `{ field: true }` → same
- `{ field: false }` → ignore
- `{ field: options }` → include with per-field options

Default fields are `['mcpId', 'name', 'testID']` (see `QUERY_DEFAULT_FIELDS`); everything else is opt-in. The handler iterates `picked` matches in [fiberTree.ts](fiberTree.ts) and resolves each field independently:

- **Light fields** (`mcpId`, `name`, `testID`, `bounds`, `refMethods`) — direct read from `memoizedProps` or one helper call. No projection involved; values appear raw in the response.
- **`bounds`** — `measureFiber` via `UIManager.measure` returns physical-pixel `{ x, y, width, height, centerX, centerY }` (top-left origin, page coords — same as `adb shell input tap`). `null` when the fiber has no mounted host view. Computed inside a per-call `boundsCache: Map<Fiber, Bounds | null>` so `bounds`, `onlyVisible`, and `select.children.bounds` share one measure pass per fiber.
- **`refMethods`** — `getAvailableMethods` on the native instance returned by `getNativeInstance`. Walks the prototype chain collecting non-constructor function names. `null` when there's no native instance (composite wrappers, unmounted, virtualised). Pair with `call({ method })`.
- **`props`** — per-field projection via `projectFiberValue` (the shared `projectValue` pre-loaded with the fiber-aware `fiberCollapseRule` and `SKIP_KEYS_FIBER`). Each call respects its own `path` / `depth` (default 1) / `maxBytes`. The fiber collapse rule turns React elements / fiber nodes / native instances into compact `{"${ReactElement}": true}` or `{"${ref}":{ mcpId, name, … }}` markers so a prop holding a ref to another component is followable. `SKIP_KEYS_FIBER` drops `children` / `ref` / any `__`-prefixed key.
- **`hooks`** — see "Hook inspection" below. Filtered + projected per-field via `select.hooks.{path,depth,maxBytes}`.
- **`children`** — recursive light-only walker, see "Children walker" below.

**The query response shell is never projected at the top level**: `{ matches, total, truncated? }` is light by construction, heavy values inside individual matches are already collapsed by the per-field projection (`select.props` / `select.hooks`) or self-bounded (`select.children` via `treeDepth` / `itemsCap`). There is no top-level `path` / `depth` / `maxBytes` on `query` — that's intentional, since drill should happen via the field-specific options. (The `call` tool, by contrast, has a normal top-level projection because its response is freer-form.)

### onlyVisible

`onlyVisible: true` filters the match list down to fibers whose measured bounds intersect the window rect. `getVisibleRect` in [viewport.ts](viewport.ts) reads `Dimensions.get('window') × PixelRatio.get()` (defensively wrapped — RN throws on cold-start). `intersectsRect` is a plain AABB check. Fibers with `null` bounds (no host view, virtualised, unmounted) are dropped. Halves results on long lists. The measure pass shares `boundsCache` with the per-match projection.

### Response

`{ matches: Match[], total: number, truncated?: true }`. `total` is the unrestricted count; when it exceeds `limit` (default 50, max 500 via `QUERY_LIMIT_DEFAULT` / `QUERY_LIMIT_MAX`), `truncated: true` is added and `matches` contains the first `limit` items in DFS order. Narrow the query rather than cranking limit.

### waitFor (appear / disappear poller)

`waitFor: { until: 'appear' | 'disappear', timeout?, interval?, stable? }` wraps the same query in a polling loop ([waitFor.ts](waitFor.ts)). Predicate: `appear` = `total >= 1`, `disappear` = `total === 0`. `stable` requires the predicate to hold continuously for N ms before returning — useful to ignore transient matches during screen transitions. Cache is always bypassed inside the loop (calling `runOnce(false)`); a cached-true result would loop forever returning the stale match set captured pre-mount. Response on success: `{ matches, total, waited: true, until, attempts, elapsedMs, timedOut: false, stableFor? }`. On timeout: `timedOut: true` plus the last observed matches. Defaults: timeout 10s (max 60s), interval 300ms (min 100ms), stable 0.

## Hook inspection (`select.hooks`)

`extractHooks` in [hooks.ts](hooks.ts) walks a fiber's `memoizedState` chain (a linked list of slots that React allocates one per hook call) and pairs each slot with the next entry of `__mcp_hooks` — metadata the [babel test-id plugin](../../babel/testIdPlugin.ts) emits on every annotated component / custom hook function.

### Metadata lookup across HOC chains

React's wrapper machinery makes "where does metadata live" depend on the exact HOC chain. `extractHooks` tries the most likely homes in order:

1. `fiber.type.__mcp_hooks` — bare components, FunctionDeclarations, and the outer memo fiber when the chain is just `memo(fn)`.
2. `fiber.elementType.__mcp_hooks` — `memo(fn)` without compare. React converts the fiber to `SimpleMemoComponent` and rewrites `fiber.type` to the inner function; our metadata sits on the outer memo wrapper, which survives only on `elementType`.
3. `fiber.type.render.__mcp_hooks` — forwardRef wrapper. `memo(forwardRef(fn))` lays out as three fibers; queries by displayName tend to match the middle ForwardRef fiber, whose `fiber.type` is the forwardRef object and `fiber.type.render` is the inner fn the babel plugin annotated.
4. `fiber.type.type.__mcp_hooks` — memo wrapping a non-function inner (or any wrapper-around-wrapper). Catches getter installations on the outer wrapper too.

If none of those pan out, `extractHooks` returns `null` (no metadata = hooks field absent on the match).

### Slot / metadata alignment

Each metadata entry is `{ kind, name, hook?, mcpId?, fn? }`. `kind` covers all 18 React 16/18/19 stable hooks: `State`, `Effect`, `Memo`, `Callback`, `Ref`, `Context`, `Reducer`, `ImperativeHandle`, `LayoutEffect`, `InsertionEffect`, `DebugValue`, `Transition`, `DeferredValue`, `Id`, `SyncExternalStore`, `Optimistic`, `ActionState`, `Use`, plus `Custom` for user-defined hooks. `mcpId` is the call-site identity in the same shape as JSX `data-mcp-id` (`<name>:<shortFile>:<line>`) — drop it into `Read()` to jump to source. `hook` is the source-level hook function name (`useState`, `useAnimatedStyle`, `use`) — surfaced alongside `name` so `count (useState)` reads differently from `count (useReducer)`.

The walker advances both the fiber chain and the metadata index in lockstep, but with a critical safety net: `shapeMatchesKind` rejects slots whose `memoizedState` doesn't match the expected shape for that kind. When mismatched, the fiber slot is skipped without consuming a metadata entry — so a custom hook that internally uses more slots than `countHookSlots` estimated doesn't drift all trailing entries.

Shape checks per kind:

- `Ref` — `{ current }` object.
- `Memo` / `Callback` — `[value, deps]` where `deps` is `null` or array.
- `Effect` / `LayoutEffect` / `InsertionEffect` — `looksLikeEffectRecord`: `{ tag: number, create: function, deps: null | array, … }`.
- `Transition` — `[a, b]` (boolean-and-callback pair).
- `State` / `Reducer` / `Context` / `Optimistic` / `ActionState` / `Use` / `Custom` — permissive but rejects obvious effect-records and `{ current }`-only ref shapes so they don't swallow internals of preceding custom hooks. React 19 hooks fall into this bucket because their slot shape is state-like.

### Custom-hook recursion

`flattenHookMeta` recursively inlines custom-hook sub-metadata. A `Custom` entry whose `fn` carries its own `__mcp_hooks` array emits TWO records: a parent (marked `expanded: true`, no slot consumption) followed by every flattened child with the parent name appended to its `via` chain. Without this, the agent would see the inner state slots but never the `wrapperAnimStyle = useAnimatedStyle(...)` call-site that owns them. Cycle-safe via a `WeakSet`. `expansionDepth` caps recursion — `0` = top-level only, default `Infinity`. Once `via.length` reaches the cap, the current entry is emitted as a leaf and the slot-walker still consumes one slot for it, keeping output consistent.

### Slot-count estimation for unannotated hooks (`countHookSlots`)

Custom-leaf entries with no `__mcp_hooks` on `fn` (typically library hooks compiled before the babel plugin saw them) get their slot count estimated so the walker advances by the right amount. Three cascading strategies, cached per `fn` in a WeakMap:

1. Annotated metadata recursion — sum slots across `fn.__mcp_hooks` entries, recursing into nested `Custom` entries.
2. `fn.toString()` regex over `\b(?<!\.)use(?:[A-Z]\w*)?\s*\(` — counts hook-call occurrences. Strips strings (`/(['"`])(?:\\.|(?!\1).)*\1/g`), block comments, and line comments first. The negative lookbehind on bare `use(` filters out `.use(` method calls (so `database.use(middleware)` / `app.use(router)` don't inflate). Works on already-bundled libraries because Metro doesn't mangle property names (`(0, _react.useState)(...)` still matches).
3. Default `1` — native functions, bound functions, or sources that can't be parsed.

The walker calls `countHookSlots` only on `Custom` leaves whose `fn` is a function; if `slots > 1` it emits the parent entry (with the first slot's raw value as its visible value) and advances the fiber chain by that many slots in one step, dropping the rest as internals.

### Output shape

Each emitted entry is `{ kind, name, hook?, mcpId?, via?, expanded?, value? }`. `via` lists ancestor custom-hook names (only present when non-empty). `expanded: true` marks synthesised parent records.

- `format: "flat"` (default) — flat array with `via:` ancestor chains visible.
- `format: "tree"` — `flatHooksToTree` post-processes into nested `children:` shape using a single-pass parent stack indexed by `via.length`. `expanded` is stripped on tree output.

### Filtering

`select.hooks` accepts `kinds?: string[]`, `names?: string[]`, `mcpIds?: string[]`. `kinds` is set membership; `names` and `mcpIds` go through `parseNamePattern` (exact OR `/regex/flags`, same syntax as step criteria). All three filters AND together. `mcpIds` is the most precise — every emitted entry carries its call-site identity, so targeting one specific call by `mcpIds: ["count:useCounter:42"]` skips name collisions entirely.

### withValues

`withValues: true` adds a resolved value to each entry. `serializeHookValue` extracts a kind-appropriate slice of `memoizedState` (Ref → `.current`, Memo/Callback → first element of `[value, deps]` plus a separate `deps` field, Effect → `deps` only) and returns it RAW. The handler then projects with `select.hooks.{path,depth,maxBytes}` via `projectFiberValue` — default `depth=1` so each value stays compact. Values that look like component refs (via `_internalFiberInstanceHandleDEV` / `_reactInternals` / `_nativeTag`) collapse to `{"${ref}":{ mcpId, testID, componentName? }}` for follow-up via `query`. The final JSON.stringify check bails out (`'[Unserialisable value]'`) on residual cycles / Proxies that escaped the WeakSet — better than killing the whole response on one stray value.

### Redaction

[redact.ts](redact.ts) compiles the user's redact list once at module init. Default patterns: `[/password/i, /token/i, /jwt/i, /secret/i, /Pin$/, /credential/i, /apiKey/i, /authorization/i]`. `Pin$` is anchored so it doesn't catch `Spinner`; broad terms like `auth` are deliberately omitted (would catch `isAuthenticated`). Redaction is applied to every hook entry's `name` AND every entry in its `via` chain, so a leaf `value` inside a `useCredentials()` expansion stays masked. Masked entries get `value: "[redacted]"` — `kind` / `name` / `hook` / `mcpId` stay visible.

Module options: `redactHookNames` replaces defaults entirely (`[]` disables redaction); `additionalRedactHookNames` extends defaults. Both accept `Array<string | RegExp>` — strings are case-insensitive substrings (so `"password"` catches `passwordHash`); RegExps verbatim.

### Trailing metadata

After the fiber chain runs dry, any leftover metadata entries are emitted without a `value` field. Caused most often by a preceding `Custom` hook consuming more slots than `countHookSlots` estimated. Surfacing them (rather than silently dropping) helps the agent see "this hook exists but didn't align" and debug accordingly.

## Children walker (`select.children`)

[children.ts](children.ts) implements a recursive light-only walker for "map of the tree" navigation. Two input forms accepted by `parseChildrenOptions`:

- Short: `{ children: 5 }` → `treeDepth = 5`, default fields `['mcpId', 'name']`.
- Object: `{ children: { treeDepth?, select?, itemsCap? } }` → fully configurable.

`treeDepth` capped at `CHILDREN_MAX_TREE_DEPTH = 16` and clamped via `clampTreeDepth`. `itemsCap` defaults to 50; per-level overflow inserts a `{"${truncated}": { slice: [0, cap], total }}` sentinel as the first array item.

`parseChildrenSelect` enforces light-only: `props` / `hooks` throw at parse time with a redirect message ("run a second query against the child's mcpId"). Allowed fields per level: `mcpId` / `name` / `testID` / `bounds` / nested `children`. Each level's nested children defaults to the parent's `options` so `{ children: 5 }` recurses light-fields all the way down.

`walkChildren` is async because `bounds` reads native layout. Per-fiber bounds reuse the same per-call `boundsCache` as the top-level match projection. At the last level, instead of dropping the `children` field altogether, the walker emits `children: { "${arr}": N }` carrying the count of un-walked sub-children — so the agent sees "there's more below; drill if needed". True leaves (no children at all) omit the field entirely.

## call — imperative dispatch

`call` in [fiberTree.ts](fiberTree.ts) resolves a single fiber via `findComponent` ([finder.ts](finder.ts)) then dispatches one of two paths:

- **`prop: 'onPress'`** — reads `fiber.memoizedProps[prop]`, checks it's a function, calls it with `args: unknown[]`. On miss, returns `{ error, availableProps: string[] }` listing every function-valued prop.
- **`method: 'focus'`** — reads `getNativeInstance(fiber)` (Fabric `stateNode.canonical.publicInstance` first, falling back to old-arch `stateNode`, then a `fiber.ref.current` last resort), binds the method, calls it with `args`. On miss returns `{ error, availableMethods: string[] }` (the same `getAvailableMethods` walk used by `select.refMethods`). Method throws are caught and surfaced as `{ error: "Method ... threw: ..." }`.

Exactly one of `prop` / `method` is required — both or neither returns a structured error. The result goes through the standard top-level projection (`path` / `depth` / `maxBytes`, default depth from `FIBER_DEFAULT_DEPTH = 4`). For simulating user taps, prefer `host__tap_fiber` — it goes through the real OS gesture pipeline so Pressable feedback / gesture responders / hit-test behave as under a real finger. `call` is for non-gesture callbacks, off-screen / virtualised components, or imperative ref methods.

### finder + within

`findComponent` accepts the standard finder args (`mcpId` / `testID` / `name` / `text` + optional `within` + `index`). The `within: "Parent/Child:1/GrandChild"` syntax narrows the search root per segment: each segment tries `mcpId` → `testID` → `name` in order, optional `:N` picks the N-th match. `requireRoot` is the standard guard — returns `{ error: "Fiber root not available..." }` when the rootRef wasn't wired up or the app hasn't rendered yet.

## Cross-module reads

[index.ts](index.ts) exports a handful of low-level helpers so other modules can walk the same fiber root without duplicating the traversal logic. Notably, the navigation module (`src/modules/navigation/`) uses `findScreenFiberByRouteKey` + `getComponentName` to enrich `get_current_route` responses with the screen component's name / mcpId / source file. Keep these exports stable — they're the canonical entry points for fiber traversal across the codebase.

## Coordinate invariants

`measureFiber` in [utils/native.ts](utils/native.ts) uses `UIManager.measure(node, cb)` which yields `pageX`/`pageY` — coordinates relative to the React root view, mapped to `View.getLocationOnScreen` on Android. This is what `adb shell input tap` expects (and `xcrun simctl io … tap` on iOS); unlike `measureInWindow` whose origin shifts depending on translucent status-bar / SafeArea insets. Output is multiplied by `PixelRatio.get()` so `bounds` is in physical pixels — feed `bounds.centerX` / `bounds.centerY` straight into `host__tap`.

## projectFiberValue — fiber-aware projection wrapper

[utils/projection.ts](utils/projection.ts) exports `projectFiberValue`, a wrapper around the shared `projectValue` from `@/shared/projection/projectValue` that pre-applies fiber-specific behaviour:

- **`fiberCollapseRule`** — recognises React internals and collapses them to compact markers. Anything with a `$$typeof` symbol becomes `{"${ReactElement}": true}`. Anything with `stateNode` / `memoizedProps` / `__nativeTag` (i.e. a Fiber or a native instance) collapses to `{"${ref}":{ mcpId?, testID?, name?, nativeTag?, viewClass? }}` — pulling the fiber out via `_reactInternals` / `_reactInternalFiber` / `_internalFiberInstanceHandleDEV` / `_internalInstanceHandle` as needed. Stops `projectValue` from descending into the unbounded React internals graph and gives the agent something to follow up on.
- **`SKIP_KEYS_FIBER`** — drops `children`, `ref`, `collapsableChildren`, `__internalInstanceHandle`, `__nativeTag`, and any `__`-prefixed key (catches `__reactProps$...` and react-refresh markers).

Every place fiber-derived data gets serialised — `select.props`, `select.hooks` values, the `applyProjection` wrapper used by `call` — goes through `projectFiberValue` rather than the raw shared `projectValue`. The handler-level `serializeFiber` path (legacy DFS dump) intentionally passes props through *unprojected*, because the single canonical projection runs once at the handler exit on the assembled response.

## Finder edge cases

`findInRoot` in [finder.ts](finder.ts) tries the lookup order **mcpId → testID → name** for each `within` segment. First non-empty match-set wins, so `within: "LoginForm"` resolves whether `LoginForm` is an mcpId, a testID, or a component name — agents don't need to remember which kind it was.

A few non-obvious details:

- `findComponent` does **not** combine criteria across `mcpId` / `testID` / `name` / `text` — the first defined one wins (`mcpId` > `testID` > `name` > `text`). The other criteria are ignored on the same call. For combined matching, use `query` with a `steps` array.
- `index` defaults to `0`; out-of-range returns `null` (treated as "not found" by the caller).
- `requireRoot` is exposed so other modules (or future tools) can produce the same `{ error: "Fiber root not available..." }` shape on the same precondition.

## Step validation and error surfacing

Step shapes are kept loose at the type level (any `ComponentQuery` field is optional) but `validateSteps` in [query.ts](query.ts) eagerly rejects unknown `scope` strings up-front with the full valid set in the error message. This is the only step-level validation — criteria fields are tolerated permissively because their predicates are individually no-ops on missing input. A step like `{ scope: 'invalidScope', name: 'X' }` returns `{ error: 'steps[0].scope: unknown scope "invalidScope". Valid: ...' }` from the handler instead of silently degrading to `descendants`.

## Module factory wiring

`fiberTreeModule({ rootRef?, navigationRef?, redactHookNames?, additionalRedactHookNames? })` in [fiberTree.ts](fiberTree.ts) does the one-time setup:

1. `setRootRef(rootRef)` — stashes the ref globally in [utils/root.ts](utils/root.ts) so `getFiberRoot()` is callable from anywhere (e.g. cross-module helpers in `index.ts`). `McpProvider` passes its internally-captured root `View` ref here.
2. Compile redact patterns once via `compileRedactPatterns` — precedence: `redactHookNames` (replace) > `[...defaults, ...additionalRedactHookNames]` (extend) > defaults.
3. Initialise the per-module cache (`cacheRoot`, `cacheEntries: Map<string, Fiber[]>`).
4. Return the `McpModule` object with the two tools.

There's no mutable state survived across module instantiations — each `fiberTreeModule()` call returns a fresh closure with its own cache. The global rootRef is the one exception (it's shared state because cross-module reads in `index.ts` need it).

## Notable type aliases

[types.ts](types.ts) keeps `Fiber` as `any`. This is deliberate: every field we poke (`memoizedProps`, `memoizedState`, `type`, `return`, `sibling`, `child`, `stateNode`, `elementType`, `tag`) drifts between React versions and the fiber shape is internal API. Centralising the alias keeps `// eslint-disable @typescript-eslint/no-explicit-any` to one declaration instead of scattering it across every file.

`PropMatcher` is a union: primitives (`boolean | number | string`) for strict equality, or `{ contains: string; deep?: boolean }` / `{ regex: string; deep?: boolean }` for string-form matching. `deep: true` is the opt-in for matching against JSON-serialised objects/arrays — without it, non-primitive props are filtered out before the matcher even runs, so a naive `{ placeholder: { contains: "Search" } }` never accidentally matches a `data-mcp-id="...Search..."`-bearing nested view.
