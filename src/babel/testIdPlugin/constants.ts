export const DEFAULT_ATTR = 'data-mcp-id';

export const DEFAULT_EXCLUDE = [
  'Fragment',
  'React.Fragment',
  'React.StrictMode',
  'React.Suspense',
  'StrictMode',
  'Suspense',
];

// Map of built-in React hook names → agent-friendly `kind` labels. Anything
// matching the hook-name detector (`use` exact or `/^use[A-Z]/`) that is
// NOT in this table is treated as "Custom".
//
// react-dom-only hooks (`useFormStatus`, `useFormState`) are intentionally
// omitted — this library targets React Native, where neither exists.
export const HOOK_KIND: Record<string, string> = {
  use: 'Use',
  useActionState: 'ActionState',
  useCallback: 'Callback',
  useContext: 'Context',
  useDebugValue: 'DebugValue',
  useDeferredValue: 'DeferredValue',
  useEffect: 'Effect',
  useId: 'Id',
  useImperativeHandle: 'ImperativeHandle',
  useInsertionEffect: 'InsertionEffect',
  useLayoutEffect: 'LayoutEffect',
  useMemo: 'Memo',
  useOptimistic: 'Optimistic',
  useReducer: 'Reducer',
  useRef: 'Ref',
  useState: 'State',
  useSyncExternalStore: 'SyncExternalStore',
  useTransition: 'Transition',
};

// Hook-name detector. Accepts `use` exact (React 19's `use(promise|context)`)
// AND the classic `use[A-Z]\w*` pattern.
export const HOOK_NAME_RE = /^use([A-Z]|$)/;

// For the MemberExpression form (`X.use(...)`) we need to filter out
// unrelated method calls — `database.use(middleware)`, `app.use(router)` etc.
// Allow only object names that look like React-namespace bindings: literal
// `React` / `react` and the common bundler-mangled forms (`_react`,
// `_React2`, `_react3`, …). Same heuristic for any hook, but matters most
// for bare `use` whose name is otherwise too generic to disambiguate.
export const REACT_NAMESPACE_RE = /^_?[Rr]eact\d*$/;
