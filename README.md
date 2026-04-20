# react-native-mcp-kit

**See, drive, and debug a running React Native app from an AI agent.**

`react-native-mcp-kit` connects a running RN app (on simulator, emulator, or physical device) to any process that speaks the [Model Context Protocol](https://modelcontextprotocol.io). You wrap your app in one provider, add a babel plugin, point your AI tool at a small Node server that ships with the package, and every interesting thing inside the app becomes addressable: component trees, navigation state, network traffic, React Query cache, logs, errors, translations, storage — plus the OS gesture pipeline (taps, swipes, text input, screenshots) via a bundled binary that runs with zero external daemons.

```
AI Agent / Cursor / Claude Code --stdio/MCP--> Node server --WebSocket--> RN app (device)
                                                    │
                                                    └─ host tools (adb / xcrun / ios-hid) --USB/sim--> device
```

## Why would I want this?

A few concrete scenarios this unlocks:

- **End-to-end automation without a separate test harness.** Describe a multi-step flow in natural language — "sign in, open settings, flip the notifications toggle, verify the confirmation toast" — and an agent walks it: locates components by name/testID, fires real taps through the OS gesture pipeline, asserts on the resulting state, and reports back.
- **Interactive inspection of a live app from your editor.** Ask "what screen am I on?", "what React Query keys are stale?", "what did the last POST return?", "which translation keys are missing in the current locale?" — no rebuild, no DevTools panel, no "add more logs and reload" loop.
- **Debug gesture-arbitration bugs that unit tests can't catch.** `host__tap` goes through the real iOS/Android touch pipeline, so issues like "the close button inside a horizontally-scrolling list swallows taps" surface naturally. `fiber_tree__invoke` bypasses the pipeline for the rare cases you want to call `onPress` directly.
- **Write your own tools from inside components.** `useMcpTool`/`useMcpState`/`useMcpModule` let a component expose a named state key or an ad-hoc tool. Agents can then read feature-flag state, force a particular loading scenario, or trigger an internal-only action without you shipping a debug menu.

Everything the library adds to your bundle is stripped in production builds via the companion babel plugin — so you can wire it up once and leave it in, without shipping it to users.

## Example scenarios

- **Reproduce a bug from a ticket, fix it, verify the fix.** The agent reads the reproduction steps, drives the app into the failing state through real taps and swipes, confirms the bug, edits the relevant source, then replays the same sequence to verify the fix — all in one editor session, no rebuilds between steps.
- **End-to-end flow narrated in plain language.** "Sign in, add an item to the cart, go through checkout, verify the total matches the expected value, screenshot the final screen, and give me a network traffic summary." The agent drives real taps, checks state at each step, snapshots the key screens, and hands back captured request counts / durations / errors as evidence.
- **Cross-platform parity check.** One agent holds two connected clients, runs the same tap sequence on iOS and Android in parallel, captures screenshots, and points out the differences — catches platform-specific regressions after an RN upgrade, shared-component refactor, or native change.
- **Implement a feature and verify it end-to-end.** Write the code, then hand the finished feature to the agent — it navigates to the affected screen, exercises the new controls, inspects component state and network calls, and confirms the expected behavior without you having to click through the simulator yourself.

## Install

```bash
yarn add react-native-mcp-kit
# or
npm install react-native-mcp-kit
```

**Peer dependencies**: `react >= 19`, `react-native >= 0.79`, `react-native-device-info >= 10`.

## Setup

Three pieces need to be wired up: the **provider** at the root of your RN app, a pair of **babel plugins** so components are identifiable and production builds stay clean, and the **MCP server** that the AI agent talks to.

### 1. Wrap the app in `McpProvider`

Put it at the root of the tree. Optional props opt specific modules in — omit a prop and that module isn't registered.

```tsx
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { McpProvider } from 'react-native-mcp-kit';

const navigationRef = createNavigationContainerRef();

export const App = () => {
  return (
    <McpProvider
      debug
      // Optional — each prop opts a module in:
      navigationRef={navigationRef} // → navigation module
      queryClient={queryClient} // → reactQuery module
      i18n={i18nInstance} // → i18next module
      storages={[{ name: 'mmkv', adapter: mmkvAdapter }]} // → storage module
    >
      <NavigationContainer ref={navigationRef}>{/* your app */}</NavigationContainer>
    </McpProvider>
  );
};
```

These modules register automatically on mount — no prop required:

`alert`, `console`, `device`, `errors`, `network`, `fiber_tree`

If the dependency lives deeper in the tree (e.g. the `QueryClient` is created inside a feature-specific provider), skip the prop and use `useMcpModule` there instead — see [Hooks](#hooks).

### 2. Babel plugins — why and how

Two plugins ship under `react-native-mcp-kit/babel`. You want both.

**`test-id-plugin`** — compiles every capitalized JSX element with a stable `data-mcp-id="ComponentName:path/to/file:line"` attribute. `fiber_tree` uses this attribute as an identifier that survives renders, minification, and refactors. Without the plugin you can still find components by `name` or `testID`, but mcpId is what makes "find the nth occurrence of `ComponentName` on a specific line" reliable across a large codebase. Run this in **development**.

**`strip-plugin`** — strips every trace of mcp-kit from a bundle: imports from `react-native-mcp-kit`, calls to `McpClient.*` / `useMcpState` / `useMcpTool` / `useMcpModule`, the `<McpProvider>` JSX wrapper (its children are preserved), and every `data-mcp-id` attribute. Run this in **production** and none of the library code reaches your users.

```js
// babel.config.js
module.exports = (api) => {
  return {
    presets: ['module:@react-native/babel-preset'],
    plugins: [
      __DEV__
        ? 'react-native-mcp-kit/babel/test-id-plugin'
        : 'react-native-mcp-kit/babel/strip-plugin',
    ],
  };
};
```

Both plugins accept options (attribute name, include/exclude lists, extra import sources, extra function names to strip) when you need to customize — pass them as the 2nd array element in the usual babel style. Defaults cover the common case.

After editing `babel.config.js`, clear Metro's cache once: `yarn start --reset-cache`.

### 3. Configure the MCP server

The MCP server is a Node process that brokers between your agent (stdio/MCP) and the RN app (WebSocket). It ships as a bin in the package — `npx react-native-mcp-kit` boots it.

Point your agent at it via the usual MCP config. For Claude Code / Cursor / Continue etc., a project-local `.mcp.json`:

```json
{
  "mcpServers": {
    "react-native-mcp-kit": {
      "command": "npx",
      "args": ["react-native-mcp-kit"]
    }
  }
}
```

**CLI flags:**

- `--port <number>` — WebSocket port the RN app connects to (default `8347`).
- `--no-host` — disable the host module (the server no longer exposes `host__tap`, `host__screenshot`, etc.). Use this when you only want in-app modules.

For **Android emulators** you need the adb port forward so the app can reach the server:

```bash
adb reverse tcp:8347 tcp:8347
```

iOS simulators share localhost with the host machine, no forwarding needed.

### 4. Run

Start Metro + your app. The `McpProvider` connects to `ws://localhost:8347` on mount. The agent calls `connection_status` to confirm; after that every tool is callable.

## `McpProvider` reference

```ts
interface McpProviderProps {
  children: ReactNode;
  debug?: boolean; // colored console logs for all MCP traffic
  navigationRef?: NavigationRef; // → navigationModule
  queryClient?: QueryClientLike; // → reactQueryModule
  i18n?: I18nLike; // → i18nextModule
  storages?: NamedStorage[]; // → storageModule(...storages)
  modules?: McpModule[]; // arbitrary extra modules
}
```

Wrap your whole app in it — every optional prop opts a module in when supplied.

## MCP server tools

The Node server exposes a small set of entry-point tools agents use directly — you don't register or configure them. `call` / `list_tools` / `describe_tool` / `connection_status` / `state_get` / `state_list` cover discovery and dispatch, plus two test-automation helpers: `wait_until` (poll a tool until a predicate holds, replacing screenshot-in-a-loop + sleep) and `assert` (single-shot checkpoint with a standardized diff on failure).

## Multi-client

One server can hold multiple RN clients at once — iOS simulator, Android emulator, physical device, any mix. Useful for driving iOS and Android builds of the same app in lockstep from a single agent session.

## Host tools (device-level control)

When the `host` module is enabled (the default), the server exposes tools that operate **on the host machine** — they run `adb` / `xcrun simctl` / a bundled `ios-hid` binary. These work even when the RN app is frozen, not launched yet, or between reloads.

What you get:

- **Real OS input** — `tap`, `long_press`, `swipe`, `drag`, `type_text`, `type_text_batch`, `press_key`. Goes through the real iOS/Android touch pipeline.
- **`tap_fiber`** — one call to locate a component via fiber_tree and tap its center. No copy-paste of bounds between calls.
- **Screenshots** — WebP, auto-diffing (`unchanged: true` on identical frames). Pass `region` in physical pixels to crop to a specific element and keep vision-token cost low.
- **App lifecycle** — launch, terminate, restart.
- **Device enumeration** — list sims / emulators / devices, annotated with active MCP clients.
- **Symbolication** — `symbolicate` resolves raw JS stack traces to source paths via Metro.

iOS input goes through a bundled `ios-hid` Swift binary that injects HID events directly into iOS Simulator via private frameworks — no external daemons to install or keep running.

## Hooks

For when the thing you want to expose lives deeper than `McpProvider`:

```ts
useMcpState(key, factory, deps)    // expose reactive state to the agent
useMcpTool(name, factory, deps)    // register an ad-hoc tool tied to the component lifecycle
useMcpModule(factory, deps)        // register a whole module from inside a component
```

Each follows `useMemo` / `useEffect` semantics — the factory re-runs on dep changes, registration cleans up on unmount.

```tsx
const UserProvider = ({ children }) => {
  const [user, setUser] = useState(null);

  useMcpState('user', () => ({ id: user?.id, loggedIn: user !== null }), [user]);

  useMcpTool('logout', () => ({
    description: 'Log out the current user',
    handler: async () => { await logout(); return { success: true }; },
  }), [logout]);

  return <UserContext.Provider value={user}>{children}</UserContext.Provider>;
};
```

## Modules

| Module                    | Factory                         | Requires                                  |
| ------------------------- | ------------------------------- | ----------------------------------------- |
| [alert](#alert)           | `alertModule()`                 | —                                         |
| [console](#console)       | `consoleModule(options?)`       | —                                         |
| [device](#device)         | `deviceModule()`                | —                                         |
| [errors](#errors)         | `errorsModule(options?)`        | —                                         |
| [fiber_tree](#fiber_tree) | `fiberTreeModule({ rootRef })`  | root ref (auto-supplied by `McpProvider`) |
| [i18n](#i18n)             | `i18nextModule(i18n)`           | i18next instance                          |
| [log_box](#log_box)       | `logBoxModule()`                | —                                         |
| [navigation](#navigation) | `navigationModule(ref)`         | React Navigation ref                      |
| [network](#network)       | `networkModule(options?)`       | —                                         |
| [query](#query)           | `reactQueryModule(queryClient)` | `QueryClient`                             |
| [storage](#storage)       | `storageModule(...storages)`    | one or more `NamedStorage`                |

The full tool list for every module is always available via `list_tools` at runtime — the sections below describe what each module gives you, not each tool.

### alert

Show a native `Alert.alert` from the agent with any combination of `default` / `cancel` / `destructive` buttons and get back which one was pressed. Useful for "are you sure?" prompts driven by the agent, or for surfacing a decision point to a human tester.

### console

Tails `console.log` / `warn` / `error` / `info` / `debug` into a ring buffer the agent can read or clear. Complex values (Errors, Dates, class instances, cyclic refs, functions, Symbols) are serialized safely. Buffer size, captured levels, and whether stack traces are collected are all configurable.

```ts
consoleModule({
  maxEntries: 200,
  levels: ['error', 'warn', 'log'],
  stackTrace: ['error', 'warn'], // or `true` / `false`
});
```

### device

Read-only view of platform facts (OS, version, dimensions in DP and physical pixels, pixel ratio, appearance, app state, accessibility settings, keyboard state) plus a few imperative actions — open URLs / settings, dismiss the keyboard, vibrate, reload the JS bundle in dev.

### errors

Captures unhandled JS errors (via `ErrorUtils.setGlobalHandler`) and unhandled promise rejections. Each entry has parsed `stackFrames` designed to feed into `metro__symbolicate` — one call resolves bundle paths back to `src/components/Foo.tsx:42:10`.

### fiber_tree

The heart of UI inspection. Search the component tree via a chained `query`: each step narrows the result with criteria (name / testID / mcpId / text / props matcher / not / any) and a scope (descendants / ancestors / siblings / screen / nearest_host / …). Wrapper cascades (`PressableView → Pressable → View → RCTView`) collapse to the topmost by default. `bounds` come back in physical pixels and pair directly with `host__tap` — or use `host__tap_fiber` for the locate-and-tap shortcut.

### i18n

Inspect and manipulate an `i18next` instance: list keys, dump a whole translation resource, run a substring search, translate with interpolation, switch language at runtime.

### log_box

Control the React Native LogBox overlay: inspect current rows, dismiss or clear them, add ignore patterns (substring or `/regex/flags`), globally mute. Useful for clearing warning toasts that block automated UI flows. Dev-only — no-op in production.

### navigation

Drive React Navigation from outside — navigate, push, pop, replace, reset — and read the current route, nested state, and the last 100 transitions. Current-route responses include a `screen` field identifying the rendering component (`componentName`, `mcpId`, `filePath`, `line`). Needs a `createNavigationContainerRef()` passed to both `<NavigationContainer ref={…}>` and `<McpProvider navigationRef={…}>`.

### network

Intercepts `fetch` and `XMLHttpRequest` into a ring buffer — method, URL, status, duration, headers, bodies. Bodies are capped per-entry (default 20KB) and sensitive headers / body keys are redacted at capture time (`Authorization`, `Cookie`, `password`, `token`, etc. — configurable). Query tools strip body data by default; fetch a specific body via `get_body({ id })`. WebSocket, Metro, and symbolicate traffic are auto-ignored.

```ts
networkModule({
  maxEntries: 200,
  bodyMaxBytes: 10_000,
  ignoreUrls: ['https://analytics.example.com', /\.png$/],
  redactHeaders: ['authorization'], // or false to disable
  redactBodyKeys: ['password'],     // or false to disable
});
```

### query

React Query cache inspection: list cached queries, fetch cached data by key, get stats, and run `invalidate` / `refetch` / `remove` / `reset` against specific keys or the whole cache.

### storage

Reads and writes to one or more named key-value stores. Each store is a `{ name, adapter }` pair; the adapter can wrap MMKV, AsyncStorage, or any custom implementation that provides at least a `get`:

```ts
interface StorageAdapter {
  get(key: string): string | undefined | null | Promise<string | undefined | null>;
  set?(key: string, value: string): void | Promise<void>;
  delete?(key: string): void | Promise<void>;
  getAllKeys?(): string[] | Promise<string[]>;
}

storageModule(
  { name: 'mmkv', adapter: mmkvAdapter },
  { name: 'async', adapter: asyncStorageAdapter }
);
```

Without an `adapter.set` / `delete` / `getAllKeys`, the corresponding tools just report the operation as unsupported.

## Custom modules

Write your own module by returning an `McpModule`:

```ts
import { type McpModule } from 'react-native-mcp-kit';

const myModule = (): McpModule => ({
  name: 'myModule',
  description: 'Custom tools exposed to AI agents',
  tools: {
    greet: {
      description: 'Returns a greeting',
      handler: async (args) => ({ message: `Hello, ${args.name}!` }),
      inputSchema: { name: { type: 'string' } },
      timeout: 5000, // optional per-tool timeout, default 10s
    },
  },
});

<McpProvider modules={[myModule()]}>{…}</McpProvider>
// or
useMcpModule(() => myModule(), []);
```

Agents see the module + its tools in `list_tools` and call them via `call(tool: "myModule__greet")`.

## Dev vs production

- **Development** — test-id plugin on, strip plugin off. The `McpProvider` boots, tries to connect to `ws://localhost:8347`; if the server isn't running, no harm done — the bridge just stays disconnected and retries.
- **Production** — strip plugin on (test-id plugin off). The provider, all hook calls, every import from `react-native-mcp-kit`, and every `data-mcp-id` attribute vanish from the bundle. Nothing ships to users.

You don't need `if (__DEV__)` guards around mcp-kit usage — the babel plugin handles it.

## Debug logging

Pass `debug` to the provider to print every incoming request and outgoing response with color-coded module names and arrows. Logs use the pre-intercept `console.log`, so they never pollute the `console` module's buffer.

```tsx
<McpProvider debug>{…}</McpProvider>
```

## Local development (symlink / portal)

If you're developing the library next to an app and symlinking it in, Metro needs to know about the extra path:

```js
// metro.config.js
const path = require('path');
const mcpPath = path.resolve(__dirname, '../path-to/react-native-mcp-kit');

module.exports = {
  watchFolders: [mcpPath],
  resolver: {
    nodeModulesPaths: [
      path.resolve(__dirname, 'node_modules'),
      path.resolve(mcpPath, 'node_modules'),
    ],
  },
};
```

## API reference

The recommended entry point is `<McpProvider />` — it owns the client singleton and you rarely need to touch `McpClient` directly. For advanced cases the class exposes `McpClient.initialize` / `getInstance` / `registerModule(s)` / `registerTool` / `setState` / `removeState` / `dispose` / `enableDebug` (all idempotent, `initialize` returns the existing instance on repeat calls).

Module and tool types:

```ts
interface McpModule {
  name: string;
  description?: string;
  tools: Record<string, ToolHandler>;
}

interface ToolHandler {
  description: string;
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
  inputSchema?: Record<string, unknown>;
  timeout?: number; // default 10s
}
```

## License

MIT
