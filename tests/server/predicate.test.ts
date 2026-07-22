import { describe, expect, it } from 'vitest';

import { evalPredicate, isLeafPredicate, type Predicate, resolvePath } from '@/server/predicate';

describe('resolvePath', () => {
  const value = {
    items: [{ name: 'first' }, { name: 'second' }],
    meta: { count: 2, nested: { flag: true } },
  };

  it('returns the value itself for an empty path', () => {
    expect(resolvePath(value, undefined)).toBe(value);
    expect(resolvePath(value, '')).toBe(value);
  });

  it('drills into nested objects by dot-path', () => {
    expect(resolvePath(value, 'meta.count')).toBe(2);
    expect(resolvePath(value, 'meta.nested.flag')).toBe(true);
  });

  it('accepts numeric indices on arrays', () => {
    expect(resolvePath(value, 'items.0.name')).toBe('first');
    expect(resolvePath(value, 'items.1.name')).toBe('second');
  });

  it('responds to .length on arrays', () => {
    expect(resolvePath(value, 'items.length')).toBe(2);
    expect(resolvePath([], 'length')).toBe(0);
  });

  it('returns undefined for a non-numeric key on an array', () => {
    expect(resolvePath(value, 'items.name')).toBeUndefined();
  });

  it('returns undefined when an intermediate segment is missing or null', () => {
    expect(resolvePath(value, 'meta.missing.deep')).toBeUndefined();
    expect(resolvePath({ a: null }, 'a.b')).toBeUndefined();
  });

  it('returns undefined when drilling into a primitive', () => {
    expect(resolvePath(value, 'meta.count.digits')).toBeUndefined();
  });

  it('handles out-of-bounds array indices as undefined', () => {
    expect(resolvePath(value, 'items.5')).toBeUndefined();
  });

  it('accepts bracket indices, including at the path root', () => {
    expect(resolvePath(value, 'items[0].name')).toBe('first');
    expect(resolvePath([{ mock: { id: 3 } }], '[0].mock.id')).toBe(3);
  });

  it('accepts negative bracket indices as from-the-end access', () => {
    expect(resolvePath(value, 'items[-1].name')).toBe('second');
    expect(resolvePath([1, 2, 3], '[-2]')).toBe(2);
    expect(resolvePath(value, 'items[-5].name')).toBeUndefined();
  });
});

