import { describe, expect, it } from 'vitest';

import { resolveMetroUrl } from '@/server/metro/resolveMetroUrl';

type Ctx = Parameters<typeof resolveMetroUrl>[1];

const ctxWithClientUrl = (url: string | undefined): Ctx => {
  return {
    bridge: {
      resolveClient: () => {
        return url === undefined
          ? { error: 'no clients', ok: false }
          : { client: { devServer: { url } }, ok: true };
      },
    },
    requestedClientId: undefined,
  } as unknown as Ctx;
};

describe('resolveMetroUrl', () => {
  it('explicit metroUrl wins and loses its trailing slash', () => {
    expect(resolveMetroUrl({ metroUrl: 'http://box:9999/' }, ctxWithClientUrl('http://x:1'))).toBe(
      'http://box:9999'
    );
  });

  it('uses the connected client dev-server url', () => {
    expect(resolveMetroUrl({}, ctxWithClientUrl('http://192.168.1.20:8081/'))).toBe(
      'http://192.168.1.20:8081'
    );
  });

  it('maps Android emulator host aliases back to localhost', () => {
    expect(resolveMetroUrl({}, ctxWithClientUrl('http://10.0.2.2:8081'))).toBe(
      'http://localhost:8081'
    );
    expect(resolveMetroUrl({}, ctxWithClientUrl('http://10.0.3.2:8081/'))).toBe(
      'http://localhost:8081'
    );
  });

  it('does not touch addresses that merely contain the alias', () => {
    expect(resolveMetroUrl({}, ctxWithClientUrl('http://110.0.2.21:8081'))).toBe(
      'http://110.0.2.21:8081'
    );
  });

  it('falls back to localhost:8081 when no client resolves', () => {
    expect(resolveMetroUrl({}, ctxWithClientUrl(undefined))).toBe('http://localhost:8081');
  });
});
