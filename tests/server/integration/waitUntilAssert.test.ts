/* eslint-disable import/extensions -- deep SDK imports (.js) trip the alias
   resolver; same exemption src/server/mcpServer.ts gets via .eslintrc. */
// Integration coverage for the wait_until / assert wrapper tools: a real
// Bridge on an ephemeral port, the real McpServerWrapper over an in-memory MCP
// transport, and fake RN clients whose tool_response is produced by a mutable
// responder — tests swap it between calls to model state that changes over
// time. Scenarios run in order and share state.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { z } from 'zod';

import { serializeInputSchema } from '@/client/utils/serializeInputSchema';
import { Bridge, type BridgeEvents } from '@/server/bridge';
import { McpServerWrapper } from '@/server/mcpServer';
import {
  type ModuleDescriptor,
  PROTOCOL_VERSION,
  type ServerMessage,
  type ToolResponse,
} from '@/shared/protocol';

vi.setConfig({ testTimeout: 15_000 });

interface Identity {
  appName: string;
  bundleId: string;
  deviceId: string;
}

// Distinct deviceId/bundleId per client — the bridge keys reconnect stickiness
// on the (platform, deviceId, bundleId) triple, so identical identities would
// collapse into one client slot.
const ID_A: Identity = { appName: 'A', bundleId: 'com.a', deviceId: 'DEV-A' };
const ID_B: Identity = { appName: 'B', bundleId: 'com.b', deviceId: 'DEV-B' };

const probeModule: ModuleDescriptor = {
  name: 'probe',
  tools: [
    {
      description: 'Probe whose result is scripted per test.',
      inputSchema: serializeInputSchema(z.looseObject({})),
      name: 'status',
    },
  ],
};

interface FakeClient {
  id: string;
  respond: () => unknown;
  ws: WebSocket;
}

