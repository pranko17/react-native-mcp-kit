import {
  type NodePath,
  type PluginObj,
  type PluginPass,
  type types as BabelTypes,
} from '@babel/core';

/**
 * Per-file plugin state with deferred-injection queue. Babel instantiates
 * `PluginPass` per file, so this naturally scopes the queue to a single
 * transformation. We collect all the metadata assignments during the main
 * traversal, then flush them at `Program:exit` — that runs AFTER other
 * plugins' replaceWith calls (e.g. react-refresh wrapping HOC chains in
 * `_s(...)` signature calls), so our injected statements aren't dropped by
 * babel's re-traversal of the rebuilt subtrees.
 */
type DeferredInsert =
  | {
      hooks: CollectedHook[];
      kind: 'assignment';
      outer: string;
      statementPath: NodePath<BabelTypes.Node>;
    }
  | { inner: string; kind: 'getter'; outer: string; statementPath: NodePath<BabelTypes.Node> };

interface PluginPassWithQueue extends PluginPass {
  pendingInjects?: DeferredInsert[];
}

interface PluginOptions {
  /** Attribute name to use. Default: "data-mcp-id" */
  attr?: string;
  /** Components to skip. Default: common wrappers */
  exclude?: string[];
  /** Components to add id to. Default: all capitalized JSX elements */
  include?: string[];
  /** Separator between parts. Default: ":" */
  separator?: string;
}

const DEFAULT_ATTR = 'data-mcp-id';

const DEFAULT_EXCLUDE = [
  'Fragment',
  'React.Fragment',
  'React.StrictMode',
  'React.Suspense',
  'StrictMode',
  'Suspense',
];

// Map of built-in React hook names → agent-friendly `kind` labels. Anything
// matching the hook-name detector (`use` exact or `/^use[A-Z]/`) that is
// NOT in this table is treated as "Custom".
//
// react-dom-only hooks (`useFormStatus`, `useFormState`) are intentionally
// omitted — this library targets React Native, where neither exists.
const HOOK_KIND: Record<string, string> = {
  use: 'Use',
  useActionState: 'ActionState',
  useCallback: 'Callback',
  useContext: 'Context',
  useDebugValue: 'DebugValue',
  useDeferredValue: 'DeferredValue',
  useEffect: 'Effect',
  useId: 'Id',
  useImperativeHandle: 'ImperativeHandle',
  useInsertionEffect: 'InsertionEffect',
  useLayoutEffect: 'LayoutEffect',
  useMemo: 'Memo',
  useOptimistic: 'Optimistic',
  useReducer: 'Reducer',
  useRef: 'Ref',
  useState: 'State',
  useSyncExternalStore: 'SyncExternalStore',
  useTransition: 'Transition',
};

// Hook-name detector. Accepts `use` exact (React 19's `use(promise|context)`)
// AND the classic `use[A-Z]\w*` pattern.
const HOOK_NAME_RE = /^use([A-Z]|$)/;

// For the MemberExpression form (`X.use(...)`) we need to filter out
// unrelated method calls — `database.use(middleware)`, `app.use(router)` etc.
// Allow only object names that look like React-namespace bindings: literal
// `React` / `react` and the common bundler-mangled forms (`_react`,
// `_React2`, `_react3`, …). Same heuristic for any hook, but matters most
// for bare `use` whose name is otherwise too generic to disambiguate.
const REACT_NAMESPACE_RE = /^_?[Rr]eact\d*$/;

// Cheap, conservative component detector: the binding name starts with a
// capital letter and the function body mentions JSX somewhere. Covers
// `function LoginForm() { return <View />; }` and
// `const LoginForm = (props) => <View />;`. HOC-wrapped components
// (memo / forwardRef / observer) are handled in `VariableDeclarator` by
// unwrapping the call expression first via `findInnerFunctionBodyPath`.
const isCapitalized = (name: string | undefined): boolean => {
  return (
    !!name &&
    name.length > 0 &&
    name[0] === name[0]?.toUpperCase() &&
    name[0] !== name[0]?.toLowerCase()
  );
};

