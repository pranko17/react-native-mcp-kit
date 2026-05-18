# Host module (OS-level control)

Server-side tools that drive the device at OS level — `xcrun simctl` / `adb` / a bundled Swift HID binary / a pure-TS CoreDevice tunnel for real iOS 17+ devices. Wired into the MCP server when `hostModule` is passed to `createServer` (the default in [../cli.ts](../cli.ts)). These tools run inside the Node host process and don't require the RN app to be connected — they keep working when the JS bundle is hung, crashed, in the background, or simply not running yet.

## Module wiring

[hostModule.ts](hostModule.ts) is a tiny factory: takes a `ProcessRunner`, returns a `HostModule` with the 13 tool factories invoked once. Per-tool descriptions live alongside each handler in [tools/](tools/) — the module-level description in `hostModule.ts` covers backends + the coordinate-system invariant (physical pixels, top-left origin, match `fiber_tree` bounds).

Tools registered:

| Tool | File |
| ---- | ---- |
| `host__tap`, `host__long_press`, `host__swipe`, `host__drag`, `host__type_text`, `host__type_text_batch`, `host__press_key` | [tools/input/](tools/input/) — one file per tool (`tap.ts`, `longPress.ts`, `swipe.ts`, `drag.ts`, `typeText.ts`, `typeTextBatch.ts`, `pressKey.ts`); shared `constants.ts` + `android.ts` |
| `host__tap_fiber` | [tools/tapFiber.ts](tools/tapFiber.ts) |
| `host__screenshot` | [tools/capture.ts](tools/capture.ts) |
| `host__launch_app`, `host__terminate_app`, `host__restart_app` | [tools/lifecycle.ts](tools/lifecycle.ts) |
| `host__list_devices` | [tools/devices.ts](tools/devices.ts) |

## Types ([types.ts](types.ts))

```ts
interface HostContext {
  bridge: Bridge;                 // for listClients / getClient
  dispatch: HostDispatch;         // chain other tools (host + client)
  requestedClientId?: string;     // pre-resolved when call(clientId:...) was used
}

type HostDispatch = (
  tool: string,
  args: Record<string, unknown>,
  clientId?: string,
) => Promise<{ ok: true; result: unknown } | { error: string; ok: false }>;

interface HostToolHandler {
  description: string;
  handler: (args, ctx: HostContext) => unknown | Promise<unknown>;
  inputSchema?: Record<string, unknown>;
  timeout?: number;
}
```

`HostContext.dispatch` is the mechanism that lets host tools chain client-side tools without round-trips. `host__tap_fiber` is the canonical user — it calls `fiber_tree__query` and `host__tap` from inside its own handler. Resolves against the host tool map and client tools — same path as the public `call` tool.

## Shared helpers ([helpers.ts](helpers.ts))

Every input-taking host tool funnels argument parsing through these helpers so behavior stays consistent:

- **`NATIVE_ID_SCHEMA`** — `{ serial, udid }` schema fragment spread into every tool's `inputSchema`. Pass `udid` to target a specific iOS simulator or `serial` to target a specific Android device. These are highest-priority — they bypass `clientId` and platform-based selection. Values come from `host__list_devices`.
- **`PLATFORM_ARG_SCHEMA`** — `platform: 'ios' | 'android'` filter. Ignored when the outer `call(clientId:...)` is provided — the client's own platform takes precedence.
- **`parseResolveOptions(args)`** — pulls `{ platform, serial, udid }` out of an args object. Always called before `resolveDevice` in tool handlers.
- **`parseCoord(value, name)`** — `{ ok: true, value: number } | { ok: false, error }`. Requires a non-negative finite number; floors fractional input.
- **`parseStringArg`**, **`parsePlatformArg`** — small validators used directly by tools that take `bundleId` / `key` / etc.
- **`AppTargetError`** — `{ error: string }` shape returned by the platform-specific helpers (`tapIos`, `runAdbInput`, …).

