# `src/modules/device/` — device + platform introspection module

[`device.ts`](device.ts) — `deviceModule()`, registered as `device`. One aggregate read tool plus a small set of imperative actions. Everything reads through RN's standard core modules (`Platform`, `Dimensions`, `PixelRatio`, `Appearance`, `AppState`, `AccessibilityInfo`, `Keyboard`, `Linking`) accessed via [`getRN()`](../../shared/rn/core.ts); `DevSettings` and `Vibration` are the action surfaces. Optional [`react-native-device-info`](../../shared/rn/deviceInfo.ts) fields go through the shared lazy loader so the package can be absent without breaking anything.

See [`../CLAUDE.md`](../CLAUDE.md) for the module interface, registration flow, and projection conventions; see [`../../shared/rn/deviceInfo.ts`](../../shared/rn/deviceInfo.ts) for the DI loader + the canonical `DEVICE_INFO_UNAVAILABLE` payload.

## Tools

### `info({ select? })`

Single aggregate read. [device.ts:209](device.ts) — handler walks `INFO_FIELDS` (the canonical 13-entry list at [device.ts:20](device.ts)). `select` is an optional array filtered to known fields; omit for the full payload. The two boundary cases:

- `select` is an array but contains zero valid entries → returns `{ availableFields, error }` instead of an empty `{}` (so the agent learns the vocabulary, [device.ts:217](device.ts)).
- A DI-backed field is requested but `react-native-device-info` isn't installed → that field carries `DEVICE_INFO_UNAVAILABLE` (`{ unavailable: true, reason }`) — other fields in the same response keep their real values.

Fields already surfaced in the handshake (`appName` / `appVersion` / `bundleId` / `deviceId` / `label`) are intentionally not duplicated; pull them from `connection_status` instead.

## Field groups

### RN core (always available)

Read through `getRN()` — these never error in-app.

- `platform` — `{ os, version, constants }` from `Platform`.
- `dimensions` — `{ screen, window, screenPixels, windowPixels, pixelRatio }`. `screen` / `window` are raw `Dimensions.get(...)` (DP, includes `fontScale` / `scale` / `width` / `height`). `screenPixels` / `windowPixels` are `Math.round(dp * PixelRatio.get())` — physical pixels matching what [`host__tap`](../../server/host/tools/input.ts) and `adb shell input tap` consume. [device.ts:121](device.ts).
- `pixelRatio` — `{ pixelRatio, fontScale }` (just the two scalars; for the full DP+pixels block use `dimensions`).
- `appearance` — `{ colorScheme: 'light' | 'dark' | null }` from `Appearance.getColorScheme()`.
- `appState` — `{ state: 'active' | 'background' | 'inactive' }` from `AppState.currentState`.
- `accessibility` — `{ isScreenReaderEnabled, isReduceMotionEnabled }`, both awaited in parallel via `AccessibilityInfo`.
- `keyboard` — `{ isVisible, metrics }` from `Keyboard.isVisible()` + `Keyboard.metrics()`.
- `initialUrl` — `{ url }` from `await Linking.getInitialURL()`. Deep-link entry point; populated only when the app was launched by a URL.
- `dev` — `{ dev: boolean }`, sourced from `globalThis.__DEV__` ([device.ts:165](device.ts)). True in Metro dev bundles, false after the strip plugin runs in release builds.

### `react-native-device-info`-backed (optional)

[device.ts:42](device.ts) — `DI_FIELDS` is checked first so the handler short-circuits to `DEVICE_INFO_UNAVAILABLE` without touching RN when the package is missing. All getters routed through [`callDI` / `callDIAsync`](../../shared/rn/deviceInfo.ts) so individual missing methods on older DI versions degrade to `null` instead of throwing.

- `identity` — `{ deviceType, hasDynamicIsland, hasNotch, isTablet, manufacturer, model, systemName, systemVersion }`. `manufacturer` falls back to `getBrand` when `getManufacturerSync` isn't exported by the installed DI version ([device.ts:60](device.ts)). Excludes the handshake-duplicated `deviceId` / `label` / `appName` / `appVersion` / `bundleId`.
- `app` — `{ buildNumber, firstInstallTime, installerPackageName, lastUpdateTime, readableVersion }`. Three async fields awaited in parallel.
- `battery` — `{ batteryLevel, isCharging, isLowBatteryLevel, powerState }`. `isLowBatteryLevel` is computed locally as `batteryLevel < 0.2` ([device.ts:89](device.ts)) rather than calling `DI.isLowBatteryLevel` — keeps the threshold consistent across platforms. Returns `null` for `isLowBatteryLevel` when `batteryLevel` itself isn't a number.
- `memoryStorage` — `{ freeDiskStorage, maxMemory, totalDiskCapacity, totalMemory, usedMemory }`. All five awaited in parallel.

## Action tools

### `open_url({ url, dryRun? })`

`Linking.openURL(url)` by default. `dryRun: true` short-circuits to `Linking.canOpenURL(url)` and returns `{ canOpen, url }` without launching anything — useful for verifying a custom URL scheme is registered before triggering it. [device.ts:250](device.ts).

### `open_settings`

`Linking.openSettings()` — pops the app's row inside the device Settings app.

### `dismiss_keyboard`

`Keyboard.dismiss()`. Pairs naturally with `host__type_text_batch` chains that don't end in a submit.

### `reload`

`DevSettings.reload()` — equivalent to pressing R in Metro. No explicit `__DEV__` gate in the handler; `DevSettings` is the dev-only RN module so this is effectively a no-op (or throws) in production bundles. Prefer `metro__reload` from the server side when the app may be paused.

### `vibrate({ duration? })`

`Vibration.vibrate(duration ?? 400)` — duration defaults to 400ms when omitted or zero ([device.ts:290](device.ts), uses `||` not `??` so `duration: 0` also falls back).

## Behavior notes

- The handler awaits all requested fields in parallel via `Promise.all(requested.map(...))` ([device.ts:223](device.ts)) — `select: ['battery', 'memoryStorage', 'accessibility']` runs three independent DI / RN call clusters concurrently.
- No projection on `info` — the payload is bounded by the field list itself, so it ships raw. Heavy DI fields that grow over RN versions should add their own projection when needed.
- The factory takes no options. Customising redaction / caps / DI fallback would all happen by editing `device.ts` directly.
