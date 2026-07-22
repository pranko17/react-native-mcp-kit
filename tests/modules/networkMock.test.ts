// This import must stay FIRST — evaluating the helper installs the RN-shaped
// XMLHttpRequest double as a global before '@/modules/network' evaluates and
// attaches its patches (ESM evaluates modules in import-declaration order).
// eslint-disable-next-line import/order
import { FakeXHR } from './helpers/fakeXhr';

import { beforeEach, describe, expect, it } from 'vitest';

import { type McpModule } from '@/client/models/types';
import { networkModule } from '@/modules/network';
import { applyJsonPatch, jsonMergePatch } from '@/modules/network/mocks';

const mod: McpModule = networkModule();

const call = (tool: string, args: Record<string, unknown> = {}): unknown => {
  return mod.tools[tool]!.handler(args);
};

interface ProjectedEntry {
  id: number;
  method: string;
  response: { headers: Record<string, string>; status: number; body?: unknown } | null;
  status: string;
  url: string;
  mock?: { id: number; mode: string; originalStatus?: number };
}

const getRequests = (): ProjectedEntry[] => {
  return call('get_requests', { depth: 6 }) as ProjectedEntry[];
};

interface FakeXhrLike {
  abort: () => void;
  getAllResponseHeaders: () => string;
  getResponseHeader: (name: string) => string | null;
  onabort: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onload: ((ev: unknown) => void) | null;
  ontimeout: ((ev: unknown) => void) | null;
  response: unknown;
  responseText: string;
  responseType: string;
  status: number;
}

interface RequestResult {
  events: string[];
  xhr: FakeXhrLike;
}

const request = (
  url: string,
  {
    body,
    method = 'GET',
    responseType = '',
  }: { body?: string; method?: string; responseType?: string } = {}
): Promise<RequestResult> => {
  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const xhr = new (globalThis as any).XMLHttpRequest() as FakeXhrLike & FakeXHR;
    const events: string[] = [];
    xhr.onload = () => {
      events.push('load');
    };
    xhr.onerror = () => {
      events.push('error');
    };
    xhr.ontimeout = () => {
      events.push('timeout');
    };
    xhr.onabort = () => {
      events.push('abort');
    };
    xhr.onloadend = () => {
      events.push('loadend');
      resolve({ events, xhr });
    };
    xhr.open(method, url);
    xhr.responseType = responseType;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (xhr.send as any)(body);
  });
};

beforeEach(() => {
  call('clear_requests');
  call('clear_mocks');
  FakeXHR.routes = {};
});

describe('network mocks — replace mode', () => {
  it('synthesizes status, body and headers without touching the network', async () => {
    call('set_mock', {
      mode: 'replace',
      response: {
        body: { error: 'unavailable' },
        headers: { 'x-mocked': 'yes' },
        status: 503,
      },
      url: '/maintenance',
    });
    const { events, xhr } = await request('https://api.test/maintenance');

    expect(xhr.status).toBe(503);
    expect(JSON.parse(xhr.responseText)).toEqual({ error: 'unavailable' });
    expect(xhr.getResponseHeader('X-Mocked')).toBe('yes');
    expect(xhr.getAllResponseHeaders()).toContain('content-type: application/json');
    expect(events).toEqual(['load', 'loadend']);

    const entry = getRequests()[0]!;
    expect(entry.status).toBe('error');
    expect(entry.response?.status).toBe(503);
    expect(entry.mock).toMatchObject({ mode: 'replace' });
  });

  it('serves responseType json as a parsed object', async () => {
    call('set_mock', {
      mode: 'replace',
      response: { body: { items: [1, 2] }, status: 200 },
      url: '/list',
    });
    const { xhr } = await request('https://api.test/list', { responseType: 'json' });
    expect(xhr.response).toEqual({ items: [1, 2] });
  });

  it('honours delayMs', async () => {
    call('set_mock', {
      delayMs: 40,
      mode: 'replace',
      response: { status: 200 },
      url: '/slow',
    });
    const started = Date.now();
    await request('https://api.test/slow');
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  });

  it('supports abort during the mock delay', async () => {
    call('set_mock', {
      delayMs: 5_000,
      mode: 'replace',
      response: { status: 200 },
      url: '/aborted',
    });
    const result = await new Promise<RequestResult>((resolve) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const xhr = new (globalThis as any).XMLHttpRequest() as FakeXhrLike & FakeXHR;
      const events: string[] = [];
      xhr.onabort = () => {
        events.push('abort');
      };
      xhr.onloadend = () => {
        events.push('loadend');
        resolve({ events, xhr });
      };
      xhr.open('GET', 'https://api.test/aborted');
      xhr.send();
      setTimeout(() => {
        xhr.abort();
      }, 10);
    });
    expect(result.events).toEqual(['abort', 'loadend']);
    expect(result.xhr.status).toBe(0);
  });
});

