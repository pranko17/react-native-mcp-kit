# `src/modules/i18next/` — i18next translation inspection

> Factory is `i18nextModule()`, but the **registered module name is `i18n`** (see [`i18next.ts`](i18next.ts) line 34). Agents call `call(tool: "i18n__translate")`, `call(tool: "i18n__get_keys")`, etc. — `i18next__…` will miss. The folder/file name is the only place where `i18next` appears at runtime.

Thin wrapper over an injected i18next-shaped instance. The module owns no state of its own — every read goes straight through `i18n.t` / `i18n.getResource` / `i18n.language` / `i18n.languages` / `i18n.options`. See [`src/modules/CLAUDE.md`](../CLAUDE.md) for module-interface, factory, and per-provider-prop registration conventions.

## `I18nLike` shape

[`types.ts`](types.ts) defines the minimal duck-typed surface the module needs:

```ts
interface I18nLike {
  changeLanguage: (lng: string) => Promise<unknown>;
  getResource: (...args: any[]) => any;
  language: string;
  languages: readonly string[];
  options: { defaultNS?: unknown; ns?: unknown };
  t: (...args: any[]) => string;
}
```

`options.ns` / `options.defaultNS` are intentionally `unknown` — i18next allows `string`, `string[]`, `false`, or absent. Any library matching this shape adapts without an i18next dependency. The provider prop is just `i18n`, so `<McpProvider i18n={i18nInstance}>` registers this module.

## Namespace resolution

[`i18next.ts`](i18next.ts) lines 20–25, `getNamespaces()`:

1. `i18n.options.ns ?? i18n.options.defaultNS`.
2. Falsy or literal `false` → `['translation']` (i18next's stock default namespace).
3. Array → returned as-is.
4. Single string → wrapped in a one-element array.

Tools that take an optional `namespace` arg fall back to `getNamespaces()[0]`, then to `'translation'` as a final guard (`args.namespace || getNamespaces()[0] || 'translation'`, e.g. line 65). Tools that take an optional `language` arg fall back to `i18n.language`.

## Tools

### `get_info`

No args. Returns `{ currentLanguage, languages, namespaces }` — `languages` is a copy of `i18n.languages` (typically the resolved fallback chain), `namespaces` comes from `getNamespaces()`.

### `get_resource({ language?, namespace? })`

Returns `{ language, namespace, resource }` — `resource` is whatever `i18n.getResource(lng, ns)` hands back (typically the nested object for that ns). On miss returns `{ error: "No resource for <lng>/<ns>" }` (no throw).

### `get_keys({ language?, namespace? })`

Returns `{ keys, language, namespace }` where `keys` is the dot-flattened list produced by the recursive `flattenKeys` helper (lines 5–17). Arrays count as leaves (not walked); plain objects recurse. Same `{ error: "No resource for <lng>/<ns>" }` shape on miss.

### `translate({ key, options? })`

Returns `{ key, value }` where `value` is `i18n.t(key, parsedOptions)`. `options` is a **JSON string** (not an object) — the schema stays flat so the MCP `call` envelope doesn't need nested objects per arg; the handler `JSON.parse`s it. Malformed JSON returns `{ error: 'Invalid JSON in options' }` (line 142). Use namespaced keys (`'auth:login.title'`) when working across namespaces.

### `search({ query, language? })`

Returns a **bare array** of `{ key, namespace, value }` (no wrapper object). Walks every namespace from `getNamespaces()` in order; for each, flattens keys and resolves values via `i18n.t(`${ns}:${key}`)` — so interpolation placeholders surface as their raw `{{ name }}` markers and any i18next fallback/post-processing rules apply. Case-insensitive substring match against both flattened key and resolved value. Namespaces without a registered resource for `language` are silently skipped (no error entry).

### `change_language({ language })`

Awaits `i18n.changeLanguage(language)` and returns `{ language: i18n.language, success: true }`. `language` is reread *after* the await so the response reflects what i18next actually settled on (which may differ from the requested code via fallback rules).

## Behavioural notes

- Resource lookup is read-only; the module never mutates the i18next instance except via the explicit `change_language` tool.
- Errors are returned as `{ error: string }` payloads rather than thrown — the agent sees them inline instead of as MCP error responses.
- The 10-second per-tool timeout from the shared `ToolHandler` contract applies; `change_language` typically resolves in <100 ms even with async backends.
