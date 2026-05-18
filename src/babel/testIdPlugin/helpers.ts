import { type NodePath, type types as BabelTypes } from '@babel/core';

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