describe('network mocks — modify mode', () => {
  it('patches the status while keeping the real body, and records originalStatus', async () => {
    call('set_mock', { mode: 'modify', patch: { status: 500 }, url: '/orders' });
    const { xhr } = await request('https://api.test/orders');

    expect(xhr.status).toBe(500);
    expect(JSON.parse(xhr.responseText)).toEqual({ real: true });

    const entry = getRequests()[0]!;
    expect(entry.status).toBe('error');
    expect(entry.mock).toMatchObject({ mode: 'modify', originalStatus: 200 });
  });

  it('applies an RFC 7396 merge patch over the real JSON body', async () => {
    FakeXHR.routes['https://api.test/cart'] = {
      body: JSON.stringify({ feature: { enabled: true, retries: 10 }, keep: 'yes' }),
      headers: { 'content-type': 'application/json' },
      status: 200,
    };
    call('set_mock', {
      mode: 'modify',
      patch: { bodyMergePatch: { feature: { enabled: false }, keep: null } },
      url: '/cart',
    });
    const { xhr } = await request('https://api.test/cart');

    expect(JSON.parse(xhr.responseText)).toEqual({ feature: { enabled: false, retries: 10 } });
    expect(xhr.status).toBe(200);
  });

  it('patches the parsed object for responseType json', async () => {
    FakeXHR.routes['https://api.test/profile'] = {
      body: JSON.stringify({ premium: false }),
      headers: {},
      status: 200,
    };
    call('set_mock', {
      mode: 'modify',
      patch: { bodyMergePatch: { premium: true } },
      url: '/profile',
    });
    const { xhr } = await request('https://api.test/profile', { responseType: 'json' });
    expect(xhr.response).toEqual({ premium: true });
  });

  it('replaces the body wholesale via patch.body', async () => {
    call('set_mock', { mode: 'modify', patch: { body: { swapped: true } }, url: '/swap' });
    const { xhr } = await request('https://api.test/swap');
    expect(JSON.parse(xhr.responseText)).toEqual({ swapped: true });
  });

  it('merges patched headers over the real ones case-insensitively', async () => {
    call('set_mock', {
      mode: 'modify',
      patch: { headers: { 'X-Extra': 'added', 'x-served-by': 'mock' } },
      url: '/headers',
    });
    const { xhr } = await request('https://api.test/headers');

    expect(xhr.getResponseHeader('x-served-by')).toBe('mock');
    expect(xhr.getResponseHeader('x-extra')).toBe('added');
    expect(xhr.getAllResponseHeaders()).toContain('x-served-by: mock');
    expect(xhr.getAllResponseHeaders()).toContain('content-type: application/json');
  });
});

