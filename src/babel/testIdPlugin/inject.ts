import { type NodePath, type types as BabelTypes } from '@babel/core';

import { type CollectedHook, type PluginPassWithQueue } from './types';

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
      if (h.mcpId) {
        props.push(t.objectProperty(t.identifier('mcpId'), t.stringLiteral(h.mcpId)));
      }
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
export const buildHooksGetterStmt = (
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
export const buildAssignmentStmt = (
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
export const queueHooksAssignment = (
  state: PluginPassWithQueue,
  statementPath: NodePath<BabelTypes.Node>,
  componentName: string,
  hooks: CollectedHook[]
): void => {
  if (hooks.length === 0) return;
  const queue = (state.pendingInjects ??= []);
  queue.push({ hooks, kind: 'assignment', outer: componentName, statementPath });
};

export const queueHooksGetter = (
  state: PluginPassWithQueue,
  statementPath: NodePath<BabelTypes.Node>,
  outer: string,
  inner: string
): void => {
  const queue = (state.pendingInjects ??= []);
  queue.push({ inner, kind: 'getter', outer, statementPath });
};
