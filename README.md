# react-native-mcp

A bidirectional [MCP](https://modelcontextprotocol.io/) bridge that connects AI agents to running React Native apps. The server is a proxy — all business logic runs inside your RN app.

```
AI Agent  --stdio/MCP-->  MCP Server (Node.js)  --WebSocket-->  RN App (device)
```

## Features

- **11 built-in modules** — navigation, fiber tree, screenshot, network, console, storage, device, errors, i18next, React Query, alerts
- **React fiber inspection** — walk the component tree, read props, invoke callbacks, call ref methods
- **Screenshots** — capture app screenshots via `@shopify/react-native-skia` with resize and JPEG compression
- **Developer hooks** — expose state and tools from any component with `useMcpState` and `useMcpTool`
- **Navigation history** — full log of screen transitions with timestamps and slice access
- **Modular** — register only the modules you need, or write your own with `description` for AI context
- **Zero production overhead** — Babel strip plugin removes all MCP code from prod builds
- **Babel testID plugin** — auto-adds `data-mcp-id` attributes for component identification

## Quick Start

### 1. Install

```bash
yarn add react-native-mcp
# or
npm install react-native-mcp
```

### 2. Initialize in your app

```typescript
import {
  McpClient,
  McpProvider,
  consoleModule,
  deviceModule,
  fiberTreeModule,
  navigationModule,
  networkModule,
  screenshotModule,
} from 'react-native-mcp';
import { createRef } from 'react';
import { View } from 'react-native';

const rootRef = createRef<View>();
const navigationRef = createNavigationContainerRef();

// Initialize client (call once, before any module registration)
const client = McpClient.initialize({ debug: true });

// Register modules
client.registerModules([
  consoleModule(),
  deviceModule(),
  fiberTreeModule({ rootRef }),
  navigationModule(navigationRef),
  networkModule(),
  screenshotModule({ rootRef }),
]);
```

### 3. Wrap your app with McpProvider

```tsx
const App = () => {
  return (
    <View ref={rootRef} collapsable={false} style={{ flex: 1 }}>
      <NavigationContainer ref={navigationRef}>
        <McpProvider>
          {/* your app */}
        </McpProvider>
      </NavigationContainer>
    </View>
  );
};
```

### 4. Configure the MCP server

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "react-native-mcp": {
      "command": "npx",
      "args": ["react-native-mcp"]
    }
  }
}
```

Or with a custom port:

```json
{
  "mcpServers": {
    "react-native-mcp": {
      "command": "npx",
      "args": ["react-native-mcp", "--port", "8347"]
    }
  }
}
```

### 5. Connect

1. Start Metro and run your app
2. The AI agent connects via MCP and can now inspect and interact with your app
3. For Android emulator, run `adb reverse tcp:8347 tcp:8347` to forward the port

## Modules

| Module | Factory | Description |
|--------|---------|-------------|
| [alert](#alert) | `alertModule()` | Show native alerts with custom buttons and styles |
| [fiberTree](#fibertree) | `fiberTreeModule({ rootRef })` | React fiber tree inspection, invoke callbacks, call ref methods |
| [console](#console) | `consoleModule(options?)` | Capture console.log/warn/error/info/debug |
| [device](#device) | `deviceModule()` | Device info, app state, keyboard, linking, reload |
| [errors](#errors) | `errorsModule(options?)` | Capture unhandled errors and promise rejections |
| [i18next](#i18next) | `i18nextModule(i18n)` | Translation inspection and language management |
| [navigation](#navigation) | `navigationModule(ref)` | Navigation state, history, navigate, push, pop, replace, reset |
| [network](#network) | `networkModule(options?)` | HTTP request/response interception |
| [reactQuery](#reactquery) | `reactQueryModule(queryClient)` | React Query cache inspection and management |
| [screenshot](#screenshot) | `screenshotModule({ rootRef })` | Capture screenshots via Skia |
| [storage](#storage) | `storageModule(...storages)` | Key-value storage inspection (MMKV, AsyncStorage, custom) |

---

### alert

Show native alert dialogs with custom buttons and styles.

```typescript
client.registerModules([alertModule()]);
```

| Tool | Description | Args |
|------|-------------|------|
| `show` | Show alert dialog | `title?: string`, `message?: string`, `buttons?: Button[]` |

Buttons can be strings or objects with style:

```typescript
// Simple
call(tool: "alert__show", args: '{"title": "Confirm", "buttons": ["Cancel", "OK"]}')

