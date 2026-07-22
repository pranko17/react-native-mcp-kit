import { type NodePath, type types as BabelTypes } from '@babel/core';

import { FRAGMENT_LIKE } from './constants';

type Binding = NonNullable<ReturnType<NodePath['scope']['getBinding']>>;

// Cheap, conservative component detector: the binding name starts with a
// capital letter and the function body mentions JSX somewhere. Covers
// `function LoginForm() { return <View />; }` and
// `const LoginForm = (props) => <View />;`. HOC-wrapped components
// (memo / forwardRef / observer) are handled in `VariableDeclarator` by
// unwrapping the call expression first via `findInnerFunctionBodyPath`.
export const isCapitalized = (name: string | undefined): boolean => {
  return (
    !!name &&
    name.length > 0 &&
    name[0] === name[0]?.toUpperCase() &&
    name[0] !== name[0]?.toLowerCase()
  );
};

// Strip the absolute path prefix (anything up to and including the project's
// `/src/`) and drop the .ts/.tsx/.js/.jsx extension. Same shape components
// use inside `data-mcp-id` so a hook's `mcpId` and a JSX element's
// `data-mcp-id` look interchangeable to an agent reading them.
export const getShortFile = (filename: string | null | undefined): string => {
  const file = filename ?? 'unknown';
  const relative = file.includes('/src/')
    ? (file.split('/src/').pop() ?? file)
    : (file.split('/').pop() ?? file);
  return relative.replace(/\.(tsx?|jsx?)$/, '');
};

// Is this a candidate custom hook definition? Name matches `use[A-Z]...`
// and the body contains at least one built-in or custom hook call. Matches
// userland hooks AND library hook sources that happen to pass through our
// babel transform (Metro runs plugins on node_modules by default).
export const isCustomHookName = (name: string | undefined): boolean => {
  return !!name && /^use[A-Z]/.test(name);
};

// Heuristic: the function body must reference JSX. Otherwise it's just a
// plain capitalized helper that happens to share the naming convention.
export const bodyUsesJSX = (bodyPath: NodePath<BabelTypes.Node>): boolean => {
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

// Can this expression evaluate to a fragment-like builtin at runtime?
// Walks the value positions that stay statically enumerable — ternary /
// logical branches and TS cast wrappers — and flags direct references:
// bare `Fragment`-family identifiers and any-namespace `.Fragment` members
// (the same name-based convention as the JSXMemberExpression guard).
export const exprCanBeFragmentLike = (
  node: BabelTypes.Node | null | undefined,
  t: typeof BabelTypes
): boolean => {
  if (!node) return false;
  if (
    t.isTSAsExpression(node) ||
    t.isTSTypeAssertion(node) ||
    t.isTSSatisfiesExpression(node) ||
    t.isTSNonNullExpression(node) ||
    t.isParenthesizedExpression(node)
  ) {
    return exprCanBeFragmentLike(node.expression, t);
  }
  if (t.isConditionalExpression(node)) {
    return exprCanBeFragmentLike(node.consequent, t) || exprCanBeFragmentLike(node.alternate, t);
  }
  if (t.isLogicalExpression(node)) {
    return exprCanBeFragmentLike(node.left, t) || exprCanBeFragmentLike(node.right, t);
  }
  if (t.isIdentifier(node)) {
    return FRAGMENT_LIKE.has(node.name);
  }
  if (t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.property)) {
    return FRAGMENT_LIKE.has(node.property.name);
  }
  return false;
};

// Does the binding site of a JSX name admit a fragment-like value? Shapes
// seen in the wild (component libraries ship them untranspiled to Metro
// consumers, so our plugin transforms them):
//   `({ containerComponent: C = React.Fragment }) => <C/>`
//   `const Wrapper = onPress ? TouchableOpacity : Fragment`
// Params WITHOUT a fragment default stay stampable: their runtime value is
// the caller's choice and unknowable here, and the stamp marks a real slot.
export const bindingCanBeFragmentLike = (binding: Binding, t: typeof BabelTypes): boolean => {
  const node = binding.path.node;

  // Plain declarator: `const Wrapper = cond ? X : Fragment`.
  if (t.isVariableDeclarator(node) && t.isIdentifier(node.id)) {
    return exprCanBeFragmentLike(node.init, t);
  }

  // Bare param default: `(C = Fragment) => <C/>` — the binding path IS the
  // AssignmentPattern, which traverse() below would not visit.
  if (t.isAssignmentPattern(node) && node.left === binding.identifier) {
    return exprCanBeFragmentLike(node.right, t);
  }

  // Destructuring defaults, in params or declarators:
  //   `({ container: C = React.Fragment }) => ...`
  //   `const { container: C = React.Fragment } = props;`
  let admits = false;
  binding.path.traverse({
    AssignmentPattern(patternPath) {
      if (
        patternPath.node.left === binding.identifier &&
        exprCanBeFragmentLike(patternPath.node.right, t)
      ) {
        admits = true;
        patternPath.stop();
      }
    },
  });
  return admits;
};

export const bodyCallsHook = (
  bodyPath: NodePath<BabelTypes.Node>,
  t: typeof BabelTypes
): boolean => {
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