describe('network mocks — error and timeout modes', () => {
  it('error mode fires onerror with status 0', async () => {
    call('set_mock', { mode: 'error', url: '/broken' });
    const { events, xhr } = await request('https://api.test/broken');
    expect(events).toEqual(['error', 'loadend']);
    expect(xhr.status).toBe(0);
    expect(getRequests()[0]!.status).toBe('error');
  });

  it('timeout mode fires ontimeout', async () => {
    call('set_mock', { mode: 'timeout', url: '/hang' });
    const { events } = await request('https://api.test/hang');
    expect(events).toEqual(['timeout', 'loadend']);
  });
});

describe('network mocks — matching and lifecycle', () => {
  it('matches by /regex/ and by method, first match wins', async () => {
    call('set_mock', {
      method: 'POST',
      mode: 'replace',
      response: { status: 201 },
      url: '/\\/items\\/\\d+/',
    });
    call('set_mock', { mode: 'replace', response: { status: 418 }, url: '/items/' });

    const viaGet = await request('https://api.test/items/42');
    expect(viaGet.xhr.status).toBe(418);

    const viaPost = await request('https://api.test/items/42', { method: 'POST' });
    expect(viaPost.xhr.status).toBe(201);
  });

  it('times limits consumption and deactivates the mock', async () => {
    call('set_mock', { mode: 'replace', response: { status: 503 }, times: 1, url: '/once' });

    const first = await request('https://api.test/once');
    expect(first.xhr.status).toBe(503);

    const second = await request('https://api.test/once');
    expect(second.xhr.status).toBe(200);

    const mocks = call('list_mocks') as Array<Record<string, unknown>>;
    expect(mocks[0]).toMatchObject({ active: false, hits: 1, remaining: 0 });
  });

  it('remove_mock and clear_mocks stop matching', async () => {
    const created = call('set_mock', {
      mode: 'replace',
      response: { status: 503 },
      url: '/gone',
    }) as { id: number };
    expect((call('remove_mock', { id: created.id }) as { removed: boolean }).removed).toBe(true);

    call('set_mock', { mode: 'replace', response: { status: 503 }, url: '/gone' });
    expect((call('clear_mocks') as { removed: number }).removed).toBe(1);

    const { xhr } = await request('https://api.test/gone');
    expect(xhr.status).toBe(200);
  });

  it('rejects a modify mock without a patch and an invalid url regex', () => {
    expect(call('set_mock', { mode: 'modify', url: '/x' })).toHaveProperty('error');
    expect(call('set_mock', { mode: 'replace', url: '/(/' })).toHaveProperty('error');
  });

  it('ignored URLs bypass mocks entirely', async () => {
    call('set_mock', { mode: 'replace', response: { status: 503 }, url: 'symbolicate' });
    const { xhr } = await request('https://api.test/symbolicate');
    expect(xhr.status).toBe(200);
    const mocks = call('list_mocks') as Array<Record<string, unknown>>;
    expect(mocks[0]).toMatchObject({ hits: 0 });
  });
});

