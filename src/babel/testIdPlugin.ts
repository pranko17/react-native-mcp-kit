import { type NodePath, type PluginObj, type types as BabelTypes } from '@babel/core';

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
// matching `/^use[A-Z]/` that is NOT in this table is treated as "Custom".
const HOOK_KIND: Record<string, string> = {
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
  useReducer: 'Reducer',
  useRef: 'Ref',
  useState: 'State',
  useSyncExternalStore: 'SyncExternalStore',
  useTransition: 'Transition',
};

// Cheap, conservative component detector: the binding name starts with a
// capital letter and the function body mentions JSX somewhere. Covers
// `function LoginForm() { return <View />; }` and
// `const LoginForm = (props) => <View />;`. Misses HOC-wrapped components
// (memo / forwardRef) — those land in a follow-up.
const isCapitalized = (name: string | undefined): boolean => {
  return (
    !!name &&
    name.length > 0 &&
    name[0] === name[0]?.toUpperCase() &&
    name[0] !== name[0]?.toLowerCase()
  );
};

interface CollectedHook {
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
      if (t.isIdentifier(callee)) {
        hookIdent = callee.name;
      } else if (
        t.isMemberExpression(callee) &&
        !callee.computed &&
        t.isIdentifier(callee.property)
      ) {
        hookIdent = callee.property.name;
        isMemberCall = true;
      }
      if (!hookIdent || !/^use[A-Z]/.test(hookIdent)) return;

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

      const entry: CollectedHook = { kind, name: hookName };
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
      ];
      if (h.fnIdent) {
        // fn: useAuth   (runtime reads .__mcp_hooks off this identifier)
        props.push(t.objectProperty(t.identifier('fn'), t.identifier(h.fnIdent)));
      }
      return t.objectExpression(props);
    })
  );
};

// Insert `ComponentName.__mcp_hooks = [...]` after the statement that
// declared the component. Idempotent-by-construction: we only run once per
// component declaration, and the plugin is expected to run once per build.
const attachHooksMetadata = (
  statementPath: NodePath<BabelTypes.Node>,
  componentName: string,
  hooks: CollectedHook[],
  t: typeof BabelTypes
): void => {
  if (hooks.length === 0) return;
  const assignment = t.expressionStatement(
    t.assignmentExpression(
      '=',
      t.memberExpression(t.identifier(componentName), t.identifier('__mcp_hooks')),
      buildHooksArrayExpr(hooks, t)
    )
  );
  statementPath.insertAfter(assignment);
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
      // memo()/forwardRef() wrappers are deferred to a follow-up.
      // Also handled via the VariableDeclarator visitor below for the
      // `const Foo = (...) => {...}` / `const useX = (...) => {...}` forms.
      FunctionDeclaration(path) {
        const id = path.node.id;
        if (!id) return;
        const bodyPath = path.get('body');

        // Component: capitalized name + JSX in body.
        if (isCapitalized(id.name) && bodyUsesJSX(bodyPath)) {
          const hooks = collectHooksInBody(bodyPath, t);
          attachHooksMetadata(path, id.name, hooks, t);
          return;
        }

        // Custom hook: name matches use[A-Z] + body calls at least one hook.
        if (isCustomHookName(id.name) && bodyCallsHook(bodyPath, t)) {
          const hooks = collectHooksInBody(bodyPath, t);
          attachHooksMetadata(path, id.name, hooks, t);
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

      VariableDeclarator(path) {
        const id = path.node.id;
        if (!t.isIdentifier(id)) return;
        const init = path.node.init;
        if (!init) return;
        if (!t.isArrowFunctionExpression(init) && !t.isFunctionExpression(init)) return;

        const bodyPath = path.get('init.body') as NodePath<BabelTypes.Node>;
        if (!bodyPath.node) return;

        // Component: capitalized + JSX.
        if (isCapitalized(id.name) && bodyUsesJSX(bodyPath)) {
          const hooks = collectHooksInBody(bodyPath, t);
          const statement = path.getStatementParent();
          if (!statement) return;
          attachHooksMetadata(statement, id.name, hooks, t);
          return;
        }

        // Custom hook: use[A-Z] + body calls hooks.
        if (isCustomHookName(id.name) && bodyCallsHook(bodyPath, t)) {
          const hooks = collectHooksInBody(bodyPath, t);
          const statement = path.getStatementParent();
          if (!statement) return;
          attachHooksMetadata(statement, id.name, hooks, t);
        }
      },
    },
  };
}