interface CollectedHook {
  /** Source-level hook function name (`useState`, `useAnimatedStyle`, etc.).
   * Surfaced to the agent alongside `name` (the consuming binding) so it
   * can tell e.g. `count (useState)` from `count (useReducer)` without
   * inferring from `kind`. For React.useXxx member-call form we still
   * record just the property name (`useState`). */
  hook: string;
  kind: string;
  name: string;
  /**
   * For Custom-kind entries: the source identifier of the hook function being
   * called. Runtime reads `identifierRef.__mcp_hooks` to recursively expand
   * sub-hooks, keeping slot alignment exact even when custom hooks span
   * multiple built-in slots. Built-in hooks (State/Memo/...) don't need this.
   */
  fnIdent?: string;
}

/**
 * Walk a function body collecting hook-call metadata in source order. Names
 * come from the consuming binding:
 *   const [count, setCount] = useState(0)   → "count"
 *   const memoValue         = useMemo(...)  → "memoValue"
 *   useEffect(...)                          → "effect:<index>"
 * The `kind` is taken from HOOK_KIND for built-ins, or "Custom" for any
 * other identifier matching `/^use[A-Z]/`.
 */
const collectHooksInBody = (
  body: NodePath<BabelTypes.Node>,
  t: typeof BabelTypes
): CollectedHook[] => {
  const hooks: CollectedHook[] = [];
  const anonCounters: Record<string, number> = {};

  body.traverse({
    CallExpression(callPath) {
      const callee = callPath.node.callee;
      // Three call shapes:
      //   useState(x)           — direct identifier
      //   React.useState(x)     — MemberExpression (compiled react libs)
      //   _React2.useState(x)   — MemberExpression (bundler-mangled)
      let hookIdent: string | undefined;
      let isMemberCall = false;
      let memberObject: string | undefined;
      if (t.isIdentifier(callee)) {
        hookIdent = callee.name;
      } else if (
        t.isMemberExpression(callee) &&
        !callee.computed &&
        t.isIdentifier(callee.property)
      ) {
        hookIdent = callee.property.name;
        isMemberCall = true;
        if (t.isIdentifier(callee.object)) memberObject = callee.object.name;
      }
      if (!hookIdent || !HOOK_NAME_RE.test(hookIdent)) return;
      // For the `<obj>.use(...)` form, only accept calls with a React-like
      // namespace as the object — otherwise `database.use(middleware)` and
      // friends light up. `useXxx` member calls (`React.useState`) keep
      // working through the same gate since their property name is unique
      // enough on its own; the filter just prunes ambiguous bare `use`.
      if (isMemberCall && hookIdent === 'use' && !REACT_NAMESPACE_RE.test(memberObject ?? '')) {
        return;
      }

      const kind = HOOK_KIND[hookIdent] ?? 'Custom';

      // Resolve hook name from the consuming binding when possible.
      let hookName: string | undefined;
      const parent = callPath.parent;
      if (t.isVariableDeclarator(parent)) {
        const id = parent.id;
        if (t.isIdentifier(id)) {
          hookName = id.name;
        } else if (t.isArrayPattern(id)) {
          // const [value, setter] = useState(0)  → pick the first binding
          const first = id.elements[0];
          if (first && t.isIdentifier(first)) {
            hookName = first.name;
          }
        } else if (t.isObjectPattern(id)) {
          // const { foo } = useCustomHook() — rare, name it after the first key
          const firstProp = id.properties[0];
          if (firstProp && t.isObjectProperty(firstProp) && t.isIdentifier(firstProp.key)) {
            hookName = firstProp.key.name;
          }
        }
      }

      if (!hookName) {
        // Naked hook call (typical for useEffect). Generate a positional name
        // keyed by the hook kind so "effect:0" / "effect:1" don't collide
        // with state hooks if user has multiple effects.
        const counterKey = kind.toLowerCase();
        const index = anonCounters[counterKey] ?? 0;
        anonCounters[counterKey] = index + 1;
        hookName = `${counterKey}:${index}`;
      }

      const entry: CollectedHook = { hook: hookIdent, kind, name: hookName };
      if (kind === 'Custom' && !isMemberCall) {
        // Only attach a function reference for direct-identifier calls where
        // we can verify the binding is module-scoped (import / top-level
        // const/let/var/function). MemberExpression calls (React.useX) are
        // always built-in hooks anyway — kind ends up mapped, no expansion
        // needed. Local/parameter names would throw ReferenceError at the
        // injection site (which is module-level).
        const binding = callPath.scope.getBinding(hookIdent);
        if (binding && binding.scope.block.type === 'Program') {
          entry.fnIdent = hookIdent;
        }
      }
      hooks.push(entry);
    },
    Function(innerPath) {
      // Don't descend into nested functions — their hooks are not this
      // component's hooks. `useCallback(() => {...})` is still traversed
      // because the wrapper call is a call expression visited before we
      // skip into the body (we only skip the nested function's own
      // declaration/body traversal).
      innerPath.skip();
    },
  });

  return hooks;
};

