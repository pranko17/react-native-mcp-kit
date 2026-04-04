import { type PluginObj, type types as BabelTypes } from '@babel/core';

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

export default function testIdPlugin({ types: t }: { types: typeof BabelTypes }): PluginObj {
  return {
    name: 'react-native-mcp-test-id',
    visitor: {
      JSXOpeningElement(path, state) {
        const opts = (state.opts ?? {}) as PluginOptions;
        const attrName = opts.attr ?? DEFAULT_ATTR;
        const separator = opts.separator ?? ':';
        const exclude = opts.exclude ?? DEFAULT_EXCLUDE;
        const include = opts.include;

        // Get component name
        const nameNode = path.node.name;
        let componentName: string;

        if (t.isJSXIdentifier(nameNode)) {
          componentName = nameNode.name;
        } else if (t.isJSXMemberExpression(nameNode)) {
          componentName = `${(nameNode.object as BabelTypes.JSXIdentifier).name}.${nameNode.property.name}`;
        } else {
          return;
        }

        // Skip lowercase elements
        if (componentName[0] === componentName[0]?.toLowerCase()) return;

        // Check include/exclude
        if (include && !include.includes(componentName)) return;
        if (exclude.includes(componentName)) return;

        // Get file info
        const filename = state.filename ?? 'unknown';
        const relativePath = filename.includes('/src/')
          ? (filename.split('/src/').pop() ?? filename)
          : (filename.split('/').pop() ?? filename);
        const shortFile = relativePath.replace(/\.(tsx?|jsx?)$/, '');
        const line = path.node.loc?.start.line ?? 0;

        const generatedId = `${componentName}${separator}${shortFile}${separator}${line}`;

        // Check if attr already exists
        const existingAttr = path.node.attributes.find((attr) => {
          return t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name, { name: attrName });
        });

        if (existingAttr && t.isJSXAttribute(existingAttr)) {
          // Augment existing value with file:line
          if (t.isStringLiteral(existingAttr.value)) {
            const existing = existingAttr.value.value;
            existingAttr.value = t.stringLiteral(
              `${existing}${separator}${shortFile}${separator}${line}`
            );
          }
          return;
        }

        // Add attribute
        path.node.attributes.push(
          t.jsxAttribute(t.jsxIdentifier(attrName), t.stringLiteral(generatedId))
        );
      },
    },
  };
}
