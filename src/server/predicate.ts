export type PredicateOp =
  | 'contains'
  | 'equals'
  | 'exists'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'notContains'
  | 'notEquals'
  | 'notExists';

/**
 * Recursive predicate. Leaf form is { op, path?, value? }. Compound forms
 * compose: { all: [...] } (AND), { any: [...] } (OR), { not: predicate }
 * (negation). Compound forms can nest.
 */
export interface LeafPredicate {
  op: PredicateOp;
  path?: string;
  value?: unknown;
}
export type Predicate =
  | LeafPredicate
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate };

/**
 * Drill into a value by dot-path. Arrays accept numeric indices and also
 * respond to `.length` (handy for "wait until list is empty"). Returns
 * undefined when any intermediate segment is missing.
 */
export const resolvePath = (value: unknown, path: string | undefined): unknown => {
  if (!path) return value;
  let current: unknown = value;
  for (const key of path.split('.')) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      if (key === 'length') {
        current = current.length;
        continue;
      }
      const idx = Number.parseInt(key, 10);
      current = Number.isNaN(idx) ? undefined : current[idx];
      continue;
    }
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[key];
      continue;
    }
    return undefined;
  }
  return current;
};

const evalLeaf = (actual: unknown, op: PredicateOp, expected: unknown): boolean => {
  switch (op) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'notExists':
      return actual === undefined || actual === null;
    case 'equals':
      return Object.is(actual, expected);
    case 'notEquals':
      return !Object.is(actual, expected);
    case 'contains': {
      if (typeof actual === 'string' && typeof expected === 'string') {
        return actual.includes(expected);
      }
      if (Array.isArray(actual)) return actual.includes(expected);
      return false;
    }
    case 'notContains': {
      if (typeof actual === 'string' && typeof expected === 'string') {
        return !actual.includes(expected);
      }
      if (Array.isArray(actual)) return !actual.includes(expected);
      return false;
    }
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    default:
      return false;
  }
};

/**
 * Evaluate a predicate (leaf or compound) against a result object. Compound
 * forms short-circuit: all stops on first false, any stops on first true.
 */
export const evalPredicate = (result: unknown, predicate: Predicate): boolean => {
  if ('all' in predicate && Array.isArray(predicate.all)) {
    for (const sub of predicate.all) {
      if (!evalPredicate(result, sub)) return false;
    }
    return true;
  }
  if ('any' in predicate && Array.isArray(predicate.any)) {
    for (const sub of predicate.any) {
      if (evalPredicate(result, sub)) return true;
    }
    return false;
  }
  if ('not' in predicate && predicate.not && typeof predicate.not === 'object') {
    return !evalPredicate(result, predicate.not);
  }
  const leaf = predicate as LeafPredicate;
  if (typeof leaf.op !== 'string') return false;
  return evalLeaf(resolvePath(result, leaf.path), leaf.op, leaf.value);
};

export const isLeafPredicate = (pred: Predicate): pred is LeafPredicate => {
  return typeof (pred as LeafPredicate).op === 'string';
};