describe('wait_until / assert wrappers (integration)', () => {
  let bridge: Bridge;
  let wrapper: McpServerWrapper;
  let mcpClient: Client;
  let port: number;
  let fakeA: FakeClient;
  let fakeB: FakeClient;
  const openSockets: WebSocket[] = [];

  const waitEvent = <K extends keyof BridgeEvents>(event: K): Promise<BridgeEvents[K]> => {
    return new Promise((resolve) => {
      bridge.once(event, ((...eventArgs: BridgeEvents[K]) => {
        resolve(eventArgs);
      }) as never);
    });
  };

  // Fake RN client: registers the probe module on server_hello and answers
  // every tool_request with whatever the current (mutable) responder returns.
  const connectFakeClient = async (identity: Identity): Promise<FakeClient> => {
    const added = waitEvent('clientAdded');
    const fake: FakeClient = {
      id: '',
      respond: () => {
        return {};
      },
      ws: new WebSocket(`ws://localhost:${port}`),
    };
    fake.ws.on('error', () => {});
    fake.ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMessage;
      if (msg.type === 'server_hello') {
        fake.ws.send(
          JSON.stringify({
            modules: [probeModule],
            platform: 'ios',
            protocolVersion: PROTOCOL_VERSION,
            type: 'registration',
            ...identity,
          })
        );
      }
      if (msg.type === 'tool_request') {
        const response: ToolResponse = {
          id: msg.id,
          result: fake.respond(),
          type: 'tool_response',
        };
        fake.ws.send(JSON.stringify(response));
      }
    });
    const [client] = await added;
    fake.id = client.id;
    openSockets.push(fake.ws);
    return fake;
  };

  const callToolJson = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const res = await mcpClient.callTool({ arguments: args, name });
    const content = res.content as Array<{ type: string; text?: string }>;
    const text = content
      .filter((c) => {
        return c.type === 'text';
      })
      .map((c) => {
        return c.text ?? '';
      })
      .join('\n');
    return JSON.parse(text) as T;
  };

  beforeAll(async () => {
    bridge = new Bridge(0);
    await bridge.start();
    port = bridge.boundPort()!;
    expect(port).toBeGreaterThan(0);

    wrapper = new McpServerWrapper(bridge, []);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await wrapper.connectTransport(serverTransport);

    mcpClient = new Client({ name: 'vitest-harness', version: '1.0.0' });
    await mcpClient.connect(clientTransport);

    fakeA = await connectFakeClient(ID_A);
    fakeB = await connectFakeClient(ID_B);
    expect(fakeA.id).not.toBe(fakeB.id);
  });

  afterAll(async () => {
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    await mcpClient.close();
    await bridge.stop();
  });

  it('wait_until succeeds once the predicate holds, reporting attempts + matched', async () => {
    let calls = 0;
    fakeA.respond = () => {
      calls += 1;
      return { ready: calls >= 3 };
    };
    const payload = await callToolJson<{ attempts: number; ok: boolean; matched?: unknown }>(
      'wait_until',
      {
        clientId: fakeA.id,
        intervalMs: 50,
        predicate: { op: 'equals', path: 'ready', value: true },
        timeoutMs: 5_000,
        tool: 'probe__status',
      }
    );
    expect(payload.ok).toBe(true);
    expect(payload.attempts).toBe(3);
    expect(payload.matched).toBe(true);
  });

  it('wait_until times out with reason + lastResult when the predicate never holds', async () => {
    fakeA.respond = () => {
      return { ready: false };
    };
    const payload = await callToolJson<{
      attempts: number;
      elapsedMs: number;
      ok: boolean;
      lastResult?: unknown;
      reason?: string;
    }>('wait_until', {
      clientId: fakeA.id,
      intervalMs: 100,
      predicate: { op: 'equals', path: 'ready', value: true },
      timeoutMs: 600,
      tool: 'probe__status',
    });
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe('Predicate did not hold within 600ms');
    expect(payload.lastResult).toEqual({ ready: false });
    expect(payload.attempts).toBeGreaterThanOrEqual(2);
    expect(payload.elapsedMs).toBeGreaterThanOrEqual(600);
  });

  it('wait_until evaluates compound all/not predicates (matched omitted)', async () => {
    fakeA.respond = () => {
      return { count: 2, phase: 'ready' };
    };
    const payload = await callToolJson<Record<string, unknown>>('wait_until', {
      clientId: fakeA.id,
      predicate: {
        all: [
          { op: 'equals', path: 'phase', value: 'ready' },
          { not: { op: 'gt', path: 'count', value: 10 } },
        ],
      },
      timeoutMs: 5_000,
      tool: 'probe__status',
    });
    expect(payload.ok).toBe(true);
    expect(payload.attempts).toBe(1);
    expect('matched' in payload).toBe(false);
  });

  it('wait_until surfaces a clear error for a malformed tool name', async () => {
    const payload = await callToolJson<{ ok: boolean; reason?: string }>('wait_until', {
      clientId: fakeA.id,
      intervalMs: 100,
      predicate: { op: 'exists' },
      timeoutMs: 500,
      tool: 'bogus',
    });
    expect(payload.ok).toBe(false);
    expect(payload.reason).toContain('Invalid tool name "bogus"');
  });

  it('wait_until broadcast reports per-client outcomes with overall ok', async () => {
    fakeA.respond = () => {
      return { ready: true };
    };
    let bCalls = 0;
    fakeB.respond = () => {
      bCalls += 1;
      return { ready: bCalls >= 2 };
    };
    const payload = await callToolJson<{
      failedCount: number;
      ok: boolean;
      okCount: number;
      perClient: Array<{ attempts: number; clientId: string; ok: boolean }>;
    }>('wait_until', {
      clientId: [fakeA.id, fakeB.id],
      intervalMs: 50,
      predicate: { op: 'equals', path: 'ready', value: true },
      timeoutMs: 5_000,
      tool: 'probe__status',
    });
    expect(payload.ok).toBe(true);
    expect(payload.okCount).toBe(2);
    expect(payload.failedCount).toBe(0);
    const entryB = payload.perClient.find((e) => {
      return e.clientId === fakeB.id;
    });
    expect(entryB?.ok).toBe(true);
    expect(entryB?.attempts).toBe(2);
  });

  it('wait_until broadcast fails overall when one client never matches', async () => {
    fakeA.respond = () => {
      return { ready: true };
    };
    fakeB.respond = () => {
      return { ready: false };
    };
    const payload = await callToolJson<{
      failedCount: number;
      ok: boolean;
      okCount: number;
      perClient: Array<{ clientId: string; ok: boolean; lastResult?: unknown }>;
    }>('wait_until', {
      clientId: [fakeA.id, fakeB.id],
      intervalMs: 100,
      predicate: { op: 'equals', path: 'ready', value: true },
      timeoutMs: 600,
      tool: 'probe__status',
    });
    expect(payload.ok).toBe(false);
    expect(payload.okCount).toBe(1);
    expect(payload.failedCount).toBe(1);
    const entryB = payload.perClient.find((e) => {
      return e.clientId === fakeB.id;
    });
    expect(entryB?.ok).toBe(false);
    expect(entryB?.lastResult).toEqual({ ready: false });
  });

  it('assert passes and echoes the path-resolved actual', async () => {
    fakeA.respond = () => {
      return { name: 'CART' };
    };
    const payload = await callToolJson<Record<string, unknown>>('assert', {
      clientId: fakeA.id,
      predicate: { op: 'equals', path: 'name', value: 'CART' },
      tool: 'probe__status',
    });
    expect(payload.pass).toBe(true);
    expect(payload.actual).toBe('CART');
    expect('result' in payload).toBe(false);
    expect('expected' in payload).toBe(false);
  });

  it('assert failure carries actual/expected/op/path and the full result', async () => {
    fakeA.respond = () => {
      return { name: 'CART' };
    };
    const payload = await callToolJson<Record<string, unknown>>('assert', {
      clientId: fakeA.id,
      predicate: { op: 'equals', path: 'name', value: 'HOME' },
      tool: 'probe__status',
    });
    expect(payload).toMatchObject({
      actual: 'CART',
      expected: 'HOME',
      op: 'equals',
      pass: false,
      path: 'name',
      result: { name: 'CART' },
    });
  });

  it('assert rejects clientId nested inside args with a remediation message', async () => {
    const payload = await callToolJson<{ error?: string }>('assert', {
      args: { clientId: fakeA.id },
      clientId: fakeA.id,
      predicate: { op: 'exists' },
      tool: 'probe__status',
    });
    expect(payload.error).toContain('clientId belongs to the outer assert() argument');
  });

  it('assert broadcast aggregates per-client with overall pass = all', async () => {
    fakeA.respond = () => {
      return { name: 'CART' };
    };
    fakeB.respond = () => {
      return { name: 'HOME' };
    };
    const mixed = await callToolJson<{
      failedCount: number;
      pass: boolean;
      passedCount: number;
      perClient: Array<{ clientId: string; pass: boolean; actual?: unknown; expected?: unknown }>;
    }>('assert', {
      clientId: [fakeA.id, fakeB.id],
      predicate: { op: 'equals', path: 'name', value: 'CART' },
      tool: 'probe__status',
    });
    expect(mixed.pass).toBe(false);
    expect(mixed.passedCount).toBe(1);
    expect(mixed.failedCount).toBe(1);
    const entryB = mixed.perClient.find((e) => {
      return e.clientId === fakeB.id;
    });
    expect(entryB).toMatchObject({ actual: 'HOME', expected: 'CART', pass: false });

    fakeB.respond = () => {
      return { name: 'CART' };
    };
    const allPass = await callToolJson<{ pass: boolean; passedCount: number }>('assert', {
      clientId: [fakeA.id, fakeB.id],
      predicate: { op: 'equals', path: 'name', value: 'CART' },
      tool: 'probe__status',
    });
    expect(allPass.pass).toBe(true);
    expect(allPass.passedCount).toBe(2);
  });
});
