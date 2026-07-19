import { describe, expect, it } from 'vitest';

import {
  applyProjection,
  type CollapseRule,
  DEFAULT_PREVIEW_CAP,
  isMarker,
  projectAsValue,
  projectValue,
} from '@/shared/projection/projectValue';

describe('projectValue — primitives and depth', () => {
  it('passes primitives through and reports serialized byte size', () => {
    expect(projectValue(42)).toEqual({ bytes: 2, truncated: false, value: 42 });
    expect(projectValue(true).value).toBe(true);
    expect(projectValue(null).value).toBeNull();
    expect(projectValue('short').value).toBe('short');
  });

  it('collapses nested containers to ${obj}/${arr} markers at default depth 1', () => {
    const { value } = projectValue({ list: [1, 2], nested: { a: 1, b: 2 } });
    expect(value).toEqual({
      list: { '${arr}': 2 },
      nested: { '${obj}': 2 },
    });
  });

  it('collapses the whole value at depth 0', () => {
    expect(projectValue({ a: 1, b: 2 }, { depth: 0 }).value).toEqual({ '${obj}': 2 });
    expect(projectValue([1, 2, 3], { depth: 0 }).value).toEqual({ '${arr}': 3 });
  });

  it('expands one more level per unit of depth', () => {
    const input = { nested: { inner: { leaf: 1 } } };
    expect(projectValue(input, { depth: 2 }).value).toEqual({
      nested: { inner: { '${obj}': 1 } },
    });
    expect(projectValue(input, { depth: 3 }).value).toEqual(input);
  });

  it('clamps depth to MAX_DEPTH (8)', () => {
    // 11 nested objects: levels 1..8 expand, level 9 must collapse.
    let chain: Record<string, unknown> = { end: true };
    for (let i = 0; i < 10; i += 1) {
      chain = { child: chain };
    }
    let node = projectValue(chain, { depth: 99 }).value as Record<string, unknown>;
    for (let i = 0; i < 7; i += 1) {
      node = node.child as Record<string, unknown>;
    }
    expect(node.child).toEqual({ '${obj}': 1 });
  });

  it('falls back to the default depth for negative or non-finite depth', () => {
    expect(projectValue({ a: { b: 1 } }, { depth: -3 }).value).toEqual({ a: { '${obj}': 1 } });
    expect(projectValue({ a: { b: 1 } }, { depth: Number.NaN }).value).toEqual({
      a: { '${obj}': 1 },
    });
  });
});

describe('projectValue — special markers', () => {
  it('renders Date, RegExp, Error, Map, Set as markers even inside the depth budget', () => {
    const date = new Date('2026-07-19T10:00:00.000Z');
    const { value } = projectValue(
      {
        date,
        err: new Error('boom'),
        map: new Map([['k', 1]]),
        regex: /ab+c/gi,
        set: new Set([1, 2, 3]),
      },
      { depth: 5 }
    );
    expect(value).toEqual({
      date: { '${Date}': '2026-07-19T10:00:00.000Z' },
      err: { '${Err}': { msg: 'boom', name: 'Error' } },
      map: { '${map}': 1 },
      regex: { '${RegExp}': '/ab+c/gi' },
      set: { '${set}': 3 },
    });
  });

  it('renders functions with their name and <anon> fallback', () => {
    const named = function myFn() {
      return undefined;
    };
    const [anonymous] = [
      function () {
        return undefined;
      },
    ];
    const { value } = projectValue({ anonymous, named });
    expect(value).toEqual({
      anonymous: { '${fun}': '<anon>' },
      named: { '${fun}': 'myFn' },
    });
  });

  it('renders symbols and bigints as markers', () => {
    const { value } = projectValue({ big: 123n, sym: Symbol('tag') });
    expect(value).toEqual({
      big: { '${bigint}': '123' },
      sym: { '${sym}': 'Symbol(tag)' },
    });
  });

  it('renders class instances beyond depth as ${cls} with name and key count', () => {
    class Point {
      x = 1;
      y = 2;
    }
    expect(projectValue({ p: new Point() }).value).toEqual({
      p: { '${cls}': { len: 2, name: 'Point' } },
    });
    // Inside the depth budget the instance expands like a plain object.
    expect(projectValue({ p: new Point() }, { depth: 2 }).value).toEqual({ p: { x: 1, y: 2 } });
  });

  it('marks cycles with ${cyc}', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    expect(projectValue(cyclic, { depth: 4 }).value).toEqual({
      name: 'root',
      self: { '${cyc}': true },
    });
  });
});

