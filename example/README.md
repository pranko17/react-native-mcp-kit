# McpKitExample — `react-native-mcp-kit` showcase app

A small but complete React Native app that wires up **every** capability of
`react-native-mcp-kit` so you can point an AI agent at it and watch the whole
surface work end-to-end.

It is a tiny "demo shop + dev playground": browse products, fill a cart, flip
settings, and trigger side effects — every screen maps to one or more MCP
modules.

> This app lives inside the library repo and consumes the library through a
> local symlink (`"react-native-mcp-kit": "link:.."`), so it always exercises
> your working copy of `../`.

## What's wired

| Capability | Where in the app | Example tool calls |
| --- | --- | --- |
| `fiber_tree` | the entire UI; `ProductCard` has named hooks (`expanded`, `formattedPrice`, `handleAdd`) | `fiber_tree__query({ steps:[{scope:'root'}], select:[{children:5}] })` · query `name:"ProductCard"` + `select:["hooks"]` |
| `navigation` | bottom tabs + a Shop→Detail native stack | `navigation__get_state` · `navigation__navigate({screen:'ProductDetail', params:{id:1,title:'…'}})` |
| `query` (React Query) | **Shop** tab product list | `query__get_queries` · `query__get_data({key:["products",{limit:20}]})` · `query__mutate` |
| `network` | **Shop** fetches + **Tools** buttons | `network__get_requests({path:'[-1:]'})` |
| `redux` | **Cart** (cart slice) + **Settings** (counter/settings slices) | `redux__get_state` · `redux__dispatch({action:'{"type":"counter/increment"}'})` |
| `i18n` | **Settings** language picker (en/ru/es) | `i18n__change_language({language:'ru'})` · `i18n__translate({key:'home.title'})` |
| `storage` | **Settings** (3 named stores: `mmkv`, `async`, read-only `config`) | `storage__list_storages` · `storage__get_all({storage:'config'})` |
| `device` | **Settings** device card | `device__info({select:['identity','battery']})` · `device__vibrate` |
| `alert` | **Tools** → "Show native alert" | `alert__show({title:'?', buttons:[…]})` |
| `console` | **Tools** → log / warn / error / group | `console__get_logs` |
| `errors` | **Tools** → throw / reject | `errors__get_errors` → `metro__symbolicate` |
| `log_box` | **Tools** → trigger LogBox warning | `log_box__get_logs` · `log_box__dismiss` |
| `feature_flags` via **`useMcpModule`** | **Tools** → flag switches | `feature_flags__get_flags` · `feature_flags__set_flag` |
| `session_*` via **`useMcpTool`** | **Settings** → login/logout | `call("__dynamic__session_login", {name:'Ada'})` |
| `demo` custom module (`modules` prop) | global | `demo__app_info` · `demo__echo` · `demo__sum` |

The host (`host__tap`, `host__screenshot`, …) and Metro (`metro__reload`,
`metro__symbolicate`, …) tools come from the server and work against this app
like any other.

## Run it

Prereqs: the library must be built once (the example imports its `dist/`):

```bash
cd ..            # repo root
yarn build       # produces dist/ (incl. dist/bin/ios-hid) used by this app
cd example
```

Install + run (this folder is pinned to **yarn 1.22.22** via corepack):

```bash
# iOS
bundle install              # once, for CocoaPods
(cd ios && bundle exec pod install)
yarn ios                    # builds & launches on a simulator

# Android (emulator running)
adb reverse tcp:8347 tcp:8347   # so the app can reach the MCP server
yarn android
```

If `yarn` resolves to Berry (v3+) in your shell, force classic yarn:

```bash
COREPACK_ENABLE_AUTO_PIN=0 corepack yarn@1.22.22 ios
```

## Connect an agent

`.mcp.json` in this folder runs the **locally built** server (so it matches
your working copy of the library, including `dist/bin/ios-hid`):

```json
{ "mcpServers": { "react-native-mcp-kit": { "command": "node", "args": ["node_modules/react-native-mcp-kit/dist/server/cli.js"] } } }
```

> A normal npm consumer would instead use `{ "command": "npx", "args": ["react-native-mcp-kit"] }`.
> We use the explicit path here because yarn-classic doesn't create a `.bin`
> shim for a `link:` dependency, so `npx` would fetch the published package.

Start the app, then from your agent:

```
connection_status                 # see this app as a connected client
list_tools { compact: true }      # every module above, grouped
demo__app_info                    # a guided map of screens ↔ modules
```

## Notes

- **Dev vs prod plugins** — `babel.config.js` runs the `test-id-plugin` in
  development and the `strip-plugin` in production, so nothing from the kit
  ships in a release build.
- **Public API** — product data comes from `https://dummyjson.com`.
- **Storage backends** — `react-native-mmkv` v4 (Nitro, created via the `createMMKV()` factory — `new MMKV()` is the removed v2 API), `@react-native-async-storage/async-storage` v3, plus a read-only in-memory `config` adapter. MMKV is created lazily and defensively (`src/storage/adapters.ts`): if a backend ever fails to initialize, the `mmkv` store degrades to a no-op instead of crashing the app, and the other stores carry on.
- **fmt patch** — `ios/Podfile` `post_install` disables fmt's consteval path (`FMT_USE_CONSTEVAL`), which RN 0.81's fmt 11.0.2 otherwise compiles incorrectly under Xcode 26's clang.