## Device resolution ([deviceResolver.ts](deviceResolver.ts))

The whole module flows through one function: `resolveDevice(ctx, options, runner)`. It walks a 4-step priority list and returns a `ResolvedDevice` with `{ platform, kind, nativeId, displayName, bundleId? }` where `kind` is `'simulator' | 'real-device'`. Consumers branch on `device.platform` + `device.kind` to pick the right backend.

Priority order (first match wins):

1. **Explicit `udid` / `serial`** — bypasses everything. Validates against the actual device list; errors if not found or not booted/ready.
2. **`ctx.requestedClientId`** (from outer `call(clientId:...)`) — looks up the client in the bridge and resolves it to a device. No fallback if the client is unknown.
3. **Single matching connected client** (optionally narrowed by `platform`) — auto-picks. iOS clients are routed via `client.isSimulator`: false → `resolveIosRealClient` (uses `xcrun devicectl`), otherwise → simulator path (uses `xcrun simctl`).
4. **No clients matched** — bare platform scan: exactly one booted iOS sim or one online Android device, otherwise an actionable error listing what's available.

Multiple matching clients produce an explicit ambiguity error (`Specify clientId.`).

### List helpers + caching

Three list functions back resolution and the `list_devices` tool:

- `listIosSimulators` — `xcrun simctl list devices --json`.
- `listIosRealDevices` — `xcrun devicectl list devices --json-output <tmp>` (devicectl emits a human-readable header to stdout, so output is read from a temp file).
- `listAndroidDevices` — `adb devices`.

Each result is cached in module scope for 5s. `clearDeviceCache()` is exported for tests. `ProcessNotFoundError` is mapped to actionable install messages (`xcrun not found. iOS host tools require Xcode command line tools (macOS only).` / `adb not found. Android host tools require Android platform-tools on PATH.`).

### Client → device matching

- iOS sim: filter by `state === 'Booted'`. With `client.label`, prefer exact name match, then substring; fall back to "only booted sim" when nothing matches.
- iOS real device: filter by `pairingState === 'paired'`; substring match `client.label` ↔ device name in either direction.
- Android: ambiguous if more than one online — Android handshake doesn't carry a stable label to disambiguate.

### `enrichDevicesWithClientStatus`

Returns `{ ios, android }` lists with each device annotated `{ connected: boolean, clientId? }` and sorted connected-first, booted-second, others-last. The Android pairing is conservative: only marked connected when there's exactly one online device AND exactly one Android client.

## Process runner ([processRunner.ts](processRunner.ts))

Thin wrapper over `child_process.spawn`. `ProcessRunner` is the injectable function type — tools take it as a constructor arg so they're trivially mockable. Default 15 s timeout, `SIGKILL` on timeout, stdout/stderr captured as Buffers, env is `process.env` plus optional overrides. Throws `ProcessNotFoundError` (subclass of `Error`) on `ENOENT` so callers can map it to a toolchain-missing message.

## iOS input ([iosInput.ts](iosInput.ts) + [../../swift/ios-hid.swift](../../swift/ios-hid.swift))

iOS Simulator input (tap / swipe / type / press_key) goes through `dist/bin/ios-hid` — a Swift CLI that injects HID events directly into the simulator via `SimulatorKit` + `CoreSimulator` private frameworks. No WebDriverAgent, no idb, no Appium.