describe('evalPredicate — leaf ops', () => {
  const result = {
    count: 3,
    empty: null,
    list: [1, 2, 3],
    status: 'success',
    zero: 0,
  };

  it('equals / notEquals use Object.is semantics', () => {
    expect(evalPredicate(result, { op: 'equals', path: 'status', value: 'success' })).toBe(true);
    expect(evalPredicate(result, { op: 'equals', path: 'status', value: 'error' })).toBe(false);
    expect(evalPredicate(result, { op: 'notEquals', path: 'status', value: 'error' })).toBe(true);
    expect(evalPredicate(result, { op: 'notEquals', path: 'status', value: 'success' })).toBe(
      false
    );
    expect(evalPredicate({ x: Number.NaN }, { op: 'equals', path: 'x', value: Number.NaN })).toBe(
      true
    );
  });

  it('exists treats null and undefined as absent, falsy values as present', () => {
    expect(evalPredicate(result, { op: 'exists', path: 'zero' })).toBe(true);
    expect(evalPredicate(result, { op: 'exists', path: 'empty' })).toBe(false);
    expect(evalPredicate(result, { op: 'exists', path: 'missing' })).toBe(false);
    expect(evalPredicate(result, { op: 'notExists', path: 'missing' })).toBe(true);
    expect(evalPredicate(result, { op: 'notExists', path: 'empty' })).toBe(true);
    expect(evalPredicate(result, { op: 'notExists', path: 'zero' })).toBe(false);
  });

  it('contains matches substrings on strings and members on arrays', () => {
    expect(evalPredicate(result, { op: 'contains', path: 'status', value: 'succ' })).toBe(true);
    expect(evalPredicate(result, { op: 'contains', path: 'status', value: 'fail' })).toBe(false);
    expect(evalPredicate(result, { op: 'contains', path: 'list', value: 2 })).toBe(true);
    expect(evalPredicate(result, { op: 'contains', path: 'list', value: 5 })).toBe(false);
  });

  it('contains is false for non-string expected on strings and for non-container actuals', () => {
    expect(evalPredicate(result, { op: 'contains', path: 'status', value: 3 })).toBe(false);
    expect(evalPredicate(result, { op: 'contains', path: 'count', value: 3 })).toBe(false);
  });

  it('notContains mirrors contains on containers but is false for non-containers', () => {
    expect(evalPredicate(result, { op: 'notContains', path: 'status', value: 'fail' })).toBe(true);
    expect(evalPredicate(result, { op: 'notContains', path: 'status', value: 'succ' })).toBe(false);
    expect(evalPredicate(result, { op: 'notContains', path: 'list', value: 5 })).toBe(true);
    expect(evalPredicate(result, { op: 'notContains', path: 'list', value: 2 })).toBe(false);
    expect(evalPredicate(result, { op: 'notContains', path: 'count', value: 3 })).toBe(false);
  });

  it('gt / gte / lt / lte compare numbers', () => {
    expect(evalPredicate(result, { op: 'gt', path: 'count', value: 2 })).toBe(true);
    expect(evalPredicate(result, { op: 'gt', path: 'count', value: 3 })).toBe(false);
    expect(evalPredicate(result, { op: 'gte', path: 'count', value: 3 })).toBe(true);
    expect(evalPredicate(result, { op: 'gte', path: 'count', value: 4 })).toBe(false);
    expect(evalPredicate(result, { op: 'lt', path: 'count', value: 4 })).toBe(true);
    expect(evalPredicate(result, { op: 'lt', path: 'count', value: 3 })).toBe(false);
    expect(evalPredicate(result, { op: 'lte', path: 'count', value: 3 })).toBe(true);
    expect(evalPredicate(result, { op: 'lte', path: 'count', value: 2 })).toBe(false);
  });

  it('numeric comparisons are false when either side is not a number', () => {
    expect(evalPredicate(result, { op: 'gt', path: 'status', value: 2 })).toBe(false);
    expect(evalPredicate(result, { op: 'lte', path: 'count', value: '3' })).toBe(false);
    expect(evalPredicate(result, { op: 'gte', path: 'missing', value: 0 })).toBe(false);
  });

  it('evaluates against the root when path is omitted', () => {
    expect(evalPredicate(7, { op: 'equals', value: 7 })).toBe(true);
    expect(evalPredicate([1, 2], { op: 'contains', value: 1 })).toBe(true);
    expect(evalPredicate([1, 2], { op: 'equals', path: 'length', value: 2 })).toBe(true);
  });

  it('is false for a leaf without a string op', () => {
    expect(evalPredicate(result, {} as Predicate)).toBe(false);
    expect(evalPredicate(result, { op: 42 } as unknown as Predicate)).toBe(false);
  });
});

describe('evalPredicate — compound forms', () => {
  const result = { count: 3, status: 'success' };

  it('all is a conjunction', () => {
    expect(
      evalPredicate(result, {
        all: [
          { op: 'equals', path: 'status', value: 'success' },
          { op: 'gt', path: 'count', value: 2 },
        ],
      })
    ).toBe(true);
    expect(
      evalPredicate(result, {
        all: [
          { op: 'equals', path: 'status', value: 'success' },
          { op: 'gt', path: 'count', value: 5 },
        ],
      })
    ).toBe(false);
    expect(evalPredicate(result, { all: [] })).toBe(true);
  });

  it('any is a disjunction', () => {
    expect(
      evalPredicate(result, {
        any: [
          { op: 'equals', path: 'status', value: 'error' },
          { op: 'gt', path: 'count', value: 2 },
        ],
      })
    ).toBe(true);
    expect(
      evalPredicate(result, {
        any: [
          { op: 'equals', path: 'status', value: 'error' },
          { op: 'gt', path: 'count', value: 5 },
        ],
      })
    ).toBe(false);
    expect(evalPredicate(result, { any: [] })).toBe(false);
  });

  it('not negates', () => {
    expect(evalPredicate(result, { not: { op: 'equals', path: 'status', value: 'error' } })).toBe(
      true
    );
    expect(evalPredicate(result, { not: { op: 'equals', path: 'status', value: 'success' } })).toBe(
      false
    );
  });

  it('compound forms nest', () => {
    const nested: Predicate = {
      all: [
        {
          any: [
            { op: 'equals', path: 'status', value: 'error' },
            { op: 'gte', path: 'count', value: 3 },
          ],
        },
        { not: { op: 'notExists', path: 'status' } },
      ],
    };
    expect(evalPredicate(result, nested)).toBe(true);
    expect(evalPredicate({ count: 1 }, nested)).toBe(false);
  });
});

describe('isLeafPredicate', () => {
  it('identifies leaves by a string op', () => {
    expect(isLeafPredicate({ op: 'exists' })).toBe(true);
    expect(isLeafPredicate({ all: [{ op: 'exists' }] })).toBe(false);
    expect(isLeafPredicate({ not: { op: 'exists' } })).toBe(false);
  });
});
