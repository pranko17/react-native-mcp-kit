import { type ComponentQuery, type Fiber, type PropMatcher } from '@/modules/fiberTree/types';

import { getComponentName } from './naming';
import { getTextContent } from './serialize';
import { findAllFibers } from './traverse';

// Cap for object/array serialization used by contains/regex matchers.
// Large fiber props (e.g. deep Redux state, Reanimated shared values) would
// otherwise turn into megabyte-strings per fiber.
const MATCH_STRING_CAP = 10_000;

/**
 * Turn any prop value into a string usable by `contains` / `regex` matchers.
 * - Primitives and functions/symbols go through String(), preserving the
 *   "substring on text props" intuition (e.g. placeholder = "Search" stays
 *   "Search", not '"Search"').
 * - Objects and arrays are JSON-serialized with circular refs replaced, so a
 *   regex like `"title":"Hello"` or `\\bonPress\\b` can still land. Functions
 *   and symbols become placeholders; bigint becomes its decimal string.
 * - Output is capped at MATCH_STRING_CAP characters to keep response costs
 *   bounded on large prop graphs.
 */
const stringifyForMatching = (value: unknown): string => {
  if (value === null || value === undefined) return String(value);
  const type = typeof value;
  if (type !== 'object') return String(value);

  try {
    const seen = new WeakSet<object>();
    const serialized = JSON.stringify(value, (_key, v) => {
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      if (typeof v === 'function') return '[Function]';
      if (typeof v === 'symbol') return v.toString();
      if (typeof v === 'bigint') return v.toString();
      return v;
    });
    if (typeof serialized !== 'string') return String(value);
    return serialized.length > MATCH_STRING_CAP
      ? serialized.slice(0, MATCH_STRING_CAP)
      : serialized;
  } catch {
    return String(value);
  }
};

const matchPropValue = (actual: unknown, matcher: PropMatcher): boolean => {
  if (matcher !== null && typeof matcher === 'object') {
    if (actual === undefined || actual === null) return false;
    const isPrimitive = typeof actual !== 'object';
    const deep = (matcher as { deep?: boolean }).deep === true;
    // Non-primitive values only participate when the caller opts in with
    // `deep: true`. This keeps naive placeholder/testID matchers from
    // accidentally hitting stringified objects.
    if (!isPrimitive && !deep) return false;
    const asString = isPrimitive ? String(actual) : stringifyForMatching(actual);
    if ('contains' in matcher && typeof matcher.contains === 'string') {
      return asString.includes(matcher.contains);
    }
    if ('regex' in matcher && typeof matcher.regex === 'string') {
      try {
        return new RegExp(matcher.regex).test(asString);
      } catch {
        return false;
      }
    }
    return false;
  }
  return actual === matcher;
};

// Match a string criterion against an actual value with `/regex/flags`-aware
// semantics. Matches step-level `name` / `mcpId` / `testID` against
// strict equality OR a slash-delimited regex; `text` against substring OR
// regex. Mirrors the syntax used by `select.hooks.names` / `mcpIds` so the
// agent has one consistent rule across the tool.
const matchStringCriterion = (
  actual: string | undefined,
  pattern: string,
  mode: 'equals' | 'includes'
): boolean => {
  if (actual === undefined) return false;
  const re = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
  if (re && re[1] !== undefined) {
    try {
      return new RegExp(re[1], re[2] ?? '').test(actual);
    } catch {
      // Malformed regex — fall through to literal comparison so users get
      // exact-equality semantics rather than silent no-match.
    }
  }
  return mode === 'equals' ? actual === pattern : actual.includes(pattern);
};

export const matchesQuery = (fiber: Fiber, query: ComponentQuery): boolean => {
  try {
    if (
      query.mcpId &&
      !matchStringCriterion(
        fiber.memoizedProps?.['data-mcp-id'] as string | undefined,
        query.mcpId,
        'equals'
      )
    ) {
      return false;
    }
    if (
      query.testID &&
      !matchStringCriterion(
        fiber.memoizedProps?.testID as string | undefined,
        query.testID,
        'equals'
      )
    ) {
      return false;
    }
    if (query.name && !matchStringCriterion(getComponentName(fiber), query.name, 'equals')) {
      return false;
    }
    if (query.text) {
      const content = getTextContent(fiber);
      if (!matchStringCriterion(content ?? undefined, query.text, 'includes')) return false;
    }
    if (query.hasProps && Array.isArray(query.hasProps)) {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== 'object') return false;
      for (const prop of query.hasProps) {
        if (!(prop in props)) return false;
      }
    }
    if (query.props && typeof query.props === 'object') {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== 'object') return false;
      for (const key of Object.keys(query.props)) {
        if (!matchPropValue(props[key], query.props[key]!)) return false;
      }
    }
    if (Array.isArray(query.any) && query.any.length > 0) {
      const anyMatched = query.any.some((sub) => {
        return matchesQuery(fiber, sub);
      });
      if (!anyMatched) return false;
    }
    if (query.not) {
      if (Array.isArray(query.not)) {
        for (const sub of query.not) {
          if (matchesQuery(fiber, sub)) return false;
        }
      } else if (typeof query.not === 'object') {
        if (matchesQuery(fiber, query.not)) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
};

export const findAllByQuery = (root: Fiber, query: ComponentQuery): Fiber[] => {
  return findAllFibers(root, (fiber) => {
    return matchesQuery(fiber, query);
  });
};
