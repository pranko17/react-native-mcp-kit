import { type PluginItem, transformSync } from '@babel/core';
import { describe, expect, it } from 'vitest';

import testIdPlugin from '@/babel/testIdPlugin';

const transform = (
  code: string,
  options: Record<string, unknown> = {},
  filename = '/repo/src/components/Card.tsx'
): string => {
  const result = transformSync(code, {
    babelrc: false,
    configFile: false,
    filename,
    parserOpts: { plugins: ['jsx', 'typescript'] },
    plugins: [[testIdPlugin, options]],
  });
  return result?.code ?? '';
};

describe('testIdPlugin — data-mcp-id stamping', () => {
  it('stamps Name:file:line on capitalized JSX elements', () => {
    const out = transform(
      ['const Card = () => (', '  <View>', '    <Button title="ok" />', '  </View>', ');'].join(
        '\n'
      )
    );
    expect(out).toContain('data-mcp-id="View:components/Card:2"');
    expect(out).toContain('data-mcp-id="Button:components/Card:3"');
  });

  it('skips lowercase host elements and default excludes', () => {
    const out = transform('const Card = () => <view><Fragment><Thing /></Fragment></view>;');
    expect(out).toContain('data-mcp-id="Thing:');
    expect(out).not.toContain('data-mcp-id="view:');
    expect(out).not.toContain('data-mcp-id="Fragment:');
  });

  it('renders JSXMemberExpression names as Object.Property', () => {
    const out = transform('const Card = () => <Animated.View />;');
    expect(out).toContain('data-mcp-id="Animated.View:components/Card:1"');
  });

  it('appends to an existing string-literal attribute instead of overwriting', () => {
    const out = transform('const Card = () => <View data-mcp-id="custom" />;');
    expect(out).toContain('data-mcp-id="custom:components/Card:1"');
  });

  it('falls back to the basename when the path has no /src/ segment', () => {
    const out = transform('const Card = () => <View />;', {}, '/elsewhere/Card.tsx');
    expect(out).toContain('data-mcp-id="View:Card:1"');
  });

  it('honours custom attr and separator options', () => {
    const out = transform('const Card = () => <View />;', { attr: 'testID', separator: '|' });
    expect(out).toContain('testID="View|components/Card|1"');
    expect(out).not.toContain('data-mcp-id');
  });
});

describe('testIdPlugin — __mcp_hooks metadata', () => {
  it('attaches hook metadata to a function-declaration component', () => {
    const out = transform(
      [
        'function Card() {',
        '  const [count, setCount] = useState(0);',
        '  useEffect(() => {}, []);',
        '  return <View />;',
        '}',
      ].join('\n')
    );
    expect(out).toContain('Card.__mcp_hooks = [');
    expect(out).toContain('name: "count"');
    expect(out).toContain('kind: "State"');
    expect(out).toContain('hook: "useState"');
    expect(out).toContain('mcpId: "count:components/Card:2"');
    // Naked useEffect gets a positional per-kind name.
    expect(out).toContain('name: "effect:0"');
    expect(out).toContain('kind: "Effect"');
    // The assignment is guarded against stale bindings.
    expect(out).toContain('try {');
  });

  it('attaches hook metadata to a custom hook', () => {
    const out = transform(
      [
        'const useCounter = () => {',
        '  const [count, setCount] = useState(0);',
        '  return count;',
        '};',
      ].join('\n')
    );
    expect(out).toContain('useCounter.__mcp_hooks = [');
    expect(out).toContain('mcpId: "count:components/Card:2"');
  });

  it('records an fn reference for module-scoped custom hook calls', () => {
    const out = transform(
      [
        "import { useAuth } from './auth';",
        'const Profile = () => {',
        '  const auth = useAuth();',
        '  return <View />;',
        '};',
      ].join('\n')
    );
    expect(out).toContain('Profile.__mcp_hooks = [');
    expect(out).toContain('kind: "Custom"');
    expect(out).toContain('fn: useAuth');
  });

  it('installs a forwarding getter for identifier-ref HOC wrapping', () => {
    const out = transform(
      [
        'const Inner = () => {',
        '  const [v, setV] = useState(1);',
        '  return <View />;',
        '};',
        'const Outer = memo(Inner);',
      ].join('\n')
    );
    expect(out).toContain('Inner.__mcp_hooks = [');
    expect(out).toContain('Object.defineProperty(Outer, "__mcp_hooks"');
    expect(out).toContain('() => Inner.__mcp_hooks');
  });

  it('leaves plain capitalized helpers without JSX or hooks untouched', () => {
    const out = transform('const Helper = () => 42;\nfunction Calc() { return 1; }');
    expect(out).not.toContain('__mcp_hooks');
  });
});

