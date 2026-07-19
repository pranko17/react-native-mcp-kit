// Bridge unit tests over a real WebSocketServer on an ephemeral port: sticky
// reconnect identity matching, ghost bookkeeping, protocol-version rejection,
// and pending-call rejection on disconnect.
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { Bridge, type BridgeEvents, type ClientEntry } from '@/server/bridge';
import {
  PROTOCOL_VERSION,
  type ServerMessage,
  WS_CLOSE_PROTOCOL_MISMATCH,
} from '@/shared/protocol';

const IDENTITY = { bundleId: 'com.demo', deviceId: 'DEV-1', platform: 'ios' };

describe('Bridge', () => {
  let bridge: Bridge;
  const openSockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    openSockets.length = 0;
    await bridge.stop();
  });

  const startBridge = async (): Promise<Bridge> => {
    bridge = new Bridge(0);
    await bridge.start();
    return bridge;
  };

  const waitEvent = <K extends keyof BridgeEvents>(event: K): Promise<BridgeEvents[K]> => {
    return new Promise((resolve) => {
      bridge.once(event, ((...eventArgs: BridgeEvents[K]) => {
        resolve(eventArgs);
      }) as never);
    });
  };

  // Fake RN client: registers on server_hello and (optionally) never answers
  // tool requests — the silent shape the disconnect-rejection test needs.
  const connectClient = async (
    overrides: Record<string, unknown> = {}
  ): Promise<{ client: ClientEntry; ws: WebSocket }> => {
    const added = waitEvent('clientAdded');
    const ws = new WebSocket(`ws://localhost:${bridge.boundPort()}`);
    ws.on('error', () => {});
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMessage;
      if (msg.type === 'server_hello') {
        ws.send(
          JSON.stringify({
            ...IDENTITY,
            modules: [],
            protocolVersion: PROTOCOL_VERSION,
            type: 'registration',
            ...overrides,
          })
        );
      }
    });
    openSockets.push(ws);
    const [client] = await added;
    return { client, ws };
  };

  const closeClient = async (ws: WebSocket): Promise<void> => {
    const removed = waitEvent('clientRemoved');
    ws.close();
    await removed;
  };

  it('binds an ephemeral port and reports it via boundPort', async () => {
    const fresh = new Bridge(0);
    expect(fresh.boundPort()).toBeNull();
    bridge = fresh;
    await bridge.start();
    expect(bridge.boundPort()).toBeGreaterThan(0);
  });

  it('reuses the same id when the identity triple matches a ghost (sticky reconnect)', async () => {
    await startBridge();
    const first = await connectClient();
    expect(first.client.id).toBe('ios-1');
    await closeClient(first.ws);

    const second = await connectClient();
    expect(second.client.id).toBe('ios-1');
    // Adoption consumed the ghost slot.
    expect(bridge.listDisconnected()).toHaveLength(0);
    expect(bridge.getClient('ios-1')).toBeDefined();
  });

  it('allocates a fresh id when no ghost matches the identity triple', async () => {
    await startBridge();
    const first = await connectClient();
    await closeClient(first.ws);

    const second = await connectClient({ deviceId: 'DEV-OTHER' });
    expect(second.client.id).toBe('ios-2');
    // The non-matching ghost stays reserved for its own identity.
    expect(
      bridge.listDisconnected().map(({ entry }) => {
        return entry.id;
      })
    ).toEqual(['ios-1']);
  });

  it('lists a disconnected client as a ghost with an expiry countdown', async () => {
    await startBridge();
    const { ws } = await connectClient();
    await closeClient(ws);

    expect(bridge.getClient('ios-1')).toBeUndefined();
    expect(bridge.getDisconnected('ios-1')?.deviceId).toBe('DEV-1');

    const ghosts = bridge.listDisconnected();
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0]!.entry.id).toBe('ios-1');
    expect(ghosts[0]!.expiresInMs).toBeGreaterThan(0);
    expect(ghosts[0]!.expiresInMs).toBeLessThanOrEqual(60 * 60_000);
  });

  it('rejects a mismatched protocolVersion with version_mismatch + close 4010', async () => {
    await startBridge();
    const ws = new WebSocket(`ws://localhost:${bridge.boundPort()}`);
    ws.on('error', () => {});
    openSockets.push(ws);

    const outcome = await new Promise<{ closeCode: number; rejection: ServerMessage }>(
      (resolve) => {
        let rejection: ServerMessage | undefined;
        ws.on('message', (data) => {
          const msg = JSON.parse(String(data)) as ServerMessage;
          if (msg.type === 'server_hello') {
            ws.send(
              JSON.stringify({
                ...IDENTITY,
                modules: [],
                protocolVersion: PROTOCOL_VERSION + 1,
                type: 'registration',
              })
            );
          }
          if (msg.type === 'version_mismatch') {
            rejection = msg;
          }
        });
        ws.on('close', (closeCode) => {
          resolve({ closeCode, rejection: rejection! });
        });
      }
    );

    expect(outcome.closeCode).toBe(WS_CLOSE_PROTOCOL_MISMATCH);
    expect(outcome.rejection).toMatchObject({
      clientVersion: PROTOCOL_VERSION + 1,
      serverVersion: PROTOCOL_VERSION,
      type: 'version_mismatch',
    });
    expect(bridge.listClients()).toHaveLength(0);
  });

  it('rejects in-flight calls when the client disconnects', async () => {
    await startBridge();
    // The fake client never answers tool_request — the call stays pending
    // until the disconnect sweep rejects it.
    const { client, ws } = await connectClient();
    const pending = bridge.call(client.id, 'navigation', 'navigate', { screen: 'CART' });
    const rejection = expect(pending).rejects.toThrow(/'ios-1' disconnected/);
    ws.close();
    await rejection;
  });
});
