# react-native-mcp-kit

**See, drive, and debug a running React Native app from an AI agent.**

Wire it in once, and any agent that speaks the [Model Context Protocol](https://modelcontextprotocol.io) — Claude Code, Cursor, Continue, your own — can look inside your running app and act on it: read the component tree without screenshots and OCR, tail logs and network traffic, inspect navigation / Redux / React Query state, and fire real taps and keystrokes through the OS gesture pipeline.

```
AI Agent / Cursor / Claude Code --stdio/MCP--> Node server --WebSocket--> RN app (device)
                                                    │
                                                    └─ host tools (adb / xcrun / ios-hid) --USB/sim--> device
```

Nothing here ships to your users: the production babel plugin strips every trace of the library from release bundles.

## What you can do with it

- **Ask questions about the live app.** "What screen am I on?", "what did the last POST return?", "why is this list empty?" — the agent cross-references the mounted UI, navigation state, network log, and errors in one pass. No rebuild, no extra `console.log`, no DevTools tab.
- **Hand over a bug ticket.** The agent drives the app into the failing state with real taps, confirms the bug, fixes the source, and replays the same steps to verify — in one editor session.
- **Automate flows without a test harness.** "Sign in, create a document, share it, verify the recipient sees it, screenshot the result" — described in plain language, executed through the real touch pipeline, asserted on real state.
- **Check platforms side by side.** iOS simulator, Android emulator, and a physical device can attach at once; one broadcast call runs the same step everywhere and hands back the differences.
- **Expose your own debug points.** A component can register an ad-hoc tool from its own lifecycle (`useMcpTool`) — feature-flag reads, "force this loading state" actions — without shipping a debug menu.

## Quick start

### 1. Install

```bash
yarn add react-native-mcp-kit
```

Peer dependencies: `react >= 19`, `react-native >= 0.79`, `react-native-device-info >= 10` (device-info is optional — without it the `device` module just reports fewer fields).

### 2. Wrap the app in `McpProvider`

```tsx
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { McpProvider } from 'react-native-mcp-kit';

const navigationRef = createNavigationContainerRef();

export const App = () => {
  return (
    <McpProvider
      // Each prop opts a module in — omit what you don't use:
      navigationRef={navigationRef} // → navigation module
      queryClient={queryClient} // → query module
      store={store} // → redux module
      storages={[{ name: 'mmkv', adapter: mmkvAdapter }]} // → storage module
      i18n={i18nInstance} // → i18n module
    >
      <NavigationContainer ref={navigationRef}>{/* your app */}</NavigationContainer>
    </McpProvider>
  );
};
```

`alert`, `console`, `device`, `errors`, `log_box`, `network`, and `fiber_tree` register automatically — no props needed. If a dependency lives deeper in the tree (say, the `QueryClient` is created inside a feature provider), skip the prop and call `useMcpModule` there instead — see [Your own tools](#your-own-tools).

### 3. Add the babel plugins

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

- **test-id-plugin** (dev) stamps every component with a stable `data-mcp-id="Name:file:line"` and records hook names — this is what lets the agent say "the second `ListItem` on line 76" and read `isLoading` instead of `State[3]`.
- **strip-plugin** (prod) removes everything: the provider, the hooks, the imports, the stamped attributes. You don't need `if (__DEV__)` guards in your code.

After editing babel config or upgrading the package, reset Metro's cache once: `yarn start --reset-cache`.

### 4. Point your agent at the server

The MCP server ships as a bin in the package. For Claude Code / Cursor, a project-local `.mcp.json`:

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

Flags: `--port <number>` (WebSocket port the app connects to, default `8347`), `--no-host` (in-app tools only, no device control).

Android emulators need the adb port forward once per boot: `adb reverse tcp:8347 tcp:8347`. iOS simulators share localhost — nothing to do.

### 5. Run it

Start Metro and the app; the provider connects on mount (and silently retries until the server appears). A first agent session looks like:

```
host__connection_status
 → { clientCount: 1, clients: [{ id: "ios-1", label: "iPhone 17 Pro", ... }] }

fiber_tree__query { steps: [{ scope: "root" }], select: [{ children: 5 }] }
 → the mounted component tree
```

## How the agent sees it

Every tool — in-app module tools, your `useMcpTool` registrations, and device-level host tools — is a first-class MCP tool with a real schema in the agent's catalog. The catalog updates live: connect a second device and its tools appear; unmount a screen that registered a tool and it disappears.

Three things worth knowing:

- **`clientId` routes everything.** Every tool takes an optional `clientId`. With one app connected you never pass it; with several, pass `"ios-1"`, a `/regex/`, or an array — the latter two broadcast the call to every match and aggregate per-client results.
- **`wait_until` and `assert` replace sleep-and-screenshot.** `wait_until` polls any tool until a predicate over its result holds; `assert` is the single-shot checkpoint version. For UI waits, `fiber_tree__query` has `waitFor: { until: "appear" | "disappear", stable? }` built in.
- **Responses are projection-first.** Heavy JSON collapses into compact `${...}` markers with `path` / `depth` / `maxBytes` knobs on every listing tool — the agent drills into `[-1:][0].response.body` instead of receiving a 50KB dump.

## Device control (host tools)

Enabled by default; runs on the machine hosting the server via `adb` / `xcrun` / a bundled `ios-hid` binary. Works even when the app is hung, not launched, or mid-reload.

- **Real input** — `tap`, `long_press`, `swipe`, `drag`, `type_text`, `type_text_batch`, `press_key`; `tap_fiber` finds a component via fiber_tree and taps its center in one call. iOS input is injected through the bundled `ios-hid` binary (no external daemons); Android goes through adb.
- **Screenshots** — WebP, resized to keep vision-token cost low, with `region` cropping and an `unchanged: true` short-circuit for polling. Works on simulators, emulators, Android devices, and **physical iOS 17+ devices** (over Apple's CoreDevice tunnel — no extra tooling).
- **App lifecycle** — `launch_app` / `terminate_app` / `restart_app`. Simulators use `simctl`; real iOS devices go through `devicectl` (restart is one `--terminate-existing` call; bare terminate isn't possible there — the tool says so).
- **Device listing** — sims, emulators, and devices, annotated with which ones have a live MCP client attached.

Real-device iOS **input** isn't supported yet (screenshots are) — use a simulator or Android for tap automation.

## Metro tools

A separate module that talks to the Metro instance each app was bundled from — the URL is auto-detected per client at handshake, so non-default ports and LAN devices just work.

- `metro__symbolicate` — raw Hermes/V8 stack → source paths. `errors__get_errors` and `log_box__get_logs` return `stackFrames` ready to feed in.
- `metro__reload` — full JS reload on every attached app.
- `metro__get_events` — ring buffer over Metro's event stream; catches silent HMR failures when no red box appears.
- `metro__status`, `metro__open_in_editor` — ping and jump-to-line.

## In-app modules

| Module       | What the agent gets                                                                        |
| ------------ | ------------------------------------------------------------------------------------------ |
| `fiber_tree` | Search and read the component tree — the heart of UI inspection ([details](#fiber_tree))   |
| `navigation` | Current route (+ rendering component), state, history; navigate / pop / reset / go_back    |
| `network`    | fetch + XHR log with redaction: method, URL, status, duration, headers, bodies             |
| `console`    | Ring buffer over console.* with stacks and monotonic ids                                   |
| `errors`     | Unhandled errors + promise rejections, stacks pre-parsed for symbolication                 |
| `redux`      | State tree reads + dispatch                                                                |
| `query`      | React Query cache: list, read by key, invalidate / refetch / remove / reset                |
| `storage`    | Named key-value stores (MMKV, AsyncStorage, anything with a `get`)                         |
| `device`     | Platform facts: dimensions, appearance, battery, memory; open_url / vibrate / reload       |
| `i18n`       | i18next: keys, resources, search, translate, switch language                               |
| `log_box`    | Inspect / dismiss / mute the LogBox overlay (handy when a warning blocks a flow)           |
| `alert`      | Native Alert from the agent — returns which button was pressed                             |

Factories (`consoleModule(options?)`, `networkModule(options?)`, `storageModule(...stores)`, …) accept options where capture behaviour is tunable — buffer sizes, captured levels, redact lists, ignored URLs. The catalog carries every tool's full schema at runtime, so the sections below stay at the "what's there" level.

### fiber_tree

Search the tree with a chained `query`: each step narrows matches by criteria (`name`, `testID`, `mcpId`, `text`, `hasProps`, `props`, `not`, `any` — strings accept `/regex/flags`) within a scope (`descendants`, `children`, `parent`, `ancestors`, `siblings`, `self`, `root`, `screen`, `nearest_host`). Wrapper cascades (`PressableView → Pressable → View → RCTView`) collapse to the topmost so results don't drown in wrappers.

What you can select per match:

- `bounds` — physical pixels, feed them straight into `host__tap` (or use `host__tap_fiber` and skip the copy-paste);
- `props` — projected with its own `path` / `depth` / `maxBytes`;
- `hooks` — hook values **with source-recovered names** (`isLoading`, not `State[3]`), filterable by kind / name / call-site, resolved values on request, sensitive names auto-redacted. Works through `memo` / `forwardRef` / custom HOC chains and library hooks (react-query, react-redux, reanimated);
- `children` — a light recursive tree dump (`select: [{ children: 5 }]` from `scope: 'root'` is the canonical "show me everything" call);
- `refMethods` — native-ref methods (`focus`, `scrollTo`, …) callable via `fiber_tree__call({ method })`; `fiber_tree__call({ prop: 'onPress' })` invokes callback props directly when the gesture pipeline is unwanted.

Every hook entry and every stamped component carries an `mcpId` of the form `Name:file:line` — the agent can jump from a running component straight to its source line.

## Your own tools

Register an ad-hoc tool from any component — it lives and dies with the component:

```tsx
const EditorScreen = ({ draft }) => {
  useMcpTool(
    'get_current_draft',
    () => ({
      description: 'Snapshot of the draft currently open in the editor.',
      handler: () => ({ id: draft.id, title: draft.title, wordCount: draft.wordCount }),
    }),
    [draft]
  );
  // ...
};
```

Or a whole module (several tools sharing a dependency):

```ts
import { type McpModule } from 'react-native-mcp-kit';
import { z } from 'zod';

const sessionModule = (auth: AuthApi): McpModule => ({
  name: 'session',
  description: 'Auth session inspection and control',
  tools: {
    switch_account: {
      description: 'Switch to another test account by id',
      handler: async (args) => auth.switchTo(String(args.accountId)),
      inputSchema: z.looseObject({ accountId: z.string() }),
      timeout: 5000, // per-tool, default 10s
    },
  },
});

// at the root:
<McpProvider modules={[sessionModule(auth)]}>...</McpProvider>
// or from a component that owns the dependency:
useMcpModule(() => sessionModule(auth), [auth]);
```

Both hooks follow `useMemo` / `useEffect` semantics: the factory re-runs on dep changes, registration cleans up on unmount, and the agent's catalog follows along.

`inputSchema` is a Zod schema (serialized to JSON Schema for the wire). Two habits pay off: use `z.looseObject` so undeclared args still reach your handler, and advertise defaults with `.meta({ default })` rather than `.default()` — the schema guides the agent, your handler stays the source of truth. Write descriptions that name the *task* ("snapshot of the draft open in the editor"), not the implementation — that's what the agent's semantic tool search matches against.

## Testing your app

Unit tests shouldn't load the real client (it opens a WebSocket and lazy-requires react-native). The package ships a complete no-op mock:

```js
// jest config
moduleNameMapper: { '^react-native-mcp-kit$': 'react-native-mcp-kit/jest' }
```

Provider renders children, hooks no-op, factories return empty modules — fully type-compatible.

## Production builds

With the strip-plugin in your production babel env, release bundles contain no trace of the library: no provider, no hooks, no stamped attributes, no imports. Dev bundles keep everything and connect automatically. There is nothing to guard, toggle, or remember at release time.

## Troubleshooting

- **Agent sees no in-app tools** → check `host__connection_status`. No clients? The app isn't reaching the server: Android emulator missing `adb reverse tcp:8347 tcp:8347`, or the app was started before the server and hasn't retried yet (it retries every 3s — give it a moment).
- **`hooks` come back as `null` names** → Metro served a cached transform without the plugin. `yarn start --reset-cache` once.
- **`Port 8347 is already in use`** → the server names the process holding the port (usually a stale server from a previous session) — kill it, or pass `--port`.
- **`Client protocol vN does not match server vM`** → the app bundle and the server come from different package versions. Update the lagging side; the wire format is versioned deliberately so a skew fails loudly instead of degrading quietly.
- **Catalog feels stale after an app reload** → re-check `host__connection_status`; tools follow client connections live, but your MCP client may need a moment to refresh.

## API reference

`<McpProvider />` owns the client singleton — you rarely need `McpClient` directly. For advanced embedding it exposes `McpClient.initialize(options)` / `getInstance()` / `registerModule(s)` / `unregisterModule(s)` / `registerTool` / `unregisterTool` / `dispose` / `enableDebug` (idempotent; `initialize` returns the existing instance on repeat calls). Pass `debug` to the provider for color-coded logs of every request and response.

```ts
interface McpModule {
  name: string;
  description?: string;
  tools: Record<string, ToolHandler>;
}

interface ToolHandler {
  description: string;
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
  inputSchema?: ZodType; // z.looseObject({...}) — serialized to JSON Schema for the wire
  timeout?: number; // ms, default 10s
}
```

## License

MIT