describe('testIdPlugin — inline-HOC component forms', () => {
  it('attaches hook metadata to an exported memo(inline arrow) component', () => {
    const out = transform(
      [
        'export const Card = memo(() => {',
        '  const [count, setCount] = useState(0);',
        '  return <View />;',
        '});',
      ].join('\n')
    );
    expect(out).toContain('Card.__mcp_hooks = [');
    expect(out).toContain('name: "count"');
    expect(out).toContain('kind: "State"');
    expect(out).toContain('mcpId: "count:components/Card:2"');
  });

  it('attaches hook metadata through a nested memo(forwardRef(inline)) chain', () => {
    const out = transform(
      [
        'const Input = memo(forwardRef((props, ref) => {',
        '  const [value, setValue] = useState("");',
        '  useImperativeHandle(ref, () => ({}));',
        '  return <TextInput />;',
        '}));',
      ].join('\n')
    );
    expect(out).toContain('Input.__mcp_hooks = [');
    expect(out).toContain('name: "value"');
    expect(out).toContain('kind: "State"');
    // Naked useImperativeHandle gets a positional per-kind name.
    expect(out).toContain('name: "imperativehandle:0"');
    expect(out).toContain('kind: "ImperativeHandle"');
  });
});

describe('testIdPlugin — TS-cast unwrapping', () => {
  it('unwraps declarator-level casts around an inline HOC wrap', () => {
    const out = transform(
      [
        'const Card = memo((props: CardProps) => {',
        '  const [v, setV] = useState(1);',
        '  return <View />;',
        '}) as unknown as CardComponent;',
      ].join('\n')
    );
    expect(out).toContain('Card.__mcp_hooks = [');
    expect(out).toContain('mcpId: "v:components/Card:2"');
  });

  it('installs the forwarding getter through a declarator-level cast on memo(Inner)', () => {
    const out = transform(
      [
        'const Inner = () => {',
        '  const [v, setV] = useState(1);',
        '  return <View />;',
        '};',
        'const Outer = memo(Inner) as ComponentType;',
      ].join('\n')
    );
    expect(out).toContain('Inner.__mcp_hooks = [');
    expect(out).toContain('Object.defineProperty(Outer, "__mcp_hooks"');
    expect(out).toContain('() => Inner.__mcp_hooks');
  });

  it('does not unwrap a cast inside the HOC argument: memo(Inner as T)', () => {
    // The cast unwrap runs on the declarator init only; the HOC-chain walk
    // steps through assignments/sequences but not TS casts, so the chain
    // dead-ends at the TSAsExpression and Outer gets no forwarding getter.
    // Inner still receives its own metadata.
    const out = transform(
      [
        'const Inner = () => {',
        '  const [v, setV] = useState(1);',
        '  return <View />;',
        '};',
        'const Outer = memo(Inner as ComponentType);',
      ].join('\n')
    );
    expect(out).toContain('Inner.__mcp_hooks = [');
    expect(out).not.toContain('Object.defineProperty');
  });

  it('does not treat comma-expression memo forms as a HOC chain', () => {
    // (0, memo)(fn): the SequenceExpression callee fails the HOC-callee check.
    // (0, memo(fn)): the declarator init itself is a SequenceExpression, which
    // the body resolution never unwraps (the sequence step-through only runs
    // inside an already-recognized call chain). JSX stamping is independent
    // of the metadata pass and still applies.
    const outCallee = transform(
      [
        'const Card = (0, memo)(() => {',
        '  const [v, setV] = useState(1);',
        '  return <View />;',
        '});',
      ].join('\n')
    );
    expect(outCallee).not.toContain('__mcp_hooks');
    expect(outCallee).toContain('data-mcp-id="View:components/Card:3"');

    const outInit = transform(
      [
        'const Card = (0, memo(() => {',
        '  const [v, setV] = useState(1);',
        '  return <View />;',
        '}));',
      ].join('\n')
    );
    expect(outInit).not.toContain('__mcp_hooks');
  });
});