// With styles
call(tool: "alert__show", args: '{"title": "Delete?", "buttons": [{"text": "Cancel", "style": "cancel"}, {"text": "Delete", "style": "destructive"}]}')
```

Button styles: `default`, `cancel`, `destructive`. Returns `{ button: string, index: number }`. Timeout: 60s.

---

### fiberTree

React fiber tree inspection with the ability to invoke callbacks and call ref methods.

```typescript
client.registerModules([fiberTreeModule({ rootRef })]);
```

**Inspection tools:**

| Tool | Description | Args |
|------|-------------|------|
| `get_tree` | Get full component tree | `depth?: number` (default: 10) |
| `get_component` | Find a component | `name?`, `testID?`, `text?`, `mcpId?`, `within?`, `index?`, `depth?` |
| `find_all` | Find all matching components | `name?`, `testID?`, `text?`, `mcpId?`, `hasProps?`, `within?` |
| `get_props` | Get component props | same find params |
| `get_children` | Get component children | same find params, `depth?` |

**Interaction tools:**

| Tool | Description | Args |
|------|-------------|------|
| `invoke` | Call any callback prop | find params, `callback: string`, `args?: unknown[]` |
| `call_ref` | Call method on native ref | find params, `method: string`, `args?: unknown[]` |
| `get_ref_methods` | List available ref methods | find params |

**Finding components:**

Components can be found by `testID`, `name`, `text`, or `mcpId` (from the Babel testID plugin). Use `within` to scope the search to children of a specific component:

```typescript
// Find by testID
call(tool: "fiber_tree__get_component", args: '{"testID": "login-button"}')

// Find by name within a parent
call(tool: "fiber_tree__get_component", args: '{"name": "Pressable", "within": "LoginForm"}')

// Use index for multiple matches (0-based)
call(tool: "fiber_tree__get_component", args: '{"name": "TextInput", "within": "LoginForm", "index": 1}')

// Nested within path with index
call(tool: "fiber_tree__get_component", args: '{"name": "Text", "within": "Button:1/Pressable"}')
```

**Invoking callbacks:**

```typescript
// Press a button
call(tool: "fiber_tree__invoke", args: '{"testID": "submit-btn", "callback": "onPress"}')

// Type text
call(tool: "fiber_tree__invoke", args: '{"mcpId": "Input:screens/Login:42", "callback": "onChangeText", "args": ["user@example.com"]}')

// Toggle checkbox with custom args
call(tool: "fiber_tree__invoke", args: '{"name": "Checkbox", "within": "TermsForm", "callback": "onPress", "args": [true]}')
```

**Calling ref methods:**

```typescript
// Focus an input
call(tool: "fiber_tree__call_ref", args: '{"testID": "email-input", "method": "focus"}')

// List available methods
call(tool: "fiber_tree__get_ref_methods", args: '{"testID": "email-input"}')
```

---

### console

Intercepts console output with a ring buffer.

```typescript
client.registerModules([consoleModule()]);