describe('network mocks — body matching', () => {
  it('routes two mocks on one URL by a field of the JSON body', async () => {
    call('set_mock', {
      bodyMatch: { 'data.type': 'courier' },
      mode: 'replace',
      response: { status: 503 },
      url: '/intervals-endpoint',
    });
    call('set_mock', {
      bodyMatch: { 'data.type': 'window' },
      mode: 'replace',
      response: { status: 500 },
      url: '/intervals-endpoint',
    });

    const courier = await request('https://api.test/intervals-endpoint', {
      body: JSON.stringify({ data: { city: 1, type: 'courier' } }),
      method: 'POST',
    });
    const window = await request('https://api.test/intervals-endpoint', {
      body: JSON.stringify({ data: { city: 1, type: 'window' } }),
      method: 'POST',
    });

    expect(courier.xhr.status).toBe(503);
    expect(window.xhr.status).toBe(500);
  });

  it('body-constrained mocks never match bodyless requests', async () => {
    call('set_mock', {
      bodyContains: 'anything',
      mode: 'replace',
      response: { status: 503 },
      url: '/plain',
    });
    const { xhr } = await request('https://api.test/plain');
    expect(xhr.status).toBe(200);
    const mocks = call('list_mocks') as Array<Record<string, unknown>>;
    expect(mocks[0]).toMatchObject({ hits: 0 });
  });

  it('supports contains / regex value matchers and strict number equality', async () => {
    call('set_mock', {
      bodyMatch: {
        'data.city': 42,
        'data.note': { contains: 'urgent' },
        'data.slot': { regex: '/^slot-\\d+$/' },
      },
      mode: 'replace',
      response: { status: 503 },
      url: '/matchers',
    });
    const hit = await request('https://api.test/matchers', {
      body: JSON.stringify({ data: { city: 42, note: 'very urgent order', slot: 'slot-7' } }),
      method: 'POST',
    });
    const missCity = await request('https://api.test/matchers', {
      body: JSON.stringify({ data: { city: '42', note: 'very urgent order', slot: 'slot-7' } }),
      method: 'POST',
    });
    expect(hit.xhr.status).toBe(503);
    expect(missCity.xhr.status).toBe(200);
  });

  it('ANDs every bodyMatch entry and rejects non-JSON bodies', async () => {
    call('set_mock', {
      bodyMatch: { a: 1, b: 2 },
      mode: 'replace',
      response: { status: 503 },
      url: '/strict',
    });
    const partial = await request('https://api.test/strict', {
      body: JSON.stringify({ a: 1, b: 999 }),
      method: 'POST',
    });
    const nonJson = await request('https://api.test/strict', {
      body: 'a=1&b=2',
      method: 'POST',
    });
    expect(partial.xhr.status).toBe(200);
    expect(nonJson.xhr.status).toBe(200);
  });

  it('bodyContains matches a substring of the raw body', async () => {
    call('set_mock', {
      bodyContains: 'address_id',
      mode: 'replace',
      response: { status: 503 },
      url: '/raw',
    });
    const hit = await request('https://api.test/raw', {
      body: JSON.stringify({ type: 'address_id_lookup' }),
      method: 'POST',
    });
    expect(hit.xhr.status).toBe(503);
  });

  it('drills bracket indices, negative indices and array length', async () => {
    call('set_mock', {
      bodyMatch: {
        'items[-1].sku': { regex: '/^B-/' },
        'items[0].sku': 'A-1',
        'items.length': 2,
      },
      mode: 'replace',
      response: { status: 503 },
      url: '/paths',
    });
    const hit = await request('https://api.test/paths', {
      body: JSON.stringify({ items: [{ sku: 'A-1' }, { sku: 'B-2' }] }),
      method: 'POST',
    });
    const wrongLength = await request('https://api.test/paths', {
      body: JSON.stringify({ items: [{ sku: 'A-1' }, { sku: 'B-2' }, { sku: 'C-3' }] }),
      method: 'POST',
    });
    expect(hit.xhr.status).toBe(503);
    expect(wrongLength.xhr.status).toBe(200);
  });

  it('rejects an invalid bodyMatch regex at set time', () => {
    expect(
      call('set_mock', {
        bodyMatch: { field: { regex: '/(/' } },
        mode: 'replace',
        url: '/x',
      })
    ).toHaveProperty('error');
  });
});

