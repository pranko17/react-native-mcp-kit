import { type PluginObj, type types as BabelTypes } from '@babel/core';

import { PACKAGE_NAME } from '@/shared/protocol';

interface PluginOptions {
  /** Additional function names to strip */
  additionalFunctions?: string[];
  /** Additional import sources to strip */
  additionalSources?: string[];
}

const DEFAULT_SOURCES = [PACKAGE_NAME];

const DEFAULT_FUNCTIONS = ['useMcpTool', 'useMcpModule', 'initMcp'];

export default function stripPlugin({ types: t }: { types: typeof BabelTypes }): PluginObj {
  return {
    name: 'react-native-mcp-kit-strip',
    visitor: {
      // Remove `X.__mcp_hooks = [...]` metadata assignments emitted by the
      // companion test-id-plugin (X is either a component or a custom-hook
      // function name).
      AssignmentExpression(path) {
        const { left } = path.node;
        if (!t.isMemberExpression(left)) return;
        if (!t.isIdentifier(left.property, { name: '__mcp_hooks' })) return;
        const parent = path.parentPath;
        if (parent.isExpressionStatement()) {
          parent.remove();
        }
      },

      // Remove require('react-native-mcp-kit')
      CallExpression(path, state) {
        const opts = (state.opts ?? {}) as PluginOptions;
        const sources = [...DEFAULT_SOURCES, ...(opts.additionalSources ?? [])];
        const functions = [...DEFAULT_FUNCTIONS, ...(opts.additionalFunctions ?? [])];

        // Strip require('react-native-mcp') or require('react-native-mcp/...')
        if (
          t.isIdentifier(path.node.callee, { name: 'require' }) &&
          path.node.arguments.length === 1 &&
          t.isStringLiteral(path.node.arguments[0])
        ) {
          const source = path.node.arguments[0].value;
          if (
            sources.some((s) => {
              return source === s || source.startsWith(`${s}/`);
            })
          ) {
            // Remove the entire variable declaration if it's `const x = require(...)`
            const parent = path.parentPath;
            if (parent.isVariableDeclarator()) {
              const declaration = parent.parentPath;
              if (declaration.isVariableDeclaration()) {
                declaration.remove();
                return;
              }
            }
            // Otherwise remove the expression statement
            if (parent.isExpressionStatement()) {
              parent.remove();
            }
          }
        }

        // Strip function calls: useMcpTool(...), useMcpModule(...), etc.
        if (t.isIdentifier(path.node.callee) && functions.includes(path.node.callee.name)) {
          const parent = path.parentPath;
          if (parent.isExpressionStatement()) {
            parent.remove();
          }
        }

        // Strip method calls: McpClient.initialize(...), McpClient.getInstance()...
        if (
          t.isMemberExpression(path.node.callee) &&
          t.isIdentifier(path.node.callee.object, { name: 'McpClient' })
        ) {
          const parent = path.parentPath;
          // client.registerModules(...) — chained on variable
          if (parent.isExpressionStatement()) {
            parent.remove();
            return;
          }
          // const client = McpClient.initialize(...)
          if (parent.isVariableDeclarator()) {
            const declaration = parent.parentPath;
            if (declaration.isVariableDeclaration()) {
              declaration.remove();
            }
          }
        }

        // Strip client.registerModule(...), client.registerModules(...)
        if (
          t.isMemberExpression(path.node.callee) &&
          t.isIdentifier(path.node.callee.property) &&
          ['registerModule', 'registerModules', 'registerTool', 'dispose', 'enableDebug'].includes(
            path.node.callee.property.name
          )
        ) {
          // Check if the object is a variable that was assigned from McpClient
          const parent = path.parentPath;
          if (parent.isExpressionStatement()) {
            parent.remove();
          }
        }
      },

      // Remove imports from react-native-mcp
      ImportDeclaration(path, state) {
        const opts = (state.opts ?? {}) as PluginOptions;
        const sources = [...DEFAULT_SOURCES, ...(opts.additionalSources ?? [])];
        const source = path.node.source.value;

        if (
          sources.some((s) => {
            return source === s || source.startsWith(`${s}/`);
          })
        ) {
          path.remove();
        }
      },

      // Remove data-mcp-id JSX attributes
      JSXAttribute(path) {
        if (t.isJSXIdentifier(path.node.name, { name: 'data-mcp-id' })) {
          path.remove();
        }
      },

      // Replace <McpProvider>{children}</McpProvider> with just {children}.
      // The node parent may be JSX (children can sit as siblings) or an
      // expression (arrow body / return / paren — must yield exactly one
      // expression). JSXText whitespace and JSXExpressionContainer wrappers
      // need to be normalised so the replacement is valid in either context.
      JSXElement(path) {
        const opening = path.node.openingElement;
        if (!t.isJSXIdentifier(opening.name, { name: 'McpProvider' })) return;

        const realChildren = path.node.children.filter((child) => {
          if (t.isJSXText(child)) return child.value.trim() !== '';
          return true;
        });

        if (realChildren.length === 0) {
          path.remove();
          return;
        }

        const parent = path.parent;
        const isJsxContext = t.isJSXElement(parent) || t.isJSXFragment(parent);
        if (isJsxContext) {
          path.replaceWithMultiple(realChildren);
          return;
        }

        if (realChildren.length === 1) {
          const [only] = realChildren;
          if (!only) return;
          // Unwrap {expr} back to expr in expression context — a bare
          // JSXExpressionContainer is not a valid expression outside JSX.
          if (t.isJSXExpressionContainer(only)) {
            if (t.isJSXEmptyExpression(only.expression)) {
              path.remove();
            } else {
              path.replaceWith(only.expression);
            }
            return;
          }
          path.replaceWith(only);
          return;
        }

        path.replaceWith(
          t.jsxFragment(t.jsxOpeningFragment(), t.jsxClosingFragment(), realChildren)
        );
      },
    },
  };
}