describe('projectValue — strings and previewCap', () => {
  it('keeps strings at or below previewCap raw', () => {
    const exact = 'x'.repeat(DEFAULT_PREVIEW_CAP);
    expect(projectValue(exact).value).toBe(exact);
  });

  it('collapses long strings to a ${str} marker with len and preview', () => {
    const long = 'a'.repeat(300);
    expect(projectValue(long).value).toEqual({
      '${str}': { len: 300, preview: 'a'.repeat(DEFAULT_PREVIEW_CAP) },
    });
  });

  it('honours a custom previewCap, also for nested strings', () => {
    expect(projectValue({ note: 'abcdef' }, { previewCap: 4 }).value).toEqual({
      note: { '${str}': { len: 6, preview: 'abcd' } },
    });
  });
});

describe('projectValue — width caps', () => {
  it('caps wide objects and prepends a ${truncated} sentinel', () => {
    const { value } = projectValue({ a: 1, b: 2, c: 3, d: 4 }, { objectCap: 2 });
    expect(value).toEqual({
      '${truncated}': { slice: [0, 2], total: 4 },
      a: 1,
      b: 2,
    });
    expect(Object.keys(value as Record<string, unknown>)[0]).toBe('${truncated}');
  });

  it('caps wide arrays with the sentinel as the first item', () => {
    expect(projectValue([1, 2, 3, 4, 5], { arrayCap: 3 }).value).toEqual([
      { '${truncated}': { slice: [0, 3], total: 5 } },
      1,
      2,
      3,
    ]);
  });

  it('leaves containers at the cap untouched', () => {
    expect(projectValue([1, 2], { arrayCap: 2 }).value).toEqual([1, 2]);
    expect(projectValue({ a: 1, b: 2 }, { objectCap: 2 }).value).toEqual({ a: 1, b: 2 });
  });
});

describe('projectValue — maxBytes', () => {
  it('replaces oversized results with a ${str} marker carrying size and preview', () => {
    const result = projectValue({ data: 'y'.repeat(100) }, { maxBytes: 50, previewCap: 500 });
    const serialized = JSON.stringify({ data: 'y'.repeat(100) });
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(serialized.length);
    expect(result.value).toEqual({
      '${str}': { len: serialized.length, preview: serialized.slice(0, 50) },
    });
  });

  it('reports bytes without truncation when under the cap', () => {
    const result = projectValue({ a: 1 });
    expect(result).toEqual({ bytes: 7, truncated: false, value: { a: 1 } });
  });
});

describe('projectValue — path drill', () => {
  const input = {
    items: [
      { body: { deep: { leaf: 1 } }, name: 'first' },
      { body: { deep: { leaf: 2 } }, name: 'second' },
    ],
    log: 'z'.repeat(500),
  };

  it('resolves the path before projecting', () => {
    expect(projectValue(input, { path: 'items[0].name' }).value).toBe('first');
    expect(projectValue(input, { path: 'items[-1].name' }).value).toBe('second');
    expect(projectValue(input, { depth: 3, path: 'items[0].body' }).value).toEqual({
      deep: { leaf: 1 },
    });
  });

  it('projects an array slice under the normal depth rules', () => {
    expect(projectValue(input, { path: 'items[0:2]' }).value).toEqual([
      { '${obj}': 2 },
      { '${obj}': 2 },
    ]);
  });

  it('returns an error with validUpTo for an unresolvable path', () => {
    expect(projectValue(input, { path: 'items[0].missing' })).toEqual({
      bytes: 0,
      truncated: false,
      value: { error: 'Key "missing" not found', validUpTo: 'items[0]' },
    });
  });

  it('returns a raw substring when the path ends in a slice on a string (previewCap bypass)', () => {
    const result = projectValue(input, { path: 'log[0:300]' });
    expect(result).toEqual({ bytes: 300, truncated: false, value: 'z'.repeat(300) });
  });

  it('still applies previewCap when the path lands on a string without a slice', () => {
    expect(projectValue(input, { path: 'log' }).value).toEqual({
      '${str}': { len: 500, preview: 'z'.repeat(DEFAULT_PREVIEW_CAP) },
    });
  });

  it('applies only maxBytes to a sliced string, with a marker when exceeded', () => {
    const result = projectValue(input, { maxBytes: 100, path: 'log[0:400]', previewCap: 10 });
    expect(result).toEqual({
      bytes: 400,
      truncated: true,
      value: { '${str}': { len: 400, preview: 'z'.repeat(10) } },
    });
  });
});