const buildHooksArrayExpr = (
  hooks: CollectedHook[],
  t: typeof BabelTypes
): BabelTypes.ArrayExpression => {
  return t.arrayExpression(
    hooks.map((h) => {
      const props: BabelTypes.ObjectProperty[] = [
        t.objectProperty(t.identifier('name'), t.stringLiteral(h.name)),
        t.objectProperty(t.identifier('kind'), t.stringLiteral(h.kind)),
        t.objectProperty(t.identifier('hook'), t.stringLiteral(h.hook)),
      ];
      if (h.fnIdent) {
        // fn: useAuth   (runtime reads .__mcp_hooks off this identifier)
        props.push(t.objectProperty(t.identifier('fn'), t.identifier(h.fnIdent)));
      }
      return t.objectExpression(props);
    })
  );
};

// Build:
//   try {
//     Object.defineProperty(Outer, '__mcp_hooks', {
//       configurable: true,
//       get: () => Inner.__mcp_hooks,
//     });
//   } catch {}
// Used for the identifier-ref HOC case (`const Outer = memo(Inner)`) where
// we can't statically collect hooks from the wrapped function. The getter
// forwards to the inner binding's metadata at read time, sidestepping
// declaration order, hoisting, scope, and custom-HOC return shape.
//
// The try/catch is mandatory: the HOC's return value is statically unknown
// — it could be a primitive (number / string), `null`/`undefined`, or a
// frozen / sealed object. Any of those make `Object.defineProperty` throw
// `TypeError` in strict mode (which ES modules always are). A throw at
// module-init kills the bundle. Swallowing here is harmless: the worst
// outcome is metadata not being attached to that one binding, exactly as
// if the plugin had skipped it.
const buildHooksGetterStmt = (
  outer: string,
  inner: string,
  t: typeof BabelTypes
): BabelTypes.TryStatement => {
  const defineCall = t.expressionStatement(
    t.callExpression(t.memberExpression(t.identifier('Object'), t.identifier('defineProperty')), [
      t.identifier(outer),
      t.stringLiteral('__mcp_hooks'),
      t.objectExpression([
        t.objectProperty(t.identifier('configurable'), t.booleanLiteral(true)),
        t.objectProperty(
          t.identifier('get'),
          t.arrowFunctionExpression(
            [],
            t.memberExpression(t.identifier(inner), t.identifier('__mcp_hooks'))
          )
        ),
      ]),
    ])
  );
  // Optional-catch-binding (ES2019): `catch {}` — supported by Hermes.
  return t.tryStatement(t.blockStatement([defineCall]), t.catchClause(null, t.blockStatement([])));
};

// Build the `ComponentName.__mcp_hooks = [...]` statement, wrapped in a
// `try { ... } catch {}` so a stale binding can't crash module-init. We
// place these at the END of the program body — by the time they run, every
// `var X = ...` in the file has been initialized. Without that placement,
// react-compiler + react-native preset rewrite `const Foo = ...` to a
// hoisted `var Foo = ...` whose binding is `undefined` until its source-line
// is reached, and a worklets-extracted `var _worklet_..._init_data` slips
// between our queued insertAfter target and the rebuilt declaration —
// `Foo.__mcp_hooks = [...]` then runs against `undefined` and throws.
const buildAssignmentStmt = (
  componentName: string,
  hooks: CollectedHook[],
  t: typeof BabelTypes
): BabelTypes.TryStatement => {
  const assignment = t.expressionStatement(
    t.assignmentExpression(
      '=',
      t.memberExpression(t.identifier(componentName), t.identifier('__mcp_hooks')),
      buildHooksArrayExpr(hooks, t)
    )
  );

  return t.tryStatement(t.blockStatement([assignment]), t.catchClause(null, t.blockStatement([])));
};

