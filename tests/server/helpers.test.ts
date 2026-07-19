import { describe, expect, it } from 'vitest';

import { type Bridge } from '@/server/bridge';
import {
  type BroadcastDispatch,
  buildBroadcastContent,
  canonicalize,
  detectShadowedOuterArgs,
  formatResult,
  type ImageContent,
  parseCallArgs,
  parseClientIds,
  type TextContent,
} from '@/server/helpers';

const makeBridge = (ids: string[]): Bridge => {
  return {
    listClients: () => {
      return ids.map((id) => {
        return { id };
      });
    },
  } as unknown as Bridge;
};

const bridge = makeBridge(['ios-1', 'ios-2', 'android-1']);

describe('parseClientIds', () => {
  it('resolves undefined and null to single mode with auto-pick', () => {
    expect(parseClientIds(undefined, bridge)).toEqual({
      clientId: undefined,
      mode: 'single',
      ok: true,
    });
    expect(parseClientIds(null, bridge)).toEqual({
      clientId: undefined,
      mode: 'single',
      ok: true,
    });
  });

  it('treats a literal string as a single-client target without validating connectivity', () => {
    expect(parseClientIds('ios-1', bridge)).toEqual({
      clientId: 'ios-1',
      mode: 'single',
      ok: true,
    });
    // Literals are not pre-validated against connected clients — dispatch reports per-client.
    expect(parseClientIds('ghost-9', bridge)).toEqual({
      clientId: 'ghost-9',
      mode: 'single',
      ok: true,
    });
  });

  it('expands a regex literal against connected clients as broadcast', () => {
    expect(parseClientIds('/^ios/', bridge)).toEqual({
      ids: ['ios-1', 'ios-2'],
      mode: 'broadcast',
      ok: true,
    });
  });

  it('stays broadcast even when the regex matches exactly one client', () => {
    expect(parseClientIds('/android/', bridge)).toEqual({
      ids: ['android-1'],
      mode: 'broadcast',
      ok: true,
    });
  });

  it('unions literals and regex entries in an array with dedup', () => {
    expect(parseClientIds(['ios-2', '/^ios/', 'ios-2', 'extra-1'], bridge)).toEqual({
      ids: ['ios-2', 'ios-1', 'extra-1'],
      mode: 'broadcast',
      ok: true,
    });
  });

  it('errors on an empty array', () => {
    expect(parseClientIds([], bridge)).toEqual({
      error: 'clientId array must contain at least one entry.',
      ok: false,
    });
  });

  it('errors on non-string array entries', () => {
    expect(parseClientIds(['ios-1', 42], bridge)).toEqual({
      error: 'clientId array must contain strings only.',
      ok: false,
    });
  });

  it('errors on an invalid regex, both standalone and inside an array', () => {
    const standalone = parseClientIds('/[/', bridge);
    expect(standalone.ok).toBe(false);
    if (!standalone.ok) {
      expect(standalone.error).toContain('Invalid regex in clientId "/[/"');
    }
    const inArray = parseClientIds(['ios-1', '/[/'], bridge);
    expect(inArray.ok).toBe(false);
    if (!inArray.ok) {
      expect(inArray.error).toContain('Invalid regex in clientId "/[/"');
    }
  });

  it('errors when a regex matches no connected clients, both standalone and inside an array', () => {
    expect(parseClientIds('/^tvos/', bridge)).toEqual({
      error: 'Pattern "/^tvos/" matched no connected clients.',
      ok: false,
    });
    expect(parseClientIds(['ios-1', '/^tvos/'], bridge)).toEqual({
      error: 'Pattern "/^tvos/" matched no connected clients.',
      ok: false,
    });
  });

  it('errors on non-string non-array input', () => {
    expect(parseClientIds(42, bridge)).toEqual({
      error: 'clientId must be a string or an array of strings.',
      ok: false,
    });
  });
});

