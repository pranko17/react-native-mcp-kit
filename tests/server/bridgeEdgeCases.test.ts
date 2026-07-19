import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { Bridge } from '@/server/bridge';
import { PROTOCOL_VERSION } from '@/shared/protocol';

interface FakeClientOptions {
  onToolRequest?: (ws: WebSocket, message: { id: string }) => void;
}

describe('Bridge — edge cases', () => {
  const bridges: Bridge[] = [];
  const sockets: WebSocket[] = [];

  const startBridge = async (): Promise<Bridge> => {
    const bridge = new Bridge(0);
    bridges.push(bridge);
    await bridge.start();
    return bridge;
  };

  const connectClient = (bridge: Bridge, options: FakeClientOptions = {}): Promise<string> => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${bridge.boundPort()}`);
      sockets.push(ws);
      ws.on('error', reject);
      bridge.once('clientAdded', (client) => {
        resolve(client.id);
      });
      ws.on('message', (data) => {
        const message = JSON.parse(String(data)) as { id: string; type: string };
        if (message.type === 'server_hello') {
          ws.send(
            JSON.stringify({
              bundleId: 'com.edge',
              deviceId: 'EDGE-1',
              modules: [],
              platform: 'ios',
              protocolVersion: PROTOCOL_VERSION,
              type: 'registration',
            })
          );
        }
        if (message.type === 'tool_request') {
          options.onToolRequest?.(ws, message);
        }
      });
    });
  };

  afterEach(async () => {
    for (const ws of sockets) {
      ws.close();
    }
    sockets.length = 0;
    for (const bridge of bridges) {
      await bridge.stop();
    }
    bridges.length = 0;
  });

  it('rejects start() with EADDRINUSE when the port is taken', async () => {
    const first = await startBridge();
    const second = new Bridge(first.boundPort()!);
    bridges.push(second);
    await expect(second.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('rejects call() with a timeout when the client never answers', async () => {
    const bridge = await startBridge();
    const clientId = await connectClient(bridge);
    await expect(bridge.call(clientId, 'demo', 'ping', {}, 100)).rejects.toThrow(/timed out/);
  });

  it('rejects call() with the client-reported error from tool_response', async () => {
    const bridge = await startBridge();
    const clientId = await connectClient(bridge, {
      onToolRequest: (ws, message) => {
        ws.send(
          JSON.stringify({ error: 'boom from client', id: message.id, type: 'tool_response' })
        );
      },
    });
    await expect(bridge.call(clientId, 'demo', 'ping', {})).rejects.toThrow('boom from client');
  });
});