describe('testIdPlugin — include option', () => {
  it('stamps only components listed in include', () => {
    const out = transform('const Card = () => <View><Button /></View>;', { include: ['Button'] });
    expect(out).toContain('data-mcp-id="Button:components/Card:1"');
    expect(out).not.toContain('data-mcp-id="View:');
  });

  it('keeps default excludes even when listed in include', () => {
    const out = transform('const Card = () => <Fragment><Button /></Fragment>;', {
      include: ['Button', 'Fragment'],
    });
    expect(out).toContain('data-mcp-id="Button:');
    expect(out).not.toContain('data-mcp-id="Fragment:');
  });
});

describe('testIdPlugin — member-expression hook calls', () => {
  it('collects namespaced and bundler-mangled member hook calls', () => {
    const out = transform(
      [
        'const Card = () => {',
        '  const [count, setCount] = React.useState(0);',
        '  const ref = _react.default.useRef(null);',
        '  return <View />;',
        '};',
      ].join('\n')
    );
    expect(out).toContain('Card.__mcp_hooks = [');
    expect(out).toContain('hook: "useState"');
    expect(out).toContain('kind: "State"');
    expect(out).toContain('hook: "useRef"');
    expect(out).toContain('kind: "Ref"');
    expect(out).toContain('mcpId: "ref:components/Card:3"');
  });

  it('accepts bare use() member calls only under a React-like namespace', () => {
    const out = transform(
      [
        'const Card = () => {',
        '  const data = React.use(promise);',
        '  const mw = database.use(middleware);',
        '  return <View />;',
        '};',
      ].join('\n')
    );
    expect(out).toContain('name: "data"');
    expect(out).toContain('kind: "Use"');
    expect(out).not.toContain('name: "mw"');
  });
});

describe('testIdPlugin — pre-existing __mcp_hooks assignments', () => {
  it('appends its own assignment after a manual one without deduplication', () => {
    // No cross-pass idempotency guard: dedupe only covers entries queued
    // within a single transform. A manual (or previously generated)
    // assignment is left as-is and the generated one lands later in the
    // program body, so it wins at runtime via plain last-write semantics.
    const out = transform(
      [
        'const Card = () => {',
        '  const [v, setV] = useState(1);',
        '  return <View />;',
        '};',
        "Card.__mcp_hooks = [{ name: 'manual', kind: 'State', hook: 'useState' }];",
      ].join('\n')
    );
    const occurrences = out.split('Card.__mcp_hooks = [').length - 1;
    expect(occurrences).toBe(2);
    expect(out.indexOf('manual')).toBeLessThan(out.indexOf('mcpId: "v:components/Card:2"'));
  });
});

