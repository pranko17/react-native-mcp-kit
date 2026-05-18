import { type NodePath, type PluginObj, type types as BabelTypes } from '@babel/core';

import { collectHooksInBody } from './collectHooks';
import { DEFAULT_ATTR, DEFAULT_EXCLUDE } from './constants';
import {
  bodyCallsHook,
  bodyUsesJSX,
  getShortFile,
  isCapitalized,
  isCustomHookName,
} from './helpers';
import { findInnerFunctionBodyPath, findInnerIdentifier } from './hocUnwrap';
import {
  buildAssignmentStmt,
  buildHooksGetterStmt,
  queueHooksAssignment,
  queueHooksGetter,
} from './inject';
import { type PluginOptions, type PluginPassWithQueue } from './types';

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
        const opts = (state.opts ?? {}) as PluginOptions;
        const separator = opts.separator ?? ':';
        const shortFile = getShortFile(state.filename);

        // Component: capitalized name + (JSX in body OR hook calls in body).
        // The hook-call branch covers components that legitimately return
        // null / non-JSX values — portal-like, context-only, or
        // imperative-handle wrappers. Under the Rules of Hooks, only
        // components and custom hooks may call hooks, so a capitalized
        // function that calls them is unambiguously a component.
        if (isCapitalized(id.name) && (bodyUsesJSX(bodyPath) || bodyCallsHook(bodyPath, t))) {
          const hooks = collectHooksInBody(bodyPath, t, shortFile, separator);
          queueHooksAssignment(pluginState, path, id.name, hooks);
          return;
        }

        // Custom hook: name matches use[A-Z] + body calls at least one hook.
        if (isCustomHookName(id.name) && bodyCallsHook(bodyPath, t)) {
          const hooks = collectHooksInBody(bodyPath, t, shortFile, separator);
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

        const shortFile = getShortFile(state.filename);
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

        const opts = (state.opts ?? {}) as PluginOptions;
        const separator = opts.separator ?? ':';
        const shortFile = getShortFile(state.filename);

        // Component: capitalized + (JSX in body OR hook calls). Same
        // rationale as FunctionDeclaration above — Rules of Hooks pin a
        // capitalized hook-calling function to "component", so JSX is
        // sufficient but not necessary (covers `return null` portals).
        if (isCapitalized(id.name) && (bodyUsesJSX(bodyPath) || bodyCallsHook(bodyPath, t))) {
          const hooks = collectHooksInBody(bodyPath, t, shortFile, separator);
          const statement = path.getStatementParent();
          if (!statement) return;
          queueHooksAssignment(pluginState, statement, id.name, hooks);
          return;
        }

        // Custom hook: use[A-Z] + body calls hooks.
        if (isCustomHookName(id.name) && bodyCallsHook(bodyPath, t)) {
          const hooks = collectHooksInBody(bodyPath, t, shortFile, separator);
          const statement = path.getStatementParent();
          if (!statement) return;
          queueHooksAssignment(pluginState, statement, id.name, hooks);
        }
      },
    },
  };
}
