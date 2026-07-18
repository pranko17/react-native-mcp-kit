import { MODULE_SEPARATOR } from '@/shared/protocol';

export const BASE_INSTRUCTIONS = `You are connected to a running React Native app via the react-native-mcp-kit bridge.

Multiple React Native apps can connect simultaneously — each is identified by a short ID like "ios-1", "android-1", or "client-1".

## How to interact

Every tool is top-level: module tools shipped by the app (\`fiber_tree${MODULE_SEPARATOR}query\`, \`network${MODULE_SEPARATOR}get_requests\`, \`navigation${MODULE_SEPARATOR}navigate\`, ...), dynamic tools registered via \`useMcpTool\`, and host tools (\`host${MODULE_SEPARATOR}screenshot\`, \`host${MODULE_SEPARATOR}tap_fiber\`, \`metro${MODULE_SEPARATOR}reload\`, ...) are all first-class MCP tools — invoke them directly by name with their full schema visible in your catalog. No proxy layer.

1. Use \`host${MODULE_SEPARATOR}connection_status\` to check connected clients — each has a lifecycle \`status\` (\`active\` / \`background\` / \`inactive\`), plus a \`disconnected\` array of recently-closed clients (held ~1h, with \`expiresInMs\`). Not \`active\`? See "App not \`active\`?" below.
2. Invoke tools directly. Every tool accepts an optional \`clientId\` arg — omit it with a single client connected (auto-picks); with several, omitting returns an error listing available IDs.
3. Use \`wait_until\` to poll any tool until a predicate over its result holds (or timeout). Replaces "screenshot in a loop + sleep" for state-level waits ("wait for network to idle", "wait for state key X to become Y"). Predicate supports compound forms: { all: [...] } (AND), { any: [...] } (OR), { not: predicate }.
4. For UI-level waits ("wait for a screen to appear", "wait for a spinner to disappear") use \`fiber_tree${MODULE_SEPARATOR}query\` with \`waitFor: { until: "appear" | "disappear", timeout?, interval?, stable? }\` — it polls the same query with cache bypassed until the target state holds. \`stable: <ms>\` requires continuous presence/absence for that many ms to ignore transient matches during screen transitions.
5. Use \`assert\` for a single-shot checkpoint after actions — same predicate vocabulary as wait_until, returns { pass, actual, expected?, result? }. Natural pair: do action → wait_until / fiber_tree waitFor → assert.

The tool catalog updates live: tools appear when RN clients connect (or components mount \`useMcpTool\`) and disappear on disconnect — the server emits \`notifications/tools/list_changed\`. If the catalog feels stale after an app reload, re-check \`host${MODULE_SEPARATOR}connection_status\`.

### \`clientId\` — routing and broadcast

Every tool's \`clientId\` accepts a string, a \`/body/flags\` regex literal, or an array (literals and regex mixed). A plain string keeps the single-client shape (image content passes through). Regex and array forms switch into broadcast mode — every matching connected client is dispatched in parallel. Same regex slash form as fiber_tree hook filters and log_box ignore patterns.

  \`host${MODULE_SEPARATOR}screenshot({ clientId: ["ios-1", "android-1"] })\`   — two screenshots in one response
  \`host${MODULE_SEPARATOR}screenshot({ clientId: "/^ios/" })\`                — broadcast to every connected iOS client
  \`fiber_tree${MODULE_SEPARATOR}query({ clientId: "/./", steps: [{ mcpId: "checkout:button:submit" }] })\` — query every connected client

Broadcast result shape — text-only: \`{ okCount, failedCount, results: [{ clientId, ok, result | error }] }\`; image results: a summary text block \`Broadcast: N ok, M failed (T clients).\` precedes per-client \`## <clientId>\` headers + blocks.

Regex form details:
  • A leading \`/\` plus a trailing \`/<flags>\` switches the string into regex mode. Flags from \`[gimsuy]\`. Anything else is treated as a literal client ID.
  • Pattern is matched against connected client IDs (\`ios-1\`, \`android-2\`, …). \`"/./"\` matches every connected client; \`"/^ios/"\` only iOS; \`"/-1$/"\` only the first client per platform.
  • Pattern that matches zero connected clients returns an error up front — broadcasting to nobody is almost always a mistake. Literals that are unconnected still fall through to the per-client error in the broadcast envelope (matches the not-fail-fast contract).

### \`wait_until\` / \`assert\` — clientId is outer, args are inner

\`wait_until\` and \`assert\` are wrappers around another tool. Each invocation has two argument layers, never mixed:

  • **Outer** — fields on the wrapper itself: \`tool\`, \`args\`, \`clientId\`, plus \`predicate\` / \`timeoutMs\` / \`intervalMs\` (wait_until), \`predicate\` / \`message\` (assert). \`clientId\` accepts the same broadcast forms as direct invocation; overall \`ok\`/\`pass\` is true only when every targeted client matches.
  • **Inner** — what goes inside the wrapper's \`args\` object: the target tool's own args WITHOUT \`clientId\` (the wrapper resolves the client before dispatch; \`clientId\` inside \`args\` is a hard error with a remediation hint).

  Wrong:  \`wait_until({ tool: "fiber_tree${MODULE_SEPARATOR}query", args: { clientId: "ios-1", steps: [{ scope: "root" }] }, predicate: ... })\`
  Right:  \`wait_until({ clientId: "ios-1", tool: "fiber_tree${MODULE_SEPARATOR}query", args: { steps: [{ scope: "root" }] }, predicate: ... })\`

Some tools run inline on the MCP server host (e.g. \`host${MODULE_SEPARATOR}screenshot\`, \`host${MODULE_SEPARATOR}list_devices\`, \`host${MODULE_SEPARATOR}launch_app\`, \`host${MODULE_SEPARATOR}terminate_app\`, \`host${MODULE_SEPARATOR}restart_app\`, \`metro${MODULE_SEPARATOR}reload\`, \`metro${MODULE_SEPARATOR}symbolicate\`) and work even when no React Native client is connected. They use xcrun simctl / adb on the dev machine. When \`clientId\` is provided, host tools use that client's platform/label/deviceId as hints to resolve the target device; otherwise they prefer the device of the single connected client, falling back to the single booted sim / online device. \`launch_app\`, \`terminate_app\`, and \`restart_app\` accept an \`appId\` arg (iOS bundle ID / Android package name); omit it to reuse the target client's registered \`bundleId\` from its connection metadata. \`clientId\` resolves even a \`disconnected\` client within the ~1h reconnect window.

## App not \`active\`? Relaunch, don't hammer

If \`host${MODULE_SEPARATOR}connection_status\` shows a client as \`background\` / \`inactive\` (JS may be suspended → in-app calls can hang) or under \`disconnected\` (closed / crashed → in-app calls fail "not connected"; slot held ~1h), don't loop on the failing call — relaunch it. Host tools need no live socket: \`host${MODULE_SEPARATOR}launch_app\` (or \`restart_app\`) by \`clientId\` resolves even a \`disconnected\` client (or pass \`udid\` / \`serial\` from \`host${MODULE_SEPARATOR}list_devices\`); then \`wait_until\` it's \`active\` again under the same \`clientId\`.

## Driving the UI — pick the right tool
1. **\`host${MODULE_SEPARATOR}tap_fiber\` with \`steps: [...]\`** — the canonical way to simulate a user tap. One call locates the fiber via fiber_tree__query and taps its center through the real OS gesture pipeline, so Pressable feedback, gesture responders, and hit-test logic all run. Ambiguous matches return a candidate list so you can add \`index\` or narrow \`steps\`. This is what you want whenever the user asks to simulate a tap / press / button click.
2. **\`fiber_tree${MODULE_SEPARATOR}query\` with \`select: ["mcpId","name","bounds"]\` + \`host${MODULE_SEPARATOR}tap\`** when you want to inspect a match set before committing — e.g. verify bounds, or skim candidates before picking one. \`props\` is opt-in on \`select\` to keep responses small.
3. **\`fiber_tree${MODULE_SEPARATOR}call\`** for non-gesture callbacks or imperative ref methods. Pass \`prop\` to call a callback prop (\`{ prop: 'onPress' }\`) or \`method\` to call a native-ref method (\`{ method: 'focus' }\`). Good when the component is off-screen / virtualised, when a scroll-handler parent swallows taps, or when you're driving focus / blur / measure / scrollTo via the native ref. For simulating a user tap, prefer tap_fiber (above).
4. **\`host${MODULE_SEPARATOR}screenshot\` + manual coordinate estimation + \`host${MODULE_SEPARATOR}tap\`** ONLY for non-React surfaces: system permission dialogs, native alerts, the on-screen keyboard, WebView content, native splash. These have no fiber and no bounds. Pair with \`region: { x, y, width, height }\` to screenshot just the area you're inspecting — vision-token cheap.

Gesture tools: \`host${MODULE_SEPARATOR}tap\` / \`host${MODULE_SEPARATOR}long_press\` / \`host${MODULE_SEPARATOR}swipe\` / \`host${MODULE_SEPARATOR}drag\` / \`host${MODULE_SEPARATOR}type_text\` / \`host${MODULE_SEPARATOR}type_text_batch\` / \`host${MODULE_SEPARATOR}press_key\` work on both platforms with no external daemons: Android via \`adb shell input\`, iOS via a bundled \`ios-hid\` binary that injects HID events directly into iOS Simulator through SimulatorKit.

Stack traces: \`errors${MODULE_SEPARATOR}get_errors\` and \`log_box${MODULE_SEPARATOR}get_logs\` return parsed \`stackFrames\` you can pass straight into \`metro${MODULE_SEPARATOR}symbolicate\` to resolve bundled frames back to source paths via Metro.

## Consolidated tools — verb + arg, not verb-per-action

Every module exposes one verb per concept rather than one tool per variant. Reach for the listing tool with a filter arg, not a tool named after the filter:

- **console** — \`get_logs({ level? })\` for all levels (no per-level shortcuts).
- **errors** — \`get_errors({ fatal? })\` covers fatal-only too.
- **network** — \`get_requests({ status?, method?, url? })\` covers errors / pending / URL filter.
- **log_box** — \`clear({ level? })\` (warn / error / syntax / all); \`set_installed({ enabled })\` toggles install/uninstall.
- **navigation** — \`navigate({ mode: 'reuse' | 'push' | 'replace' })\` covers navigate/push/replace; \`pop({ to: <number> | <screenName> | 'top' })\` covers pop / pop_to / pop_to_top; \`get_current_route({ withState? })\` covers the route-state read too.
- **query** (reactQuery) — \`mutate({ action: 'invalidate' | 'refetch' | 'remove' | 'reset', key? })\` covers all four cache mutations.
- **device** — \`info({ select?: [...] })\` aggregates platform / dimensions / pixelRatio / appearance / appState / accessibility / keyboard / initialUrl / dev / identity / app / battery / memoryStorage. \`open_url({ dryRun? })\` covers the canOpenURL check too.
- **fiber_tree** — \`query\` (all inspection: mcpId / name / testID / props / hooks / bounds / refMethods / children) and \`call({ prop? | method? })\` (callback prop OR native-ref method) — two tools cover everything fibers offer.

## Path-based drill into heavy responses

All listing tools that return heavy JSON (console / network / errors / storage / reactQuery / log_box / navigation / metro events / fiber_tree) accept the standard \`path\` / \`depth\` / \`maxBytes\` projection args. Heavy nested values collapse to compact \`\${...}\`-keyed markers; primitives stay raw. Drill into a specific subtree via the same tool with \`path\` — no separate by-id fetcher.

  \`network__get_requests({ path: '[-1:][0].response.body' })\`         — last request's body
  \`network__get_requests({ path: '[-1:][0].response.body', depth: 8 })\` — fully expanded
  \`console__get_logs({ path: '[-3:][0].args[1]' })\`                    — second arg of the third-from-last log
  \`storage__get_item({ key: 'session', path: 'value.user.email' })\`    — drill into a stored value
  \`query__get_data({ key: '["users"]', path: 'data.email' })\`         — drill into cached data

Path syntax (JS-style):
  \`.key\` or \`["key.with.dots"]\` — object key access
  \`[N]\` — index (numeric for arrays, Nth char for strings, Nth key in insertion order for objects)
  \`[start:end]\` / \`[start:]\` / \`[:end]\` — slice (Python/jq-style; negative indices count from end). Works on arrays, strings, and objects (key slice). After array slice, chained \`.key\` maps over each element; \`[N]\` picks one.

Path drilling to a string scalar applies \`previewCap\` as usual — long leaves still wrap in a \`\${str}\` marker. To get a raw substring, end the path with a slice: \`stack[0:500]\` returns the first 500 chars verbatim (slice = explicit truncation request, previewCap bypassed). Default \`previewCap\` is 250; override per call via \`previewCap: <N>\`.

\`depth\` (default per tool, max 8) controls how many container levels are walked before collapsing to a marker. Bump \`depth\` for an exploratory survey, use \`path\` for a targeted drill. \`maxBytes\` (default 50KB) caps the total response size — overflow is replaced with a single \`\${str}\` marker carrying the original byte count + a preview.

For \`fiber_tree__query\`, heavy fields (\`props\`, \`hooks\`) take projection knobs per-field via \`select\` so the rest of the response stays raw:
  \`select: [{ props: { path: "style", depth: 2 } }]\`   — drill into props.style 2 levels deep
  \`select: [{ props: { path: "data[0:5]" } }]\`         — slice path: take first 5 items of props.data
  \`select: [{ hooks: { kinds: ["State"], names: ["isLoading"], withValues: true, depth: 2 } }]\` — filter + project hook values
  \`select: [{ children: 5 }]\`                          — light-only recursive tree walker (5 levels deep); use \`scope: "root"\` as the first step to dump the whole tree. props/hooks not supported inside; sub-children past treeDepth surface as \`\${arr}: N\`.

Hook filters: \`kinds\` (State/Effect/Memo/Ref/Custom/...), \`names\` (exact or \`/regex/flags\`), \`withValues\` (adds resolved values), \`expansionDepth\` (caps custom-hook recursion), \`format: "tree"\` (nested children vs flat \`via\` chains). Each hook entry carries \`{ kind, name, hook?, via?, expanded? }\`. Sensitive names (password, token, jwt, secret, credential, apiKey, authorization, Pin suffix) are auto-redacted; configure via \`fiberTreeModule({ redactHookNames, additionalRedactHookNames })\`.

Marker format: \`{ "\${obj}": N }\` for collapsed objects (N keys), \`{ "\${arr}": N }\` for arrays (N items), \`{ "\${fun}": "name" }\` for functions, \`{ "\${str}": { len, preview } }\` for long strings (>\`previewCap\`, default 250), \`{ "\${Date}": "iso" }\` for Date, \`{ "\${Err}": { name, msg } }\` for Error, \`{ "\${RegExp}": "/.../i" }\` for RegExp, \`{ "\${map}": N }\` / \`{ "\${set}": N }\` for Map/Set sizes, \`{ "\${cyc}": true }\` for cycles, \`{ "\${ref}": { mcpId, name } }\` for fiber/native refs, \`{ "\${cls}": { name, len } }\` for class instances, \`{ "\${truncated}": { total, slice } }\` first key/item when a container is wider than the cap (30 keys for objects, 50 items for arrays).
`;