- Source: `src/swift/ios-hid.swift`.
- Built during `yarn build` by [../../../scripts/build-ios-hid.sh](../../../scripts/build-ios-hid.sh) (lives at repo root `scripts/`, not under `src/`). Produces a universal arm64+x86_64 binary in `dist/bin/`; degrades to host-only / arm64-only on partial toolchain availability and skips entirely on non-macOS.
- The TS wrapper in `iosInput.ts` shells out via the injected runner. Path is resolved relative to `__dirname` (`<dist>/server/host/` → `<dist>/bin/ios-hid`). `ProcessNotFoundError` is mapped to a "non-macOS / install Xcode" message.
- 5 s per-call timeout.
- Type uses clipboard paste internally (`simctl pbcopy` + Cmd+V) — keyboard-layout immune, handles unicode. `submit` is implemented by appending `\n` to the typed text.
- `press_key`: `home` maps to a button event; `enter / tab / space / backspace / escape` go through the text path. `back / menu / power / volume_up / volume_down` are explicitly unsupported on iOS Simulator.

**Coordinate invariant** — the Swift binary passes `(x, y)` pixel coordinates to `IndigoHIDMessageForMouseNSEvent` alongside `screenSize` also in pixels; the function internally treats `CGPoint / screenSize` as a ratio. Do not divide by `screenScale` in `createMouseEvent` — that lands the tap at ~1/9 of the intended position. Coordinates are physical pixels end-to-end and match `fiber_tree` bounds — `bounds.centerX` / `bounds.centerY` feed straight into `host__tap`.

## Real iOS devices ([coredevice/](coredevice/))

When the connected client reports `isSimulator: false` on the handshake, `host__screenshot` is routed through `coredevice/screenshot.ts` — a pure-TS client that brings up the macOS-managed CoreDevice tunnel and speaks RemoteXPC + DTX to capture a PNG via `dtservicehub` / `takeScreenshot`. No `sudo`, no `pymobiledevice3`, no native binaries beyond Xcode CLT.

See [coredevice/README.md](coredevice/README.md) for the architecture (tunnel keeper, mDNS, RSD handshake, DTX framing) and [coredevice/PROTOCOL.md](coredevice/PROTOCOL.md) for the bytewise wire reference.

Input injection (tap / swipe / type) on real iOS devices is not implemented — it needs a different DTX service or WebDriverAgent. Only `host__screenshot` works on real iOS today. `host__launch_app` / `host__terminate_app` / `host__list_devices` use `xcrun devicectl` and apply to paired devices via the same resolver path.

## Android backend

Plain `adb` everywhere — no extra binaries:

- Input: `adb -s <serial> shell input tap / swipe / text / keycombination / keyevent`.
- Screenshot: `adb -s <serial> exec-out screencap -p`.
- Launch: `adb -s <serial> shell monkey -p <pkg> -c android.intent.category.LAUNCHER 1`. Lifecycle preflights `pm list packages <pkg>` because monkey's exit code on missing-package is opaque (252 with verbose-args echo on stderr).
- Terminate: `adb -s <serial> shell am force-stop <pkg>`.

`adb shell input text` only accepts ASCII — the underlying KeyCharacterMap has no entries for non-ASCII. `host__type_text` preflight-rejects non-ASCII with an actionable message; for Cyrillic / CJK / emoji on Android, the recommended workaround is `fiber_tree__call({ prop })` on `onChangeText`. `host__type_text` also does select-all + delete before typing (via `input keycombination 113 29` = Ctrl+A then `KEYCODE_DEL`) so behavior matches iOS replace-then-paste semantics.

## Tool behaviour highlights

