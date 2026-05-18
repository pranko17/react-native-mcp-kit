import { type NodePath, type types as BabelTypes } from '@babel/core';

import { HOOK_KIND, HOOK_NAME_RE, REACT_NAMESPACE_RE } from './constants';
import { type CollectedHook } from './types';

/**
 * Walk a function body collecting hook-call metadata in source order. Names
 * come from the consuming binding:
 *   const [count, setCount] = useState(0)   → "count"
 *   const memoValue         = useMemo(...)  → "memoValue"
 *   useEffect(...)                          → "effect:<index>"
 * The `kind` is taken from HOOK_KIND for built-ins, or "Custom" for any
 * other identifier matching `/^use[A-Z]/`.
 */
export const collectHooksInBody = (
  body: NodePath<BabelTypes.Node>,
  t: typeof BabelTypes,
  shortFile: string,
  separator: string
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
      const line = callPath.node.loc?.start.line;
      if (line) {
        entry.mcpId = `${hookName}${separator}${shortFile}${separator}${line}`;
      }
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
