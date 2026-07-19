import { transformSync } from '@babel/core';
import { describe, expect, it } from 'vitest';

import stripPlugin from '@/babel/stripPlugin';

const transform = (code: string, options: Record<string, unknown> = {}): string => {
  const result = transformSync(code, {
    babelrc: false,
    configFile: false,
    filename: '/repo/src/App.tsx',
    parserOpts: { plugins: ['jsx', 'typescript'] },
    plugins: [[stripPlugin, options]],
  });
  return result?.code ?? '';
};

describe('stripPlugin', () => {
  it('removes react-native-mcp-kit imports (root and subpaths), keeping others', () => {
    const out = transform(
      [
        "import { McpProvider, useMcpTool } from 'react-native-mcp-kit';",
        "import { navigationModule } from 'react-native-mcp-kit/modules';",
        "import { View } from 'react-native';",
      ].join('\n')
    );
    expect(out).not.toContain('react-native-mcp-kit');
    expect(out).toContain("import { View } from 'react-native';");
  });

  it('removes require() forms including their variable declarations', () => {
    const out = transform(
      ["const kit = require('react-native-mcp-kit');", "const rn = require('react-native');"].join(
        '\n'
      )
    );
    expect(out).not.toContain('kit');
    expect(out).toContain("require('react-native')");
  });

  it('unwraps McpProvider into its children inside a JSX parent', () => {
    const out = transform(
      [
        'const App = () => (',
        '  <View>',
        '    <McpProvider modules={mods}>',
        '      <Screen />',
        '      <Footer />',
        '    </McpProvider>',
        '  </View>',
        ');',
      ].join('\n')
    );
    expect(out).not.toContain('McpProvider');
    expect(out).toContain('<Screen />');
    expect(out).toContain('<Footer />');
  });

  it('replaces a single-child McpProvider directly in expression context', () => {
    const out = transform('const App = () => <McpProvider><Screen /></McpProvider>;');
    expect(out).not.toContain('McpProvider');
    expect(out).toContain('const App = () => <Screen />;');
  });

  it('wraps multiple children in a fragment when the parent is not JSX', () => {
    const out = transform('const App = () => <McpProvider><A /><B /></McpProvider>;');
    expect(out).not.toContain('McpProvider');
    expect(out).toContain('<><A /><B /></>');
  });

  it('removes an McpProvider with no real children entirely', () => {
    const out = transform('const el = <View><McpProvider>  </McpProvider></View>;');
    expect(out).not.toContain('McpProvider');
    expect(out).toContain('<View></View>');
  });

  it('removes useMcpTool / useMcpModule call statements', () => {
    const out = transform(
      [
        'const App = () => {',
        "  useMcpTool({ name: 'logout' });",
        '  useMcpModule(navigationModule(nav));',
        '  return <View />;',
        '};',
      ].join('\n')
    );
    expect(out).not.toContain('useMcpTool');
    expect(out).not.toContain('useMcpModule');
    expect(out).toContain('return <View />;');
  });

  it('removes data-mcp-id attributes but keeps other props', () => {
    const out = transform('const el = <View data-mcp-id="View:App:1" testID="keep" />;');
    expect(out).not.toContain('data-mcp-id');
    expect(out).toContain('testID="keep"');
  });

  it('removes __mcp_hooks metadata assignments', () => {
    const out = transform('Card.__mcp_hooks = [{ name: "count", kind: "State" }];');
    expect(out).not.toContain('__mcp_hooks');
  });

  it('strips additionalSources imports on top of the defaults', () => {
    const out = transform(
      [
        "import { extras } from '@acme/mcp-extras';",
        "import { tool } from '@acme/mcp-extras/tools';",
        "import { useMcpTool } from 'react-native-mcp-kit';",
        "import { View } from 'react-native';",
      ].join('\n'),
      { additionalSources: ['@acme/mcp-extras'] }
    );
    expect(out).not.toContain('@acme/mcp-extras');
    expect(out).not.toContain('react-native-mcp-kit');
    expect(out).toContain("import { View } from 'react-native';");
  });
});

describe('stripPlugin — McpClient calls', () => {
  it('removes McpClient method-call statements and declarations initialized from them', () => {
    const out = transform(
      [
        'McpClient.initialize({ port: 8082 });',
        'const client = McpClient.initialize({ port: 8082 });',
        'const inst = McpClient.getInstance();',
        "console.log('keep');",
      ].join('\n')
    );
    expect(out).not.toContain('McpClient');
    expect(out).not.toContain('client');
    expect(out).not.toContain('inst');
    expect(out).toContain("console.log('keep');");
  });

  it('removes chained McpClient.getInstance().registerModule(...) statements', () => {
    const out = transform('McpClient.getInstance().registerModule(navigationModule(nav));');
    expect(out.trim()).toBe('');
  });
});

describe('stripPlugin — mcp-kit method-name list', () => {
  it('removes statement-level listed method calls on any receiver', () => {
    // The receiver is not verified against McpClient: any statement-level
    // method call whose name is on the registerModule/registerModules/
    // registerTool/dispose/enableDebug list is stripped, including same-named
    // methods of unrelated objects (actual behavior — no origin tracking).
    const out = transform(
      [
        'client.registerModule(navModule);',
        'client.registerModules([a, b]);',
        'client.registerTool(tool);',
        'subscription.dispose();',
        'logger.enableDebug();',
        'subscription.unsubscribe();',
      ].join('\n')
    );
    expect(out).not.toContain('registerModule');
    expect(out).not.toContain('registerTool');
    expect(out).not.toContain('dispose');
    expect(out).not.toContain('enableDebug');
    expect(out).toContain('subscription.unsubscribe();');
  });

  it('keeps listed method calls whose result is consumed', () => {
    const out = transform('const result = client.registerTool(tool);');
    expect(out).toContain('const result = client.registerTool(tool);');
  });

  it('keeps bare calls to a local function that shares a listed method name', () => {
    // Only member calls go through the method-name list; a plain identifier
    // call is gated by the function-name list (useMcpTool & co), so a local
    // registerModule helper survives.
    const out = transform(
      ['function registerModule(m) { return m; }', 'registerModule(x);'].join('\n')
    );
    expect(out).toContain('function registerModule(m)');
    expect(out).toContain('registerModule(x);');
  });
});

describe('stripPlugin — additionalFunctions option', () => {
  it('strips additionalFunctions call statements on top of the defaults', () => {
    const out = transform(
      ['initMyMcp({ port: 1 });', 'initMcp({});', 'setupAnalytics();'].join('\n'),
      { additionalFunctions: ['initMyMcp'] }
    );
    expect(out).not.toContain('initMyMcp');
    expect(out).not.toContain('initMcp({})');
    expect(out).toContain('setupAnalytics();');
  });

  it('keeps identifier calls whose result is consumed even when name-listed', () => {
    // The identifier-call branch only removes ExpressionStatement parents;
    // a declarator-consumed call survives (actual behavior).
    const out = transform("const tool = useMcpTool({ name: 't' });");
    expect(out).toContain('useMcpTool');
  });
});
