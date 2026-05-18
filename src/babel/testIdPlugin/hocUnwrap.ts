import { type NodePath, type types as BabelTypes } from '@babel/core';

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
export const findInnerFunctionBodyPath = (
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

export const findInnerIdentifier = (
  startPath: NodePath<BabelTypes.Node>,
  t: typeof BabelTypes
): NodePath<BabelTypes.Identifier> | null => {
  const bottom = unwrapHocChainToBottom(startPath, t);
  if (!bottom) return null;
  return bottom.isIdentifier() ? (bottom as NodePath<BabelTypes.Identifier>) : null;
};