describe('testIdPlugin — fragment-like guards beyond the name list', () => {
  it('skips an aliased Fragment import from react', () => {
    const out = transform(
      [
        "import { Fragment as F } from 'react';",
        'const List = () => (',
        '  <F>',
        '    <Row />',
        '  </F>',
        ');',
      ].join('\n')
    );
    expect(out).not.toContain('data-mcp-id="F:');
    expect(out).toContain('data-mcp-id="Row:');
  });

  it('skips Fragment-like members under any namespace', () => {
    const out = transform(
      [
        "import * as R from 'react';",
        'const List = () => (',
        '  <R.Fragment>',
        '    <R.Suspense fallback={null}>',
        '      <Row />',
        '    </R.Suspense>',
        '  </R.Fragment>',
        ');',
      ].join('\n')
    );
    expect(out).not.toContain('data-mcp-id="R.Fragment');
    expect(out).not.toContain('data-mcp-id="R.Suspense');
    expect(out).toContain('data-mcp-id="Row:');
  });

  it('still stamps a same-named alias that does not come from react', () => {
    const out = transform(
      [
        "import { Fragment as F } from 'my-ui-kit';",
        'const List = () => (',
        '  <F>',
        '    <Row />',
        '  </F>',
        ');',
      ].join('\n')
    );
    expect(out).toContain('data-mcp-id="F:');
  });

  it('guards a component prop whose destructuring default is a fragment-like', () => {
    // @gorhom/bottom-sheet BottomSheetModal.tsx pattern. The stamp becomes a
    // runtime-conditional spread: present when a real component is injected,
    // absent when the Fragment default kicks in.
    const out = transform(
      [
        'const Sheet = ({ containerComponent: ContainerComponent = React.Fragment }) => (',
        '  <ContainerComponent key="k">',
        '    <Row />',
        '  </ContainerComponent>',
        ');',
      ].join('\n')
    );
    expect(out).not.toContain('data-mcp-id="ContainerComponent:');
    expect(out).toContain('typeof ContainerComponent === "symbol" ? null :');
    expect(out).toContain('"data-mcp-id": "ContainerComponent:');
    expect(out).toContain('data-mcp-id="Row:');
  });

  it('guards a bare param default of Fragment', () => {
    const out = transform('const List = (C = Fragment) => <C><Row /></C>;');
    expect(out).not.toContain('data-mcp-id="C:');
    expect(out).toContain('typeof C === "symbol" ? null :');
    expect(out).toContain('"data-mcp-id": "C:');
    expect(out).toContain('data-mcp-id="Row:');
  });

  it('guards a body-destructured prop whose default is a fragment-like', () => {
    const out = transform(
      [
        'const Sheet = (props) => {',
        '  const { container: Container = React.Fragment } = props;',
        '  return <Container><Row /></Container>;',
        '};',
      ].join('\n')
    );
    expect(out).not.toContain('data-mcp-id="Container:');
    expect(out).toContain('typeof Container === "symbol" ? null :');
    expect(out).toContain('"data-mcp-id": "Container:');
    expect(out).toContain('data-mcp-id="Row:');
  });

  it('guards a variable that can resolve to Fragment through a ternary', () => {
    // react-native-network-logger Icon.tsx pattern: the TouchableOpacity
    // branch keeps its id, the Fragment branch stays silent.
    const out = transform(
      [
        "import { Fragment } from 'react';",
        'const Icon = ({ onPress }) => {',
        '  const Wrapper = onPress ? TouchableOpacity : Fragment;',
        '  return <Wrapper><Row /></Wrapper>;',
        '};',
      ].join('\n')
    );
    expect(out).not.toContain('data-mcp-id="Wrapper:');
    expect(out).toContain('typeof Wrapper === "symbol" ? null :');
    expect(out).toContain('"data-mcp-id": "Wrapper:');
    expect(out).toContain('data-mcp-id="Row:');
  });

  it('still stamps injected component props without a fragment default', () => {
    const out = transform('const Layout = ({ Header }) => <Header title="x" />;');
    expect(out).toContain('data-mcp-id="Header:');
  });

  it('still stamps a param default that is a real component', () => {
    const out = transform('const Card = ({ Slot = DefaultSlot }) => <Slot />;');
    expect(out).toContain('data-mcp-id="Slot:');
  });

  it('still stamps a variable aliasing a real component through a ternary', () => {
    const out = transform(
      [
        'const Row = ({ pressable }) => {',
        '  const Wrapper = pressable ? Pressable : View;',
        '  return <Wrapper />;',
        '};',
      ].join('\n')
    );
    expect(out).toContain('data-mcp-id="Wrapper:');
  });
});

describe('testIdPlugin — remaining declarator-cast variants', () => {
  it('unwraps a satisfies cast around an inline HOC wrap', () => {
    // TSSatisfiesExpression is part of the declarator cast-unwrap loop, so
    // `memo(...) satisfies T` behaves exactly like the `as` form: metadata
    // attaches to the outer binding.
    const out = transform(
      [
        'const Card = memo((props: CardProps) => {',
        '  const [v, setV] = useState(1);',
        '  return <View />;',
        '}) satisfies CardComponent;',
      ].join('\n')
    );
    expect(out).toContain('Card.__mcp_hooks = [');
    expect(out).toContain('mcpId: "v:components/Card:2"');
  });

  it('unwraps a non-null assertion around an inline HOC wrap', () => {
    // TSNonNullExpression is also handled by the cast-unwrap loop —
    // `memo(...)!` attaches metadata like the uncast form.
    const out = transform(
      [
        'const Card = memo((props: CardProps) => {',
        '  const [v, setV] = useState(1);',
        '  return <View />;',
        '})!;',
      ].join('\n')
    );
    expect(out).toContain('Card.__mcp_hooks = [');
    expect(out).toContain('mcpId: "v:components/Card:2"');
  });
});