// Queue a `ComponentName.__mcp_hooks = [...]` insertion for `Program:exit`.
// Inserting during the main traversal is unsafe: react-refresh's babel
// plugin replaces HOC-wrapped function expressions via `replaceWith`, which
// re-traverses the rebuilt subtree and (in our experience) drops sibling
// statements we'd inserted via `insertAfter` on the original declarator.
// Deferring to `Program:exit` keeps our writes visible to the final output
// without interfering with replaceWith semantics.
const queueHooksAssignment = (
  state: PluginPassWithQueue,
  statementPath: NodePath<BabelTypes.Node>,
  componentName: string,
  hooks: CollectedHook[]
): void => {
  if (hooks.length === 0) return;
  const queue = (state.pendingInjects ??= []);
  queue.push({ hooks, kind: 'assignment', outer: componentName, statementPath });
};

const queueHooksGetter = (
  state: PluginPassWithQueue,
  statementPath: NodePath<BabelTypes.Node>,
  outer: string,
  inner: string
): void => {
  const queue = (state.pendingInjects ??= []);
  queue.push({ inner, kind: 'getter', outer, statementPath });
};

// Heuristic: the function body must reference JSX. Otherwise it's just a
// plain capitalized helper that happens to share the naming convention.
const bodyUsesJSX = (bodyPath: NodePath<BabelTypes.Node>): boolean => {
  let uses = false;
  bodyPath.traverse({
    JSXElement() {
      uses = true;
    },
    JSXFragment() {
      uses = true;
    },
  });
  return uses;
};

// Is this a candidate custom hook definition? Name matches `use[A-Z]...`
// and the body contains at least one built-in or custom hook call. Matches
// userland hooks AND library hook sources that happen to pass through our
// babel transform (Metro runs plugins on node_modules by default).
const isCustomHookName = (name: string | undefined): boolean => {
  return !!name && /^use[A-Z]/.test(name);
};

// Recognize callee shapes that look like an HOC application without locking
// to a hardcoded name list. Two shapes pass:
//   1. `memo(fn)` / `forwardRef(fn)` / `withAuth(fn)` — bare Identifier callee.
//   2. `React.memo(fn)` / `Mobx.observer(fn)` — MemberExpression where the
//      object identifier resolves to a module (import) binding. This rules
//      out `arr.map(fn)` and similar local-method calls, which would
//      otherwise produce harmless-but-noisy metadata on a non-component
//      binding. Property access on a deep chain (`a.b.c(fn)`) is rejected.
const isLikelyHocCallee = (
  callPath: NodePath<BabelTypes.CallExpression>,
  t: typeof BabelTypes
): boolean => {
  const callee = callPath.node.callee;
  if (t.isIdentifier(callee)) return true;
  if (
    t.isMemberExpression(callee) &&
    !callee.computed &&
    t.isIdentifier(callee.property) &&
    t.isIdentifier(callee.object)
  ) {
    const binding = callPath.scope.getBinding(callee.object.name);
    return !!binding && binding.kind === 'module';
  }
  return false;
};

// Walk down a CallExpression chain (`memo(forwardRef(...))`,
// `withAuth(observer(...))`, etc.) to whatever the chain bottoms out at.
// Returns null if no unwrap happened (the start was not a recognized HOC
// chain). Each link must look like a plausible HOC application via
// `isLikelyHocCallee`, so non-HOC calls that happen to take a function
// argument (e.g. `arr.map(fn)`) don't trigger metadata attachment on the
// outer binding.
//
// Transparently steps through `AssignmentExpression` and `SequenceExpression`
// wrappers — react-refresh injects `_c = <fn>` and similar synthetic
// expression wraps around the inner component during its `VariableDeclaration`
// enter visitor (which runs before our `VariableDeclarator` visitor). Without
// the step-through, our unwrap would dead-end at the AssignmentExpression
// and miss the inner arrow / function expression entirely.
const unwrapTransparentExpr = (path: NodePath<BabelTypes.Node>): NodePath<BabelTypes.Node> => {
  let cur = path;
  // Bound the loop to defend against pathological ASTs.
  for (let i = 0; i < 8; i++) {
    if (cur.isAssignmentExpression() && cur.node.operator === '=') {
      cur = cur.get('right') as NodePath<BabelTypes.Node>;
      continue;
    }
    if (cur.isSequenceExpression()) {
      const exprs = cur.get('expressions') as NodePath<BabelTypes.Expression>[];
      if (exprs.length === 0) break;
      cur = exprs[exprs.length - 1] as NodePath<BabelTypes.Node>;
      continue;
    }
    break;
  }
  return cur;
};

