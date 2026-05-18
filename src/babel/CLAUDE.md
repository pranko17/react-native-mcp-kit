# CLAUDE.md — `src/babel/`

Two Babel plugins shipped under the sub-entries `react-native-mcp-kit/babel/test-id-plugin` and `react-native-mcp-kit/babel/strip-plugin`. Re-exported as `{ testIdPlugin, stripPlugin }` from `react-native-mcp-kit/babel` via [index.ts](index.ts).

Both plugins are `.ts` only (no JSX). They use `@babel/core` types and `state.filename` for path-based identifiers; nothing in here imports `react-native` or anything from the rest of the package except [stripPlugin.ts](stripPlugin.ts) reading `PACKAGE_NAME` from `@/shared/protocol`.

## `testIdPlugin` (dev only)

Lives in [testIdPlugin.ts](testIdPlugin.ts). One Babel pass performing two transforms that both feed the runtime `fiber_tree` module.

### Part 1 — `data-mcp-id` on JSX (`JSXOpeningElement` visitor, l. 570)

Stamps `data-mcp-id="ComponentName:shortFile:line"` onto every capitalized JSX element. `JSXMemberExpression` names render as `Object.Property` (e.g. `Animated.View`).

Options (`PluginOptions`, l. 30):
- `attr` — attribute name, default `"data-mcp-id"`.
- `separator` — default `":"`.
- `include` — explicit allowlist; when set, only listed names are stamped.
- `exclude` — default `['Fragment', 'React.Fragment', 'React.StrictMode', 'React.Suspense', 'StrictMode', 'Suspense']` (DEFAULT_EXCLUDE, l. 43).

If an attribute with the same name already exists and its value is a `StringLiteral`, the new id is appended with the separator (l. 602) — chains like `${existing}:Foo:bar.tsx:42` accumulate; non-literal values (`{expr}`) are skipped without overwrite.

`shortFile` (l. 110): everything before and including `/src/` is stripped; if no `/src/` is present, only the basename is kept; the trailing `.tsx`/`.ts`/`.jsx`/`.js` is removed. Synthetic nodes with no `loc` get `line=0`.

### Part 2 — `Component.__mcp_hooks` metadata

Per file, the plugin queues hook-array assignments (or HOC-forwarding getters) and flushes them in `Program:exit` (l. 628). Queueing rather than inserting on entry is mandatory: react-refresh, react-compiler, and worklets all use `replaceWith` mid-traversal, which silently drops sibling statements inserted via `insertAfter`. End-of-body placement also dodges a separate bug where `var Foo = ...` gets hoisted by other presets and our injected statement runs before `Foo` is initialized — see the comment block at l. 325 for the worklets-extracted `_worklet_..._init_data` case.

Candidate emit sites (in two visitors, `FunctionDeclaration` l. 541 and `VariableDeclarator` l. 647):
1. **Component** — capitalized name AND (`bodyUsesJSX` OR `bodyCallsHook`). The hook-call branch covers portal/imperative-handle components that legitimately `return null`. Under the Rules of Hooks, a capitalized hook-calling function is unambiguously a component.
2. **Custom hook** — name matches `/^use[A-Z]/` AND body calls at least one hook.

`Program:exit` dedupes by `outer` name before flushing (l. 633), defending against multi-pass traversals queueing the same component twice.

#### HOC unwrap