describe('testIdPlugin — Program:exit dedupe', () => {
  it('emits one assignment when same-named components live in different scopes', () => {
    // The deferred-injection queue dedupes by outer name. Same-named
    // components in different scopes both queue an entry for "Card"; the
    // first (module-scope) one wins and the nested one is dropped — the
    // end-of-body assignment could only reference the top-level binding
    // anyway.
    const out = transform(
      [
        'const Card = () => {',
        '  const [outerV, setOuterV] = useState(1);',
        '  return <View />;',
        '};',
        'function helper() {',
        '  const Card = () => {',
        '    const [innerV, setInnerV] = useState(2);',
        '    return <Text />;',
        '  };',
        '  return Card;',
        '}',
      ].join('\n')
    );
    const occurrences = out.split('Card.__mcp_hooks = [').length - 1;
    expect(occurrences).toBe(1);
    expect(out).toContain('name: "outerV"');
    expect(out).not.toContain('name: "innerV"');
  });
});

describe('testIdPlugin — legacy angle-bracket assertion (TSTypeAssertion)', () => {
  it('unwraps a declarator-level <T> assertion around an inline HOC wrap', () => {
    // `<T>expr` only parses with the plain 'typescript' parser plugin — under
    // 'jsx' the angle bracket reads as a JSX opening tag — so this transform
    // drops 'jsx' from parserOpts, and the component body has to hit the
    // hook-call branch (return null) instead of containing JSX. Actual
    // behavior: TSTypeAssertion sits in the declarator cast-unwrap loop, so
    // the assertion unwraps exactly like the `as` form and metadata attaches.
    const result = transformSync(
      [
        'const Card = <CardComponent>memo(() => {',
        '  const [v, setV] = useState(1);',
        '  return null;',
        '});',
      ].join('\n'),
      {
        babelrc: false,
        configFile: false,
        filename: '/repo/src/components/Card.ts',
        parserOpts: { plugins: ['typescript'] },
        plugins: [testIdPlugin],
      }
    );
    const out = result?.code ?? '';
    expect(out).toContain('Card.__mcp_hooks = [');
    expect(out).toContain('mcpId: "v:components/Card:2"');
  });
});

describe('testIdPlugin — react-refresh interop', () => {
  // react-refresh/babel ships no type declarations — require() keeps tsc
  // happy without an ambient module stub.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, import/no-extraneous-dependencies
  const reactRefreshPlugin = require('react-refresh/babel') as PluginItem;

  const componentCode = [
    'const Card = () => {',
    '  const [count, setCount] = useState(0);',
    '  return <View />;',
    '};',
  ].join('\n');

  const transformWithPlugins = (plugins: PluginItem[]): string => {
    const result = transformSync(componentCode, {
      babelrc: false,
      configFile: false,
      filename: '/repo/src/components/Card.tsx',
      parserOpts: { plugins: ['jsx', 'typescript'] },
      plugins,
    });
    return result?.code ?? '';
  };

  const expectBothPluginsApplied = (out: string): void => {
    expect(out).toContain('data-mcp-id="View:components/Card:3"');
    expect(out).toContain('Card.__mcp_hooks = [');
    expect(out).toContain('$RefreshSig$');
    expect(out).toContain('$RefreshReg$');
  };

  it('coexists with react-refresh registered after it', () => {
    expectBothPluginsApplied(
      transformWithPlugins([[testIdPlugin], [reactRefreshPlugin, { skipEnvCheck: true }]])
    );
  });

  it('coexists with react-refresh registered before it', () => {
    expectBothPluginsApplied(
      transformWithPlugins([[reactRefreshPlugin, { skipEnvCheck: true }], [testIdPlugin]])
    );
  });
});