- **Coordinates** — every `(x, y)` and `(x1, y1, x2, y2)` argument is in physical pixels with top-left origin. Match `fiber_tree` `bounds.centerX` / `bounds.centerY` and feed them straight in.
- **`host__tap`** — runs through the OS gesture pipeline so RN Pressable feedback, gesture responders, and hit-test all fire. Cross-platform single-pixel taps; 5 s timeout.
- **`host__long_press`** — zero-distance swipe held for `durationMs` (default 700 ms, comfortably above RN Pressable's ~500 ms threshold). Clamped 50..5000 ms.
- **`host__swipe`** — start-to-end swipe through OS gesture pipeline; `durationMs` default 300 ms, clamped 50..5000 ms.
- **`host__drag`** — single slow swipe with total time = `holdMs + durationMs` (defaults 500 + 400 = 900 ms). The "hold" is simulated by lingering near the start in a long slow swipe — not a real stop-then-move pause. For precise hold timing (iOS haptic long-press), tune `holdMs` empirically.
- **`host__type_text`** — types into the currently-focused field after clearing it (select-all + delete). `submit: true` presses Enter after. iOS handles unicode via clipboard paste; Android refuses non-ASCII up front.
- **`host__type_text_batch`** — `fields: [{ x, y, text, submit? }]` + optional `focusDelayMs` (default 200 ms, clamped 0..5000). For each entry: tap → wait `focusDelayMs` → type. Default 200 ms is tuned for in-place TextInputs (login forms). Bump to 700–800 ms when the tap triggers a screen transition (e.g. search-bar → SearchScreen) — otherwise the target input isn't mounted yet and the typed text is lost. Stops on first error returning `{ filled, failedAt, error }`.
- **`host__press_key`** — semantic key names mapped to the right OS event. Accepted keys: `back, backspace, enter, escape, home, menu, power, space, tab, volume_down, volume_up`. iOS Simulator lacks `back / menu / power / volume_up / volume_down`.
- **`host__tap_fiber`** ([tools/tapFiber.ts](tools/tapFiber.ts)) — the canonical "user tap": chains `fiber_tree__query` → `host__tap` in one call via `ctx.dispatch`. On ambiguity returns `{ candidates, total }` so the agent can pick `index` or narrow `steps`. On unmounted/virtualized fiber returns `{ error: 'fiber has no measurable host view' }`.
- **`host__screenshot`** — WebP, default width 280 px (clamped 64..1568), resized via `sharp`. Diff-cached per-device via SHA-256: identical bytes return `{ unchanged: true, lastMeta }` where `lastMeta` is the meta of the previously-shipped image (`{ width, height, originalWidth, originalHeight, scale, bytes, hash, region? }`). Accepts `region: { x, y, width, height }` in original device pixels — cropped BEFORE resize (clipped to the image bounds, so fiber bounds at the edges don't need guarding). Region pairs with fiber bounds to snapshot one element for ~20–60 vision tokens. Response is `[image, metadataText]`; metadata JSON includes `scale` (image-to-source ratio — image/region when cropped, image/full-screen otherwise) so the agent can map image pixel (px, py) back to device pixel as `(region.x + px / scale, region.y + py / scale)`. Routes per `resolved.device.kind`: iOS simulator → `xcrun simctl io screenshot`, Android → `adb exec-out screencap -p`, real iOS 17+ → `captureScreenshot` in [coredevice/screenshot.ts](coredevice/screenshot.ts).
- **`host__launch_app` / `host__terminate_app` / `host__restart_app`** — `appId` (bundleId / package name) optional when the resolved client carries `bundleId` in its handshake. iOS uses `xcrun simctl launch / terminate`; Android uses `monkey` for launch and `am force-stop` for terminate, with a `pm list packages` preflight on launch.
- **`host__list_devices({ connected? })`** — enumerates iOS sims + Android devices, annotates with `connected: true` / `clientId` when matched. `connected: true` filters to only devices with a live MCP client attached; per-platform error envelopes (`{ error: 'xcrun not found' }` / `{ error: 'adb not found' }`) are preserved through the filter.

## Code-level concerns

- `iosInput.ts` resolves the ios-hid binary path as `__dirname/../../bin/ios-hid`. This depends on the compiled module living at `dist/server/host/iosInput.js`. If the TS build emits to a different layout (e.g. flattened) the lookup silently breaks — there's no fallback path.
- `enrichDevicesWithClientStatus` matches Android clients only when there's exactly one online device AND exactly one Android client. Two Android clients on two emulators are never paired. The iOS code uses label-based matching; Android handshake would need a similar deviceId/label to do the same.