For `const Foo = anyHoc(InnerFn)`, [`unwrapHocChainToBottom`](testIdPlugin.ts#L460) walks the call chain. `isLikelyHocCallee` (l. 409) accepts:
- bare `Identifier` callees (`memo`, `forwardRef`, `observer`, `withAuth`, …) — name-agnostic;
- non-computed `MemberExpression` callees whose object resolves to a **module-kind binding** (`React.memo`, `Mobx.observer`). Local-method calls like `arr.map(fn)` are rejected by the `binding.kind === 'module'` gate.

`unwrapTransparentExpr` (l. 441) additionally steps through `AssignmentExpression` (`_c = arrow`) and `SequenceExpression` wrappers that react-refresh inserts around the inner function during its own `VariableDeclaration` visitor (which runs before ours). Bounded to 8 hops as a guard.

The `VariableDeclarator` visitor also unwraps TS casts on the initializer (`TSAsExpression`, `TSTypeAssertion`, `TSSatisfiesExpression`, `TSNonNullExpression`, l. 664) — bounded to 4 hops — so `const Wrapped = memo(arrow) as { ... }` succeeds.

Two HOC outcomes:
- **Inline-function form** (`memo((p) => <JSX/>)`) — `findInnerFunctionBodyPath` returns the body; hooks are collected and a direct assignment is queued.
- **Identifier-ref form** (`memo(Inner)`) — `findInnerIdentifier` returns the name; a try/catch-wrapped `Object.defineProperty(Outer, '__mcp_hooks', { configurable: true, get: () => Inner.__mcp_hooks })` is queued via `buildHooksGetterStmt` (l. 300). The getter sidesteps declaration order, hoisting, scope, and arbitrary HOC return shapes (frozen / primitive / null). The try/catch is mandatory because ES modules run in strict mode and `Object.defineProperty` on a primitive throws `TypeError`. The getter is only queued when the outer name is capitalized AND the inner identifier has a resolvable scope binding (l. 699).

Each queued assignment is itself wrapped in `try { ... } catch {}` (`buildAssignmentStmt`, l. 334) for the same stale-binding defense.

#### Hook detection (`collectHooksInBody`, l. 152)

Recognized call shapes per `CallExpression`:
- `useState(x)` — direct `Identifier` callee.
- `React.useState(x)` — non-computed `MemberExpression`. Property name must match `HOOK_NAME_RE = /^use([A-Z]|$)/` (l. 81).
- `_React2.useState(x)` — bundler-mangled namespace; the object name must match `REACT_NAMESPACE_RE = /^_?[Rr]eact\d*$/` (l. 89). This filter is critical for **bare `use(...)`** specifically — `database.use(middleware)` / `app.use(router)` are filtered out (l. 188) so they don't show as Use-kind false positives. For `useXxx` member calls (`React.useState`) the property name is already unique enough; the namespace filter is technically applied to them too but rarely matters.

`HOOK_KIND` (l. 58) maps all 18 React 16/18/19 stable hooks: State, Effect, Memo, Callback, Ref, Context, Reducer, ImperativeHandle, LayoutEffect, InsertionEffect, DebugValue, Transition, DeferredValue, Id, SyncExternalStore, Optimistic, ActionState, Use. **`useFormStatus` and `useFormState` are intentionally omitted** — react-dom only.

Anything matching the hook-name detector that isn't in `HOOK_KIND` is `kind: "Custom"`.

Name resolution from consuming binding (l. 196):
- `Identifier` → that name.
- `ArrayPattern` (`const [v, setV] = useState(0)`) → first element identifier.
- `ObjectPattern` (`const { foo } = useCustomHook()`) → first object-property key.
- Naked call (typical `useEffect(...)`) → `${kind.toLowerCase()}:${index}` with a per-kind counter so `effect:0` doesn't collide with `state:0`.

For each entry: `mcpId = name:shortFile:line` when source line is known — matches the JSX `data-mcp-id` shape so a single `Read(file, line)` jumps to the call site. `hook` records the source-level hook function name (`useState`, `useAnimatedStyle`, `use`) — for `React.useX` it stores just the property (`useState`).

`fn: Identifier` is emitted only for **Custom-kind direct-identifier calls** where the binding resolves to **module scope** (`binding.scope.block.type === 'Program'`, l. 239). The runtime reads `fn.__mcp_hooks` to recursively expand sub-hooks. Local / parameter bindings are filtered because the injection site is module-level and would throw `ReferenceError`. Member-call form skips `fn` because built-in `kind` mapping is enough.

`collectHooksInBody` and `bodyCallsHook` both call `innerPath.skip()` on every nested `Function` (l. 250, l. 522) — hooks defined inside nested callbacks are not this component's hooks. The wrapper call (`useCallback(() => { useFoo() })`) is still visited because the outer `CallExpression` fires before the inner function is skipped.

### Operational notes

- Metro runs Babel plugins on `node_modules` by default — `react-redux`, `@tanstack/react-query`, etc. get annotated automatically. First build pays a few-second cost; subsequent builds hit Metro's cache.
- `PluginPassWithQueue.pendingInjects` (l. 26) is per-file; Babel instantiates a fresh `PluginPass` per transform, so cross-file leakage is structurally impossible.
- The injected `try/catch` blocks use **optional catch binding** (`catch {}`, ES2019) — confirmed supported by Hermes. Don't change to `catch (_e)` unless you also bump the engine target.

## `stripPlugin` (prod only)

Lives in [stripPlugin.ts](stripPlugin.ts). Removes all traces of mcp-kit from the bundle so `if (__DEV__)` wrappers are unnecessary.

Options (`PluginOptions`, l. 5):
- `additionalSources` — extra import sources to strip.
- `additionalFunctions` — extra bare-function call names to strip.

Defaults (l. 12):
- `DEFAULT_SOURCES = [PACKAGE_NAME]` — `PACKAGE_NAME` comes from `@/shared/protocol` (currently `"react-native-mcp-kit"`). Both `import` and `require()` forms are matched; subpaths via `startsWith(\`${s}/\`)` cover `react-native-mcp-kit/babel`, `react-native-mcp-kit/server`, etc.
- `DEFAULT_FUNCTIONS = ['useMcpTool', 'useMcpModule', 'initMcp']` — bare-name `ExpressionStatement` calls.

Removals by visitor:

- **`ImportDeclaration`** (l. 112) — drop every import whose source matches `DEFAULT_SOURCES + additionalSources`.
- **`CallExpression`** (l. 34) —
  - `require('react-native-mcp-kit')` / sub-paths: removes the enclosing `VariableDeclaration` (`const x = require(...)`) or `ExpressionStatement`.
  - Bare-name calls in `DEFAULT_FUNCTIONS + additionalFunctions`: removes the parent `ExpressionStatement`.
  - `McpClient.*(...)` (any property on `McpClient` identifier): removes `ExpressionStatement` or enclosing `VariableDeclaration`.
  - Method calls whose property is one of `['registerModule', 'registerModules', 'registerTool', 'dispose', 'enableDebug']` — removed regardless of receiver. This is intentionally aggressive: a `someUnrelated.dispose()` from an unrelated lib in the same expression-statement position would be removed too. In practice this hasn't bitten because these names are mcp-kit-coded; flag if you add a new name to the list.
- **`AssignmentExpression`** (l. 23) — drop any `X.__mcp_hooks = [...]` statements emitted by the test-id-plugin. Only removes when the assignment is the direct child of an `ExpressionStatement`; the try/catch wrappers built by `testIdPlugin` therefore disappear by virtue of containing only the (now-removed) assignment, but the removal happens at the AssignmentExpression node — the try-statement carcass is left. (Worth verifying in compiled output if minifier output ever looks off.)
- **`JSXAttribute`** (l. 127) — strip every `data-mcp-id="..."` attribute.
- **`JSXElement`** for `McpProvider` (l. 138) — replace `<McpProvider>...</McpProvider>` with its children. The handling has three contexts:
  1. Filter children: drop whitespace-only `JSXText`.
  2. Zero real children → `path.remove()`.
  3. JSX parent (`JSXElement` / `JSXFragment`) → `path.replaceWithMultiple(realChildren)` so siblings sit alongside other JSX.
  4. Non-JSX parent (arrow body / return / paren) with single child:
     - `JSXExpressionContainer` is unwrapped to its inner expression; a `JSXEmptyExpression` causes full removal.
     - Any other single child replaces the node directly.
  5. Non-JSX parent with multiple children → wrap in `<>{children}</>` (`JSXFragment`).

### Limitations to know

- The `McpClient` removal only matches the literal `McpClient` identifier as the member expression object. `const c = McpClient.getInstance(); c.dispose();` removes `dispose()` (matches the property-name list) but leaves the variable declaration intact unless the right-hand side itself is an `McpClient.*` call (which it is, so it gets removed via the McpClient branch). Aliasing through a wider call chain (`getClient().registerModule(...)`) only matches via the property-name list — the receiver isn't traced.
- No source-map adjustments are emitted explicitly; Babel computes them from the surviving nodes.