describe('projectValue — redact and skipKeys', () => {
  it('does not redact anything by default', () => {
    expect(projectValue({ password: 'hunter2' }).value).toEqual({ password: 'hunter2' });
  });

  it('redacts keys case-insensitively by exact string match', () => {
    const { value } = projectValue(
      { PASSWORD: 'a', passwords: 'b', token: { nested: 'c' } },
      { depth: 2, redact: ['Password', 'token'] }
    );
    expect(value).toEqual({
      PASSWORD: '[redacted]',
      passwords: 'b',
      token: '[redacted]',
    });
  });

  it('redacts keys matching a RegExp pattern', () => {
    expect(projectValue({ apiKey: 'x', name: 'y' }, { redact: [/Key$/] }).value).toEqual({
      apiKey: '[redacted]',
      name: 'y',
    });
  });

  it('drops skipKeys entries entirely, by exact name and by RegExp', () => {
    const { value } = projectValue(
      { _internal: 3, drop: 2, keep: 1 },
      { skipKeys: ['drop', /^_/] }
    );
    expect(value).toEqual({ keep: 1 });
  });

  it('excludes skipped keys from the objectCap total', () => {
    const { value } = projectValue(
      { _a: 1, _b: 2, x: 3, y: 4 },
      { objectCap: 2, skipKeys: [/^_/] }
    );
    expect(value).toEqual({ x: 3, y: 4 });
  });
});

describe('projectValue — collapse rules', () => {
  class FiberRef {
    tag = 5;
  }

  it('lets a matching rule replace the value with a custom marker', () => {
    const rule: CollapseRule = (value) => {
      if (value instanceof FiberRef) return { '${fiber}': value.tag };
      return undefined;
    };
    expect(projectValue({ node: new FiberRef() }, { collapse: [rule], depth: 3 }).value).toEqual({
      node: { '${fiber}': 5 },
    });
  });

  it('falls through to default handling when no rule matches', () => {
    const rule: CollapseRule = () => {
      return undefined;
    };
    expect(projectValue({ node: new FiberRef() }, { collapse: [rule], depth: 2 }).value).toEqual({
      node: { tag: 5 },
    });
  });
});

describe('projectAsValue and applyProjection', () => {
  it('projectAsValue drops the bytes/truncated envelope', () => {
    expect(projectAsValue({ a: { b: 1 } }, {})).toEqual({ a: { '${obj}': 1 } });
  });

  it('applyProjection uses defaultDepth when args carry no depth', () => {
    const input = { a: { b: { c: 1 } } };
    expect(applyProjection(input, {}, projectAsValue, 2)).toEqual({ a: { b: { '${obj}': 1 } } });
  });

  it('applyProjection prefers explicit args over defaultDepth and forwards the other knobs', () => {
    const input = { a: { b: { c: 1 } }, note: 'abcdef' };
    expect(applyProjection(input, { depth: 1, previewCap: 4 }, projectAsValue, 2)).toEqual({
      a: { '${obj}': 1 },
      note: { '${str}': { len: 6, preview: 'abcd' } },
    });
    expect(applyProjection(input, { path: 'a.b.c' }, projectAsValue, 2)).toBe(1);
  });
});

describe('isMarker', () => {
  it('recognizes single-key ${...} objects only', () => {
    expect(isMarker({ '${obj}': 3 })).toBe(true);
    expect(isMarker({ '${str}': { len: 1, preview: 'a' } })).toBe(true);
    expect(isMarker({ '${obj}': 3, extra: 1 })).toBe(false);
    expect(isMarker({ plain: 1 })).toBe(false);
    expect(isMarker(['${arr}'])).toBe(false);
    expect(isMarker('${obj}')).toBe(false);
    expect(isMarker(null)).toBe(false);
  });
});

describe('projectValue — aliasing vs cycles', () => {
  it('renders a repeated sibling reference normally (DAG, not a cycle)', () => {
    const shared = { deep: { value: 1 } };
    const result = projectValue({ a: shared, b: shared }, { depth: 8 }).value as Record<
      string,
      unknown
    >;
    expect(result.a).toEqual({ deep: { value: 1 } });
    expect(result.b).toEqual({ deep: { value: 1 } });
  });

  it('still marks a true cycle with ${cyc}', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;
    const result = projectValue(node, { depth: 8 }).value as Record<string, unknown>;
    expect(result.self).toEqual({ ['${cyc}']: true });
  });

  it('re-walks the same object again after backtracking out of its subtree', () => {
    const shared = { x: 1 };
    const result = projectValue([shared, [shared]], { depth: 8 }).value as unknown[];
    expect(result[0]).toEqual({ x: 1 });
    expect(result[1]).toEqual([{ x: 1 }]);
  });
});