const unwrapHocChainToBottom = (
  startPath: NodePath<BabelTypes.Node>,
  t: typeof BabelTypes
): NodePath<BabelTypes.Node> | null => {
  let cur: NodePath<BabelTypes.Node> = unwrapTransparentExpr(startPath);
  let unwrapped = false;
  while (cur.isCallExpression() && cur.node.arguments.length > 0 && isLikelyHocCallee(cur, t)) {
    const arg0 = cur.get('arguments.0') as NodePath<BabelTypes.Node>;
    if (!arg0.node) return null;
    cur = unwrapTransparentExpr(arg0);
    unwrapped = true;
  }
  return unwrapped ? cur : null;
};

// Two consumers of the unwrap walk:
//   1. Inline-function case (`memo(() => <JSX />)`) — find the body so we can
//      collect hooks and attach metadata directly to the outer binding.
//   2. Identifier-ref case (`memo(InnerFn)`) — record `{ outer, inner }` so a
//      deferred copy `Outer.__mcp_hooks = Inner.__mcp_hooks` can be emitted
//      at Program:exit. The inline case can't use the deferred copy approach
//      because there's no name to copy from.
const findInnerFunctionBodyPath = (
  startPath: NodePath<BabelTypes.Node>,
  t: typeof BabelTypes
): NodePath<BabelTypes.Node> | null => {
  const bottom = unwrapHocChainToBottom(startPath, t);
  if (!bottom) return null;
  if (bottom.isArrowFunctionExpression() || bottom.isFunctionExpression()) {
    return bottom.get('body') as NodePath<BabelTypes.Node>;
  }
  return null;
};

const findInnerIdentifier = (
  startPath: NodePath<BabelTypes.Node>,
  t: typeof BabelTypes
): NodePath<BabelTypes.Identifier> | null => {
  const bottom = unwrapHocChainToBottom(startPath, t);
  if (!bottom) return null;
  return bottom.isIdentifier() ? (bottom as NodePath<BabelTypes.Identifier>) : null;
};

const bodyCallsHook = (bodyPath: NodePath<BabelTypes.Node>, t: typeof BabelTypes): boolean => {
  let hit = false;
  bodyPath.traverse({
    CallExpression(callPath) {
      if (hit) return;
      const callee = callPath.node.callee;
      if (t.isIdentifier(callee) && /^use[A-Z]/.test(callee.name)) {
        hit = true;
        return;
      }
      if (
        t.isMemberExpression(callee) &&
        !callee.computed &&
        t.isIdentifier(callee.property) &&
        /^use[A-Z]/.test(callee.property.name)
      ) {
        hit = true;
      }
    },
    Function(innerPath) {
      innerPath.skip();
    },
  });
  return hit;
};