// With options
client.registerModules([
  consoleModule({
    maxEntries: 200,
    levels: ['error', 'warn', 'log'],
    stackTrace: ['error', 'warn'],  // or true for all levels
  }),
]);
```

| Tool | Description | Args |
|------|-------------|------|
| `get_logs` | Get all logs | `level?: string`, `limit?: number` |
| `get_errors` | Get error logs | `limit?: number` |
| `get_warnings` | Get warning logs | `limit?: number` |
| `get_info` | Get info logs | `limit?: number` |
| `get_debug` | Get debug logs | `limit?: number` |
| `clear_logs` | Clear all logs | — |

Serializes complex values: functions, class instances, circular refs, Errors, Dates, RegExp, Symbols.

---

### device

Device info and system APIs.

```typescript
client.registerModules([deviceModule()]);
```

| Tool | Description | Args |
|------|-------------|------|
| `get_device_info` | Comprehensive device info (platform, dimensions, pixel ratio, appearance, dev mode) | — |
| `get_platform` | Platform (OS, version, constants) | — |
| `get_dimensions` | Screen and window dimensions | — |
| `get_pixel_ratio` | Pixel density and font scale | — |
| `get_appearance` | Color scheme (light/dark) | — |
| `get_app_state` | App state (active/background/inactive) | — |
| `get_accessibility_info` | Accessibility settings | — |
| `get_keyboard_state` | Keyboard visibility and metrics | — |
| `dismiss_keyboard` | Dismiss keyboard | — |
| `open_url` | Open URL in appropriate app | `url: string` |
| `can_open_url` | Check if URL can be opened | `url: string` |
| `get_initial_url` | Get deep link that launched app | — |
| `open_settings` | Open app settings | — |
| `reload` | Reload app (dev only) | — |
| `vibrate` | Vibrate device | `duration?: number` |

---

### errors

Captures unhandled JS errors and promise rejections.

```typescript
client.registerModules([errorsModule()]);

// With options
client.registerModules([errorsModule({ maxEntries: 100 })]);
```

| Tool | Description | Args |
|------|-------------|------|
| `get_errors` | Get captured errors | `source?: string`, `fatal?: boolean`, `limit?: number` |
| `get_fatal` | Get fatal errors only | `limit?: number` |
| `get_stats` | Error statistics | — |
| `clear_errors` | Clear all errors | — |

Error sources: `global` (ErrorUtils), `promise` (unhandled rejections). Deduplicates within 100ms window.

---

### i18next

Translation inspection and language management. Accepts an i18next instance.

```typescript
import i18n from './i18n';

client.registerModules([i18nextModule(i18n)]);
```

| Tool | Description | Args |
|------|-------------|------|
| `get_info` | Current language, available languages, namespaces | — |
| `get_resource` | Get full translation resource | `language?`, `namespace?` |
| `get_keys` | List translation keys | `language?`, `namespace?` |
| `translate` | Translate a key | `key: string`, `options?: string` (JSON) |
| `search` | Search keys and values | `query: string`, `language?` |
| `change_language` | Change current language | `language: string` |

```typescript
// Translate with interpolation
call(tool: "i18n__translate", args: '{"key": "welcome", "options": "{\"name\": \"John\"}"}')

// Search translations
call(tool: "i18n__search", args: '{"query": "password"}')
```

---

### navigation

Full navigation control with history tracking. Accepts a React Navigation ref.

```typescript
import { createNavigationContainerRef } from '@react-navigation/native';

const navigationRef = createNavigationContainerRef();

client.registerModules([navigationModule(navigationRef)]);
```

| Tool | Description | Args |
|------|-------------|------|
| `get_state` | Full navigation state tree | — |
| `get_current_route` | Current focused route | — |
| `get_current_route_state` | Current route with nested state | — |
| `get_history` | Log of all screen transitions | `offset?`, `limit?`, `full?: boolean` |
| `navigate` | Navigate to screen (reuses existing) | `screen: string`, `params?: object` |
| `push` | Push new screen onto stack | `screen: string`, `params?: object` |
| `pop` | Pop screens | `count?: number` |
| `pop_to` | Pop to specific screen | `screen: string`, `params?: object` |
| `pop_to_top` | Pop to first screen | — |
| `go_back` | Go back to previous screen | — |
| `replace` | Replace current screen | `screen: string`, `params?: object` |
| `reset` | Reset navigation state | `routes: Array<{name, params?}>`, `index?: number` |

**Navigation history:**

```typescript
// Get simplified history (name, key, params, timestamp)
call(tool: "navigation__get_history")