describe('network mocks — bodyJsonPatch', () => {
  it('removes array elements by index over the real body', async () => {
    FakeXHR.routes['https://api.test/slots'] = {
      body: JSON.stringify({ slots: ['09:00', '11:00', '13:00', '15:00'], total: 4 }),
      headers: { 'content-type': 'application/json' },
      status: 200,
    };
    call('set_mock', {
      mode: 'modify',
      patch: {
        bodyJsonPatch: [
          { op: 'remove', path: '/slots/3' },
          { op: 'remove', path: '/slots/1' },
          { op: 'replace', path: '/total', value: 2 },
        ],
      },
      url: '/slots',
    });
    const { xhr } = await request('https://api.test/slots');
    expect(JSON.parse(xhr.responseText)).toEqual({ slots: ['09:00', '13:00'], total: 2 });
    expect(getRequests()[0]!.mock).toMatchObject({ mode: 'modify' });
    expect(getRequests()[0]!.mock).not.toHaveProperty('patchError');
  });

  it('applies json patch after the merge patch when both are present', async () => {
    FakeXHR.routes['https://api.test/combo'] = {
      body: JSON.stringify({ flag: false, items: [1, 2, 3] }),
      headers: {},
      status: 200,
    };
    call('set_mock', {
      mode: 'modify',
      patch: {
        bodyJsonPatch: [{ op: 'remove', path: '/items/0' }],
        bodyMergePatch: { flag: true },
      },
      url: '/combo',
    });
    const { xhr } = await request('https://api.test/combo');
    expect(JSON.parse(xhr.responseText)).toEqual({ flag: true, items: [2, 3] });
  });

  it('delivers the body unpatched and flags patchError when an op fails', async () => {
    call('set_mock', {
      mode: 'modify',
      patch: { bodyJsonPatch: [{ op: 'remove', path: '/missing/9' }] },
      url: '/badpatch',
    });
    const { xhr } = await request('https://api.test/badpatch');
    expect(JSON.parse(xhr.responseText)).toEqual({ real: true });
    const entry = getRequests()[0]!;
    expect(entry.mock).toMatchObject({ mode: 'modify' });
    expect((entry.mock as { patchError?: string }).patchError).toContain('missing');
  });

  it('rejects a modify mock whose only patch key is an empty bodyJsonPatch', () => {
    expect(call('set_mock', { mode: 'modify', patch: {}, url: '/x' })).toHaveProperty('error');
  });
});

describe('applyJsonPatch', () => {
  it('supports add with array append, move, copy and test', () => {
    const doc = { list: [1, 2], meta: { keep: true } };
    expect(
      applyJsonPatch(doc, [
        { op: 'test', path: '/meta/keep', value: true },
        { op: 'add', path: '/list/-', value: 3 },
        { from: '/meta', op: 'copy', path: '/metaCopy' },
        { from: '/list/0', op: 'move', path: '/first' },
      ])
    ).toEqual({ first: 1, list: [2, 3], meta: { keep: true }, metaCopy: { keep: true } });
    // original untouched — ops run on a clone
    expect(doc).toEqual({ list: [1, 2], meta: { keep: true } });
  });

  it('throws on failed test, bad pointer and out-of-bounds index', () => {
    expect(() => {
      return applyJsonPatch({ a: 1 }, [{ op: 'test', path: '/a', value: 2 }]);
    }).toThrow('test failed');
    expect(() => {
      return applyJsonPatch({ a: 1 }, [{ op: 'remove', path: 'a' }]);
    }).toThrow('JSON Pointer');
    expect(() => {
      return applyJsonPatch({ list: [1] }, [{ op: 'remove', path: '/list/5' }]);
    }).toThrow('out of bounds');
  });

  it('unescapes ~1 and ~0 pointer segments', () => {
    expect(
      applyJsonPatch({ 'a/b': { 'c~d': 1 } }, [{ op: 'replace', path: '/a~1b/c~0d', value: 2 }])
    ).toEqual({ 'a/b': { 'c~d': 2 } });
  });
});

describe('jsonMergePatch', () => {
  it('merges nested objects, deletes null keys, replaces arrays and scalars', () => {
    expect(
      jsonMergePatch(
        { a: { b: 1, c: 2 }, drop: true, list: [1, 2] },
        { a: { c: 3 }, drop: null, list: [9] }
      )
    ).toEqual({ a: { b: 1, c: 3 }, list: [9] });
    expect(jsonMergePatch('not-an-object', { a: 1 })).toEqual({ a: 1 });
    expect(jsonMergePatch({ a: 1 }, 'scalar')).toBe('scalar');
  });
});
