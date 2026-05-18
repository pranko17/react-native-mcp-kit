# `modules/alert/` — Native Alert dialogs

[`alert.ts`](alert.ts) — `alertModule()`, registered as `alert`. Thin wrapper over RN's `Alert.alert` ([`alert.ts:21`](alert.ts:21) — lazy `getRN().Alert`) so an agent can pop a native dialog and read back which button was tapped.

See [`../CLAUDE.md`](../CLAUDE.md) for the module interface and registration conventions; [root `CLAUDE.md`](../../../CLAUDE.md) for build commands and shared style rules.

## Tools

### `show`

`show({ title?, message?, buttons? })` — opens `Alert.alert` and resolves once a button is pressed. Returns `{ button: string, index: number }` where `button` is the tapped button's `text` and `index` is its position in the original `buttons` array.

Inputs ([`alert.ts:45`](alert.ts:45)):

- `title` — string, default `'Alert'`. Empty string falls through to the default because of the `||` fallback at [`alert.ts:31`](alert.ts:31).
- `message` — string, default `''`. Same `||`-coerced behaviour — pass `' '` if you really need a blank-looking body.
- `buttons` — `Array<string | { text, style? }>`, default `[{ text: 'OK' }]`. Strings are normalised to `{ text }` at [`alert.ts:24`](alert.ts:24); the schema enforces `minItems: 1`. `style` is one of `'default' | 'cancel' | 'destructive'` ([`alert.ts:6`](alert.ts:6)); missing style coerces to `'default'` at [`alert.ts:38`](alert.ts:38).

The handler returns a `Promise` that never rejects — it only resolves on a button press. If the user dismisses the dialog by other means (Android back gesture, system overlay), the promise sits open until the tool-level timeout fires.

## Timeout

`ALERT_TIMEOUT = 60_000` ([`alert.ts:4`](alert.ts:4), wired via `timeout` at [`alert.ts:69`](alert.ts:69)) — six times the default 10s `ToolHandler.timeout`. Keeps the dialog alive long enough for a human-in-the-loop response while still bounding the wait so the agent isn't stuck forever on a dismissed dialog.

## Edge cases

- `Alert.alert` is platform-native: on iOS it renders a `UIAlertController`, on Android an `AlertDialog`. Behaviour for >3 buttons differs across platforms (iOS stacks vertically, Android may truncate) — pin button counts to ≤3 for portable flows.
- No `inputSchema` for the return value; agents discover the `{ button, index }` shape from the per-tool `description` at [`alert.ts:19`](alert.ts:19).
- Only one dialog can be visible at a time; calling `show` twice in parallel will queue or drop the second on Android depending on the OS version. Treat as serial.