// Get last 5 transitions
call(tool: "navigation__get_history", args: '{"limit": 5}')

// Get full navigation state for each transition
call(tool: "navigation__get_history", args: '{"full": true}')

// Slice: skip first 10, get next 5
call(tool: "navigation__get_history", args: '{"offset": 10, "limit": 5}')
```

---

### network

Intercepts `fetch` and `XMLHttpRequest`. Captures request/response bodies, headers, status, duration.

```typescript
client.registerModules([networkModule()]);

// With options
client.registerModules([
  networkModule({
    maxEntries: 200,
    includeBodies: true,
    ignoreUrls: ['https://analytics.example.com', /\.png$/],
  }),
]);
```

| Tool | Description | Args |
|------|-------------|------|
| `get_requests` | Get captured requests | `method?`, `status?`, `url?`, `limit?` |
| `get_request` | Find requests by URL substring | `url: string` |
| `get_pending` | Get in-flight requests | — |
| `get_errors` | Get failed requests | `limit?: number` |
| `get_stats` | Request statistics | — |
| `clear_requests` | Clear captured requests | — |

Auto-ignores WebSocket, Metro, and symbolicate URLs.

---

### reactQuery

React Query cache inspection and management. Accepts a `QueryClient` instance.

```typescript
import { QueryClient } from '@tanstack/react-query';

const queryClient = new QueryClient();

client.registerModules([reactQueryModule(queryClient)]);
```

| Tool | Description | Args |
|------|-------------|------|
| `get_queries` | List all cached queries | `status?`, `key?` (substring) |
| `get_data` | Get cached data for a query | `key: string` (JSON format) |
| `get_stats` | Cache statistics | — |
| `invalidate` | Invalidate queries (mark stale) | `key?: string` |
| `refetch` | Refetch queries | `key?: string` |
| `remove` | Remove from cache | `key?: string` |
| `reset` | Reset to initial state | `key?: string` |

```typescript
// Get data for a specific query
call(tool: "query__get_data", args: '{"key": "[\"users\",\"list\"]"}')

// Invalidate all user queries
call(tool: "query__invalidate", args: '{"key": "users"}')
```

---

### screenshot

Capture screenshots of the app via `@shopify/react-native-skia`. Requires Skia as a peer dependency.

```bash
yarn add @shopify/react-native-skia
```

```typescript
import { createRef } from 'react';
import { View } from 'react-native';

const rootRef = createRef<View>();

client.registerModules([screenshotModule({ rootRef })]);

// JSX — rootRef must have collapsable={false}
<View ref={rootRef} collapsable={false} style={{ flex: 1 }}>
  {/* app */}
</View>
```

| Tool | Description | Args |
|------|-------------|------|
| `capture` | Capture screenshot | `format?: 'jpeg'\|'png'`, `quality?: number`, `maxWidth?: number` |

Default: JPEG, quality 80, max width 600px (height scales proportionally). Images are resized via `Skia.Surface.Make` + `drawImageRectOptions` for optimal size.

```typescript
// Default (JPEG, 600px wide)
call(tool: "screenshot__capture")

// High quality PNG
call(tool: "screenshot__capture", args: '{"format": "png", "quality": 100}')

// Smaller image
call(tool: "screenshot__capture", args: '{"maxWidth": 400, "quality": 50}')
```

---

### storage

Key-value storage inspection. Supports multiple named storage instances with flexible adapters.

```typescript
// Single storage
client.registerModules([
  storageModule({ name: 'app', adapter: myStorageAdapter }),
]);

