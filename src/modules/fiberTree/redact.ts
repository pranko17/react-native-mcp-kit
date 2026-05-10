/**
 * Hook-value redaction. Names matching any compiled pattern have their
 * `value` masked as `"[redacted]"` in `withValues: true` responses while
 * keeping kind / name / hook visible. Matching is applied to a hook's
 * `name` AND every entry in its `via` chain so values stay masked even
 * when nested under a sensitive custom hook (a leaf `value` inside a
 * `useAuth()` expansion).
 *
 * Default list catches the common security-sensitive names. Tuned to
 * match real-world variable names without over-matching innocents:
 * `Pin$` is anchored so it doesn't catch "Spinner"; broad terms like
 * `auth` are deliberately omitted (would catch `isAuthenticated`).
 */
export const DEFAULT_REDACT_HOOK_NAMES: ReadonlyArray<string | RegExp> = [
  /password/i,
  /token/i,
  /jwt/i,
  /secret/i,
  /Pin$/,
  /credential/i,
  /apiKey/i,
  /authorization/i,
];

/** Placeholder put on the `value` field of a redacted hook entry. */
export const REDACTED_VALUE = '[redacted]';

const escapeRegExp = (s: string): string => {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

/**
 * Compile a mixed string/RegExp list into RegExps. String patterns are
 * escaped and made case-insensitive (so `"password"` catches `password`,
 * `oldPassword`, `passwordHash`); RegExp values are kept verbatim.
 */
export const compileRedactPatterns = (raw: ReadonlyArray<string | RegExp>): RegExp[] => {
  return raw.map((p) => {
    return typeof p === 'string' ? new RegExp(escapeRegExp(p), 'i') : p;
  });
};

export const matchesAnyRedactPattern = (name: string, patterns: RegExp[]): boolean => {
  for (const p of patterns) {
    if (p.test(name)) return true;
  }
  return false;
};