export default function testIdPlugin({ types: t }: { types: typeof BabelTypes }): PluginObj {
  return {
    name: 'react-native-mcp-test-id',
    visitor: {
      // === Part 2: attach __mcp_hooks metadata. ===
      // Two candidate shapes per function declaration:
      //   1. Component — capitalized name + JSX in body (React component).
      //   2. Custom hook — name matches /^use[A-Z]/ + body contains hook calls.
      // The VariableDeclarator visitor below covers the
      // `const Foo = (...) => {...}` / `const useX = (...) => {...}` forms,
      // plus HOC-wrapped components: `const Foo = anyHoc((props) => <JSX />)`
      // and nested chains thereof.
      FunctionDeclaration(path, state) {
        const id = path.node.id;
        if (!id) return;
        const bodyPath = path.get('body');
        const pluginState = state as PluginPassWithQueue;

        // Component: capitalized name + (JSX in body OR hook calls in body).
        // The hook-call branch covers components that legitimately return
        // null / non-JSX values — portal-like, context-only, or
        // imperative-handle wrappers. Under the Rules of Hooks, only
        // components and custom hooks may call hooks, so a capitalized
        // function that calls them is unambiguously a component.
        if (isCapitalized(id.name) && (bodyUsesJSX(bodyPath) || bodyCallsHook(bodyPath, t))) {
          const hooks = collectHooksInBody(bodyPath, t);
          queueHooksAssignment(pluginState, path, id.name, hooks);
          return;
        }

        // Custom hook: name matches use[A-Z] + body calls at least one hook.
        if (isCustomHookName(id.name) && bodyCallsHook(bodyPath, t)) {
          const hooks = collectHooksInBody(bodyPath, t);
          queueHooksAssignment(pluginState, path, id.name, hooks);
        }
      },

      // === Part 1: stamp data-mcp-id on capitalized JSX elements. ===
      JSXOpeningElement(path, state) {
        const opts = (state.opts ?? {}) as PluginOptions;
        const attrName = opts.attr ?? DEFAULT_ATTR;
        const separator = opts.separator ?? ':';
        const exclude = opts.exclude ?? DEFAULT_EXCLUDE;
        const include = opts.include;

        const nameNode = path.node.name;
        let componentName: string;

        if (t.isJSXIdentifier(nameNode)) {
          componentName = nameNode.name;
        } else if (t.isJSXMemberExpression(nameNode)) {
          componentName = `${(nameNode.object as BabelTypes.JSXIdentifier).name}.${nameNode.property.name}`;
        } else {
          return;
        }

        if (componentName[0] === componentName[0]?.toLowerCase()) return;

        if (include && !include.includes(componentName)) return;
        if (exclude.includes(componentName)) return;

        const filename = state.filename ?? 'unknown';
        const relativePath = filename.includes('/src/')
          ? (filename.split('/src/').pop() ?? filename)
          : (filename.split('/').pop() ?? filename);
        const shortFile = relativePath.replace(/\.(tsx?|jsx?)$/, '');
        const line = path.node.loc?.start.line ?? 0;

        const generatedId = `${componentName}${separator}${shortFile}${separator}${line}`;

        const existingAttr = path.node.attributes.find((attr) => {
          return t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name, { name: attrName });
        });

        if (existingAttr && t.isJSXAttribute(existingAttr)) {
          if (t.isStringLiteral(existingAttr.value)) {
            const existing = existingAttr.value.value;
            existingAttr.value = t.stringLiteral(
              `${existing}${separator}${shortFile}${separator}${line}`
            );
          }
          return;
        }

        path.node.attributes.push(
          t.jsxAttribute(t.jsxIdentifier(attrName), t.stringLiteral(generatedId))
        );
      },

      // === Part 3: drain deferred-injection queue at module end. ===
      // Runs after all other plugins' visitors (in particular react-refresh's
      // replaceWith on HOC-wrapped components) have finished mutating the
      // tree. We dedupe by `outer` name to defend against multiple visitor
      // passes queuing the same component twice, then push every queued
      // statement onto the END of the Program body. End-of-body is the only
      // placement that's safe across react-compiler + worklets + unistyles:
      // earlier plugins can rewrite a `const Foo = ...` declaration into a
      // hoisted `var Foo = ...` and slip extracted helpers (`_worklet_..._init_data`,
      // memoization scaffolding) BEFORE Foo's source line, leaving an
      // insertAfter-target-position holding a stale `undefined` binding.
      Program: {
        exit(programPath, state) {
          const pluginState = state as PluginPassWithQueue;
          const queue = pluginState.pendingInjects;
          if (!queue || queue.length === 0) return;
          const seen = new Set<string>();
          for (const entry of queue) {
            if (seen.has(entry.outer)) continue;
            seen.add(entry.outer);
            if (entry.kind === 'assignment') {
              programPath.pushContainer('body', buildAssignmentStmt(entry.outer, entry.hooks, t));
            } else {
              programPath.pushContainer('body', buildHooksGetterStmt(entry.outer, entry.inner, t));
            }
          }
          pluginState.pendingInjects = [];
        },
      },

      VariableDeclarator(path, state) {
        const id = path.node.id;
        if (!t.isIdentifier(id)) return;
        let initNode = path.node.init;
        if (!initNode) return;
        const pluginState = state as PluginPassWithQueue;

        // Unwrap TypeScript casts: `as Foo`, `as const`, `<Foo>x` (legacy
        // angle-bracket assertion), and `x satisfies Foo`. Without this,
        // `const Wrapped = memo(arrow) as { ... }` fails our HOC unwrap
        // because we'd see TSAsExpression instead of the inner CallExpression.
        // Pattern in the wild: 21vek's PageFlashListWithBanner /
        // ListProductRow / RangeFilter use `as` to attach generic call
        // signatures + displayName onto memo'd components.
        let initPathForUnwrap: NodePath<BabelTypes.Node> = path.get(
          'init'
        ) as NodePath<BabelTypes.Node>;
        for (let i = 0; i < 4; i++) {
          if (
            t.isTSAsExpression(initNode) ||
            t.isTSTypeAssertion(initNode) ||
            t.isTSSatisfiesExpression(initNode) ||
            t.isTSNonNullExpression(initNode)
          ) {
            initPathForUnwrap = initPathForUnwrap.get('expression') as NodePath<BabelTypes.Node>;
            initNode = initPathForUnwrap.node as BabelTypes.Expression;
            continue;
          }
          break;
        }
        const init = initNode;

        // Resolve the function body to inspect. Three shapes:
        //   const Foo = (props) => <JSX />              — direct arrow / fn
        //   const Foo = memo((props) => <JSX />)        — single-HOC wrap
        //   const Foo = memo(forwardRef((p, r) => ...)) — nested HOC chain
        // For HOC wrappers, attaching `Foo.__mcp_hooks = [...]` on the outer
        // binding works because `memo()` / `forwardRef()` return plain JS
        // objects that React stores in `fiber.type` — the runtime read path
        // is identical to the bare-component case. The unwrap is name-
        // agnostic (any Identifier or import-namespaced MemberExpression
        // callee qualifies), so custom HOCs like `withAuth(...)` work too.
        let bodyPath: NodePath<BabelTypes.Node> | null = null;
        if (t.isArrowFunctionExpression(init) || t.isFunctionExpression(init)) {
          bodyPath = initPathForUnwrap.get('body') as NodePath<BabelTypes.Node>;
        } else if (t.isCallExpression(init)) {
          bodyPath = findInnerFunctionBodyPath(initPathForUnwrap, t);

          // Identifier-ref HOC case: `const Foo = memo(InnerFn)`. The inner
          // arg is a name, not an inline function — so we can't statically
          // collect hooks here. Instead, install a getter on `Foo` that
          // forwards to `Inner.__mcp_hooks` at read time.
          if (!bodyPath && isCapitalized(id.name)) {
            const inner = findInnerIdentifier(initPathForUnwrap, t);
            if (inner && inner.scope.getBinding(inner.node.name)) {
              const stmt = path.getStatementParent();
              if (stmt) {
                queueHooksGetter(pluginState, stmt, id.name, inner.node.name);
              }
            }
          }
        }
        if (!bodyPath || !bodyPath.node) return;

        // Component: capitalized + (JSX in body OR hook calls). Same
        // rationale as FunctionDeclaration above — Rules of Hooks pin a
        // capitalized hook-calling function to "component", so JSX is
        // sufficient but not necessary (covers `return null` portals).
        if (isCapitalized(id.name) && (bodyUsesJSX(bodyPath) || bodyCallsHook(bodyPath, t))) {
          const hooks = collectHooksInBody(bodyPath, t);
          const statement = path.getStatementParent();
          if (!statement) return;
          queueHooksAssignment(pluginState, statement, id.name, hooks);
          return;
        }

        // Custom hook: use[A-Z] + body calls hooks.
        if (isCustomHookName(id.name) && bodyCallsHook(bodyPath, t)) {
          const hooks = collectHooksInBody(bodyPath, t);
          const statement = path.getStatementParent();
          if (!statement) return;
          queueHooksAssignment(pluginState, statement, id.name, hooks);
        }
      },
    },
  };
}