// Multiple storages
client.registerModules([
  storageModule(
    { name: 'app', adapter: appStorage },
    { name: 'cache', adapter: cacheStorage },
  ),
]);
```

**Adapter interface** — only `get` is required:

```typescript
interface StorageAdapter {
  get(key: string): string | undefined | null | Promise<string | undefined | null>;
  set?(key: string, value: string): void | Promise<void>;
  delete?(key: string): void | Promise<void>;
  getAllKeys?(): string[] | Promise<string[]>;
}
```

| Tool | Description | Args |
|------|-------------|------|
| `get_item` | Get value by key | `key: string`, `storage?: string` |
| `set_item` | Set value | `key: string`, `value: string`, `storage?: string` |
| `delete_item` | Delete key | `key: string`, `storage?: string` |
| `list_keys` | List all keys | `storage?: string` |
| `get_all` | Get all key-value pairs | `storage?: string` |
| `list_storages` | List registered storages | — |

Works with MMKV, AsyncStorage, or any custom adapter.

## Hooks

Hooks let you expose state and tools from React components.

### useMcpState

Expose reactive state to the AI agent:

```typescript
useMcpState(
  key: string,
  factory: () => unknown,
  deps: DependencyList
): void
```

```typescript
const UserProvider = ({ children }) => {
  const [user, setUser] = useState(null);

  useMcpState(
    'user',
    () => ({
      email: user?.email,
      id: user?.id,
      loggedIn: user !== null,
    }),
    [user]
  );

  // ...
};
```

The agent reads state via `state_get` and `state_list` tools — no WebSocket roundtrip needed.

### useMcpTool

Register a dynamic tool from a component:

```typescript
useMcpTool(
  name: string,
  factory: () => ToolHandler,
  deps: DependencyList
): void
```

```typescript
const UserProvider = ({ children }) => {
  const logout = useCallback(() => { /* ... */ }, []);

  useMcpTool(
    'logout',
    () => ({
      description: 'Log out the current user',
      handler: () => {
        logout();
        return { success: true };
      },
    }),
    [logout]
  );

  // ...
};
```

Dynamic tools are accessible via `call(tool: "_dynamic_logout")` and appear in `list_tools` with a `(dynamic)` label.

### useMcpModule

Register a full module from a component (tied to component lifecycle):

```typescript
useMcpModule(
  factory: () => McpModule,
  deps: DependencyList
): void
```

```typescript
const App = () => {
  const queryClient = useQueryClient();

  useMcpModule(
    () => reactQueryModule(queryClient),
    [queryClient]
  );

  // ...
};
```

## Babel Plugins

### testIdPlugin

Auto-adds `data-mcp-id` attributes to JSX components for reliable component identification.

```javascript
// babel.config.js
module.exports = {
  plugins: [
    ['react-native-mcp/babel/test-id-plugin', {
      attr: 'data-mcp-id',       // attribute name (default)
      separator: ':',             // separator (default)
      exclude: ['Fragment'],      // components to skip
      include: ['Button', 'Input'], // if set, only these get IDs
    }],
  ],
};
```

Generated ID format: `ComponentName:filePath:line`

```tsx
// Before
<LoginButton onPress={handleLogin} />

