# `src/jest/` — Jest mock for consumers

[`index.ts`](index.ts) is the no-op mock shipped at the `react-native-mcp-kit/jest` subpath (see `exports` in `package.json`). Consumers point jest at it so unit tests never load the real client (which opens a WebSocket and lazy-requires react-native):

```js
jest.mock('react-native-mcp-kit', () => require('react-native-mcp-kit/jest'));
// or: moduleNameMapper: { '^react-native-mcp-kit$': 'react-native-mcp-kit/jest' }
```

## Design constraints

- **No runtime `react` / `react-native` import.** The mock ships inside `dist/`, so if it required peer deps they'd fail to resolve from the lib's folder — the very breakage it exists to avoid. `McpProvider` therefore just returns `props.children` (no `createElement`), and `McpContext` is a hand-rolled `{ Consumer, Provider }` stub. `dist/jest/index.js` must stay `require()`-free — verify after build.
- **Full type-compliance, zero maintenance drift.** Every export is typed against the real public API via `type Api = typeof import('@/index')` (the one `import()`-type annotation, with a targeted `consistent-type-imports` eslint-disable — it's erased at runtime, unlike a value import which would drag the real client in). Add a new public export to `src/index.ts` → tsc here flags the missing stub.
- **Valid returns only where a caller needs one:** provider → children, factories → `{ name, tools: {} }` under the registered name, `registerModule`/`registerModules` → a disposer, `McpClient.initialize`/`getInstance` → an instance. Everything else is a no-op.

## Consumer gotcha — `link:` / symlinked dev

An npm-installed package is ignored by the default `transformIgnorePatterns`, so the compiled CJS runs as-is. A `link:`-ed package's real path is **outside** `node_modules`, so jest babel-transforms its `dist` and then can't resolve `@babel/runtime` from the lib folder. Consumers add the linked dist to `transformIgnorePatterns` (e.g. `'react-native-mcp-kit/dist/'`) so the compiled output isn't re-transformed. Documented in the README "Testing" section.
