/* eslint-disable import/extensions -- deep SDK imports (.js) trip the alias
   resolver; same exemption src/server/mcpServer.ts gets via .eslintrc. */
// Edge-case tail for the wait_until / assert wrapper tools, same harness as
// waitUntilAssert.test.ts: a real Bridge on an ephemeral port, the real
// McpServerWrapper over an in-memory MCP transport, and fake RN clients whose
// tool_response is produced by a mutable responder. Covers the argument
// plumbing (regex clientId, JSON-string args, clamping) and the dispatch-error
// paths the happy-path suite leaves out.
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
  respond: (requestArgs: Record<string, unknown>) => unknown;
  ws: WebSocket;
}

describe('wait_until / assert wrappers — edge cases (integration)', () => {
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
  // The responder receives the dispatched args so tests can verify plumbing.
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
          result: fake.respond(msg.args),
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

  it('wait_until compound any passes when only the second leaf holds', async () => {
    fakeA.respond = () => {
      return { count: 5, phase: 'loading' };
    };
    const payload = await callToolJson<Record<string, unknown>>('wait_until', {
      clientId: fakeA.id,
      predicate: {
        any: [
          { op: 'equals', path: 'phase', value: 'ready' },
          { op: 'gt', path: 'count', value: 3 },
        ],
      },
      timeoutMs: 5_000,
      tool: 'probe__status',
    });
    expect(payload.ok).toBe(true);
    expect(payload.attempts).toBe(1);
    expect('matched' in payload).toBe(false);
  });

  it('wait_until expands a regex clientId into a broadcast over matching clients', async () => {
    fakeA.respond = () => {
      return { ready: true };
    };
    fakeB.respond = () => {
      return { ready: true };
    };
    const payload = await callToolJson<{
      failedCount: number;
      ok: boolean;
      okCount: number;
      perClient: Array<{ clientId: string; ok: boolean }>;
    }>('wait_until', {
      clientId: '/^ios/',
      predicate: { op: 'equals', path: 'ready', value: true },
      timeoutMs: 5_000,
      tool: 'probe__status',
    });
    expect(payload.ok).toBe(true);
    expect(payload.okCount).toBe(2);
    expect(payload.failedCount).toBe(0);
    const ids = payload.perClient
      .map((e) => {
        return e.clientId;
      })
      .sort();
    expect(ids).toEqual([fakeA.id, fakeB.id].sort());
  });

  it('wait_until parses JSON-string args and forwards them to the polled tool', async () => {
    fakeA.respond = (requestArgs) => {
      return requestArgs;
    };
    const payload = await callToolJson<{ attempts: number; ok: boolean; matched?: unknown }>(
      'wait_until',
      {
        args: '{"flag":true}',
        clientId: fakeA.id,
        predicate: { op: 'equals', path: 'flag', value: true },
        timeoutMs: 5_000,
        tool: 'probe__status',
      }
    );
    expect(payload.ok).toBe(true);
    expect(payload.matched).toBe(true);
  });

  it('wait_until rejects malformed JSON-string args before dispatching', async () => {
    const payload = await callToolJson<{ error?: string }>('wait_until', {
      args: '{oops',
      clientId: fakeA.id,
      predicate: { op: 'exists' },
      timeoutMs: 5_000,
      tool: 'probe__status',
    });
    expect(payload.error).toBe('Invalid JSON in args.');
  });

  it('wait_until clamps intervalMs below 50 up to 50', async () => {
    fakeA.respond = () => {
      return { ready: false };
    };
    const payload = await callToolJson<{ attempts: number; ok: boolean }>('wait_until', {
      clientId: fakeA.id,
      intervalMs: 5,
      predicate: { op: 'equals', path: 'ready', value: true },
      timeoutMs: 600,
      tool: 'probe__status',
    });
    expect(payload.ok).toBe(false);
    // 600ms budget / 50ms clamped interval caps attempts at ~13; an honored
    // 5ms interval would rack up 100+.
    expect(payload.attempts).toBeGreaterThanOrEqual(2);
    expect(payload.attempts).toBeLessThanOrEqual(13);
  });

  it('wait_until clamps timeoutMs below 500 up to 500', async () => {
    fakeA.respond = () => {
      return { ready: false };
    };
    const payload = await callToolJson<{ elapsedMs: number; ok: boolean; reason?: string }>(
      'wait_until',
      {
        clientId: fakeA.id,
        intervalMs: 100,
        predicate: { op: 'equals', path: 'ready', value: true },
        timeoutMs: 100,
        tool: 'probe__status',
      }
    );
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe('Predicate did not hold within 500ms');
    expect(payload.elapsedMs).toBeGreaterThanOrEqual(500);
  });

  it('assert echoes message in the failure payload', async () => {
    fakeA.respond = () => {
      return { name: 'CART' };
    };
    const payload = await callToolJson<Record<string, unknown>>('assert', {
      clientId: fakeA.id,
      message: 'route should be HOME',
      predicate: { op: 'equals', path: 'name', value: 'HOME' },
      tool: 'probe__status',
    });
    expect(payload.pass).toBe(false);
    expect(payload.message).toBe('route should be HOME');
  });

  it('assert reports a dispatch error for an unknown explicit clientId', async () => {
    const payload = await callToolJson<{ pass: boolean; error?: string; message?: string }>(
      'assert',
      {
        clientId: 'nope',
        message: 'unreachable check',
        predicate: { op: 'exists' },
        tool: 'probe__status',
      }
    );
    expect(payload.pass).toBe(false);
    expect(payload.error).toContain("Client 'nope' not connected");
    expect(payload.message).toBe('unreachable check');
  });

  it('assert broadcast keeps honest counters when one client errors', async () => {
    fakeA.respond = () => {
      return { name: 'CART' };
    };
    const payload = await callToolJson<{
      failedCount: number;
      pass: boolean;
      passedCount: number;
      perClient: Array<{ clientId: string; pass: boolean; error?: string }>;
    }>('assert', {
      clientId: [fakeA.id, 'ghost-99'],
      predicate: { op: 'equals', path: 'name', value: 'CART' },
      tool: 'probe__status',
    });
    expect(payload.pass).toBe(false);
    expect(payload.passedCount).toBe(1);
    expect(payload.failedCount).toBe(1);
    const ghost = payload.perClient.find((e) => {
      return e.clientId === 'ghost-99';
    });
    expect(ghost?.pass).toBe(false);
    expect(ghost?.error).toContain("Client 'ghost-99' not connected");
    const live = payload.perClient.find((e) => {
      return e.clientId === fakeA.id;
    });
    expect(live?.pass).toBe(true);
  });
});