// After (dev build)
<LoginButton onPress={handleLogin} data-mcp-id="LoginButton:src/screens/Login:42" />
```

### stripPlugin

Removes all MCP code from production builds. Zero MCP code in the final bundle.

```javascript
// babel.config.js
module.exports = (api) => {
  const isDev = api.cache(() => process.env.NODE_ENV !== 'production');

  return {
    plugins: [
      isDev && ['react-native-mcp/babel/test-id-plugin'],
      !isDev && ['react-native-mcp/babel/strip-plugin'],
    ].filter(Boolean),
  };
};
```

**What it removes:**

- All imports from `react-native-mcp`
- `McpClient.initialize()`, `registerModule()`, `registerModules()` calls
- `useMcpState()`, `useMcpTool()`, `useMcpModule()` calls
- `<McpProvider>` JSX (replaced with children)
- `data-mcp-id` JSX attributes

With the strip plugin, you don't need `if (__DEV__)` guards — just write MCP code normally and it gets removed in production.

## Dev vs Production

Two strategies for production safety:

1. **Strip plugin** (Babel) — removes all MCP imports, calls, and JSX from the production bundle. No MCP code ships to users.
2. **Without strip plugin** — MCP code stays but WebSocket connection to non-existent server is harmless.

## MCP Server Tools

The server exposes 5 static tools (no dynamic registration needed):

| Tool | Description |
|------|-------------|
| `call` | Universal proxy — calls any tool registered by the RN app |
| `list_tools` | Lists all available tools grouped by module with descriptions |
| `connection_status` | Check if the RN app is connected |
| `state_get` | Read state exposed by `useMcpState` |
| `state_list` | List all available state keys |

**Using `call`:**

```
call(tool: "navigation__navigate", args: '{"screen": "Settings"}')
call(tool: "console__get_errors")
call(tool: "_dynamic_logout")
```

The `tool` argument uses `module__method` format (double underscore). Dynamic tools from `useMcpTool` use the `_dynamic_` prefix.

The server includes instructions and tool annotations to help AI agents understand how to interact with the app.

## Custom Modules

Create your own module by returning an `McpModule` object:

```typescript
import { type McpModule } from 'react-native-mcp';

const myModule = (): McpModule => {
  return {
    description: 'My custom module for AI agents',
    name: 'myModule',
    tools: {
      greet: {
        description: 'Returns a greeting',
        handler: async (args) => {
          const name = args.name as string;
          return { message: `Hello, ${name}!` };
        },
      },
      getStatus: {
        description: 'Get current status',
        handler: () => {
          return { status: 'ok', timestamp: Date.now() };
        },
        timeout: 5000, // custom timeout in ms (default: 10s)
      },
    },
  };
};

// Register
client.registerModules([myModule()]);
```

**Module registration methods:**

```typescript
// At init time
const client = McpClient.initialize();
client.registerModules([myModule()]);

// After init
McpClient.getInstance().registerModule(myModule());

// From a component (tied to lifecycle)
useMcpModule(() => myModule(), []);
```

## Debug Logging

Enable colored console output for all MCP communication:

```typescript
McpClient.initialize({ debug: true });
```

Output shows:

- `[rnmcp]` tag (bold purple)
- Colored module names (12 bold ANSI colors, assigned by registration order)
- Bold method names
- `→` incoming tool requests (cyan)
- `←` responses (green)
- `✕` errors (red)

Debug logs use the original `console.log` (captured before the console module intercepts), so they don't appear in the console module buffer.

## API Reference

### McpClient

```typescript
// Initialize (creates singleton)
static initialize(options?: { debug?: boolean; host?: string; port?: number }): McpClient

// Get existing instance (throws if not initialized)
static getInstance(): McpClient

// Module registration
registerModule(module: McpModule): void
registerModules(modules: McpModule[]): void

// Dynamic tools
registerTool(name: string, tool: ToolHandler): void
unregisterTool(name: string): void

// State
setState(key: string, value: unknown): void
removeState(key: string): void

// Lifecycle
dispose(): void
enableDebug(enabled: boolean): void
```

### McpModule

```typescript
interface McpModule {
  description?: string;
  name: string;
  tools: Record<string, ToolHandler>;
}
```

### ToolHandler

```typescript
interface ToolHandler {
  description: string;
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
  inputSchema?: Record<string, unknown>;
  timeout?: number; // per-tool timeout in ms (default: 10s)
}
```

## Symlink Setup (for local development)

If you're developing with the library linked locally via symlink/portal:

```javascript
// metro.config.js
const mcpPath = require('path').resolve(__dirname, '../path-to/react-native-mcp');

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

## License

MIT