describe('buildBroadcastContent', () => {
  const image: ImageContent[] = [{ data: 'aGk=', mimeType: 'image/png', type: 'image' }];

  it('collapses text-only results into a single JSON envelope with counters', () => {
    const results: BroadcastDispatch[] = [
      { clientId: 'ios-1', result: { ok: true, result: { value: 1 } } },
      { clientId: 'android-1', result: { error: 'boom', ok: false } },
    ];
    const content = buildBroadcastContent(results, formatResult);
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe('text');
    expect(JSON.parse((content[0] as TextContent).text)).toEqual({
      failedCount: 1,
      okCount: 1,
      results: [
        { clientId: 'ios-1', ok: true, result: { value: 1 } },
        { clientId: 'android-1', error: 'boom', ok: false },
      ],
    });
  });

  it('emits per-client blocks with headers when any result carries image content', () => {
    const results: BroadcastDispatch[] = [
      { clientId: 'ios-1', result: { ok: true, result: image } },
      { clientId: 'ios-2', result: { error: 'down', ok: false } },
    ];
    const content = buildBroadcastContent(results, formatResult);
    expect(content).toEqual([
      { text: 'Broadcast: 1 ok, 1 failed (2 clients).', type: 'text' },
      { text: '## ios-1', type: 'text' },
      image[0],
      { text: '## ios-2', type: 'text' },
      { text: JSON.stringify({ error: 'down' }, null, 2), type: 'text' },
    ]);
  });
});

describe('canonicalize', () => {
  it('sorts object keys recursively and is insensitive to insertion order', () => {
    // eslint-disable-next-line sort-keys-fix/sort-keys-fix -- unsorted input is the point
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalize({ a: { c: 3, d: 2 }, b: 1 })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('sorts keys of objects nested inside arrays but keeps array order', () => {
    // eslint-disable-next-line sort-keys-fix/sort-keys-fix -- unsorted input is the point
    expect(canonicalize([{ z: 1, a: 2 }, 3])).toBe('[{"a":2,"z":1},3]');
    expect(canonicalize([2, 1])).toBe('[2,1]');
    expect(canonicalize([2, 1])).not.toBe(canonicalize([1, 2]));
  });
});

describe('detectShadowedOuterArgs', () => {
  it('returns a remediation message when clientId is nested inside args', () => {
    const message = detectShadowedOuterArgs(
      { clientId: 'ios-1' },
      'wait_until',
      'network__get_stats'
    );
    expect(message).toContain('clientId belongs to the outer wait_until() argument');
    expect(message).toContain('tool: "network__get_stats"');
  });

  it('returns null when args carry no clientId', () => {
    expect(detectShadowedOuterArgs({ url: '/api' }, 'assert', 'network__get_requests')).toBeNull();
  });
});

describe('parseCallArgs', () => {
  it('normalizes undefined, null and empty string to empty args', () => {
    expect(parseCallArgs(undefined)).toEqual({ args: {}, ok: true });
    expect(parseCallArgs(null)).toEqual({ args: {}, ok: true });
    expect(parseCallArgs('')).toEqual({ args: {}, ok: true });
  });

  it('passes a plain object through', () => {
    expect(parseCallArgs({ depth: 2 })).toEqual({ args: { depth: 2 }, ok: true });
  });

  it('parses a JSON object string', () => {
    expect(parseCallArgs('{"key":"a","depth":3}')).toEqual({
      args: { depth: 3, key: 'a' },
      ok: true,
    });
  });

  it('errors on malformed JSON', () => {
    expect(parseCallArgs('{oops')).toEqual({ error: 'Invalid JSON in args.', ok: false });
  });

  it('errors on JSON strings that parse to non-objects', () => {
    expect(parseCallArgs('[1,2]')).toEqual({ error: 'Parsed args must be an object.', ok: false });
    expect(parseCallArgs('"str"')).toEqual({ error: 'Parsed args must be an object.', ok: false });
  });

  it('errors on raw arrays and other non-object values', () => {
    expect(parseCallArgs([1, 2])).toEqual({
      error: 'args must be an object or a JSON string.',
      ok: false,
    });
    expect(parseCallArgs(42)).toEqual({
      error: 'args must be an object or a JSON string.',
      ok: false,
    });
  });
});

describe('formatResult', () => {
  it('passes image-content payloads through untouched', () => {
    const image = [{ data: 'aGk=', mimeType: 'image/png', type: 'image' }];
    expect(formatResult(image)).toBe(image);
  });

  it('serializes everything else as pretty-printed JSON text', () => {
    expect(formatResult({ a: 1 })).toEqual([
      { text: JSON.stringify({ a: 1 }, null, 2), type: 'text' },
    ]);
    expect(formatResult([{ type: 'text' }])).toEqual([
      { text: JSON.stringify([{ type: 'text' }], null, 2), type: 'text' },
    ]);
    expect(formatResult([])).toEqual([{ text: '[]', type: 'text' }]);
  });
});
