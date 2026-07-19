import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type McpModule } from '@/client/models/types';
import { networkModule } from '@/modules/network';

// The module patches global.fetch at import time — every fetch below goes
// through the interceptor. XMLHttpRequest does not exist in node, so the XHR
// patch is a no-op here; that surface needs an RN runtime. Own vitest fork.

const mod: McpModule = networkModule();

const call = (tool: string, args: Record<string, unknown> = {}): unknown => {
  return mod.tools[tool]!.handler(args);
};

interface ProjectedEntry {
  duration: number | null;
  id: number;
  method: string;
  request: { headers: Record<string, string>; body?: unknown; bodyBytes?: number };
  response: { headers: Record<string, string>; status: number; body?: unknown } | null;
  startedAt: string;
  status: string;
  url: string;
}

const getRequests = (args: Record<string, unknown> = {}): ProjectedEntry[] => {
  return call('get_requests', { depth: 6, ...args }) as ProjectedEntry[];
};

let server: Server;
let baseUrl = '';
let refusedUrl = '';

const listen = (srv: Server): Promise<string> => {
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
    });
  });
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-test-header': 'yes' });
      res.end(JSON.stringify({ echoedBytes: raw.length, ok: true, token: 'server-secret' }));
    });
  });
  baseUrl = await listen(server);

  const probe = createServer();
  refusedUrl = await listen(probe);
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

beforeEach(() => {
  call('clear_requests');
});

describe('networkModule fetch capture', () => {
  it('records a successful request with status, duration and parsed response', async () => {
    const response = await fetch(`${baseUrl}/data`);
    await response.text();
    const entries = getRequests();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry).toMatchObject({ method: 'GET', status: 'success', url: `${baseUrl}/data` });
    expect(entry.id).toBeGreaterThan(0);
    expect(typeof entry.duration).toBe('number');
    expect(new Date(entry.startedAt).toISOString()).toBe(entry.startedAt);
    expect(entry.response).toMatchObject({
      body: { echoedBytes: 0, ok: true, token: '[redacted]' },
      status: 200,
    });
    expect(entry.response!.headers['x-test-header']).toBe('yes');
  });

  it('redacts sensitive request headers and body keys at capture time', async () => {
    const response = await fetch(`${baseUrl}/login`, {
      body: JSON.stringify({ password: 'hunter2', user: 'ann' }),
      headers: { authorization: 'Bearer 123', 'x-custom': 'keep' },
      method: 'POST',
    });
    await response.text();
    const entry = getRequests()[0]!;
    expect(entry.method).toBe('POST');
    expect(entry.request.headers).toEqual({ authorization: '[redacted]', 'x-custom': 'keep' });
    expect(entry.request.body).toEqual({ password: '[redacted]', user: 'ann' });
    expect(entry.request.bodyBytes).toBeGreaterThan(0);
  });

  it('records network failures as error entries with the message as body', async () => {
    await expect(fetch(refusedUrl)).rejects.toThrow();
    const entry = getRequests()[0]!;
    expect(entry.status).toBe('error');
    expect(entry.response).toMatchObject({ status: 0 });
    expect(typeof entry.response!.body).toBe('string');
  });

  it('skips URLs matching the default ignore list', async () => {
    const response = await fetch(`${baseUrl}/symbolicate`);
    await response.text();
    expect(getRequests()).toEqual([]);
  });
});

describe('networkModule listing and stats', () => {
  const seed = async (): Promise<void> => {
    await (await fetch(`${baseUrl}/a`)).text();
    await (await fetch(`${baseUrl}/b`, { body: '{"n":1}', method: 'POST' })).text();
    await expect(fetch(refusedUrl)).rejects.toThrow();
  };

  it('filters by method, status and URL substring', async () => {
    await seed();
    expect(getRequests({ method: 'post' }).map((e) => e.url)).toEqual([`${baseUrl}/b`]);
    expect(getRequests({ status: 'error' }).map((e) => e.url)).toEqual([refusedUrl]);
    expect(getRequests({ url: '/b' }).map((e) => e.method)).toEqual(['POST']);
  });

  it('collapses the headers map at the default projection depth', async () => {
    await (await fetch(`${baseUrl}/a`)).text();
    const entry = (call('get_requests') as Array<Record<string, unknown>>)[0]!;
    expect((entry.request as Record<string, unknown>).headers).toEqual({ '${obj}': 0 });
  });

  it('aggregates counts, duration percentiles and body bytes', async () => {
    await seed();
    const stats = call('get_stats') as {
      byMethod: Record<string, number>;
      byStatus: Record<string, number>;
      bytes: number;
      durationMs: { max: number | null; min: number | null; p50: number | null };
      total: number;
    };
    expect(stats.total).toBe(3);
    expect(stats.byMethod).toEqual({ GET: 2, POST: 1 });
    expect(stats.byStatus).toEqual({ error: 1, pending: 0, success: 2 });
    expect(stats.bytes).toBeGreaterThan(0);
    expect(stats.durationMs.min).not.toBeNull();
    expect(stats.durationMs.max).not.toBeNull();
    expect(stats.durationMs.p50).not.toBeNull();
  });

  it('clear_requests empties the buffer', async () => {
    await (await fetch(`${baseUrl}/a`)).text();
    expect(call('clear_requests')).toEqual({ success: true });
    expect(getRequests()).toEqual([]);
  });
});
