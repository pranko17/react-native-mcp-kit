/**
 * Shared redact utility used by `projectValue` and modules that have their
 * own redact lists (network headers/body keys). Extracted from `network.ts`
 * verbatim so behaviour stays identical for existing callers.
 *
 * - Pattern list is `Array<string | RegExp>`. Strings are lowercased and
 *   matched as substring on lowercased keys; regexes are matched verbatim.
 * - `false` (instead of array) — disables redaction.
 * - `undefined` — uses provided defaults.
 */

export type RedactPatterns = ReadonlyArray<string | RegExp> | false;

interface CompiledRedact {
  empty: boolean;
  exact: Set<string>;
  regexes: RegExp[];
}

export const compileRedact = (
  list: RedactPatterns | undefined,
  defaults: ReadonlyArray<string | RegExp> = []
): CompiledRedact | null => {
  if (list === false) return null;
  const src = list === undefined ? defaults : list;
  const exact = new Set<string>();
  const regexes: RegExp[] = [];
  for (const item of src) {
    if (typeof item === 'string') exact.add(item.toLowerCase());
    else regexes.push(item);
  }
  return { empty: exact.size === 0 && regexes.length === 0, exact, regexes };
};

export const matchesRedact = (key: string, compiled: CompiledRedact | null): boolean => {
  if (!compiled || compiled.empty) return false;
  const lower = key.toLowerCase();
  if (compiled.exact.has(lower)) return true;
  for (const rx of compiled.regexes) {
    if (rx.test(key)) return true;
  }
  return false;
};

/**
 * Walk an object/array graph; replace value of any key matching a redact
 * pattern with `[redacted]`. Preserves shape so caller still sees the field
 * exists. Used by network for request/response bodies; also re-exported for
 * `projectValue` which inlines the same matcher in its walk.
 */
export const redactValue = (value: unknown, compiled: CompiledRedact | null): unknown => {
  if (!compiled || compiled.empty) return value;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      return redactValue(item, compiled);
    });
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = matchesRedact(key, compiled) ? '[redacted]' : redactValue(v, compiled);
  }
  return out;
};

/**
 * Redact a flat headers map (case-insensitive on key names).
 */
export const redactHeaders = (
  headers: Record<string, string>,
  compiled: CompiledRedact | null
): Record<string, string> => {
  if (!compiled || compiled.empty) return headers;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = matchesRedact(key, compiled) ? '[redacted]' : value;
  }
  return out;
};
