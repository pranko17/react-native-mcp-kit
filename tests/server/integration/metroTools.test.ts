/* eslint-disable import/extensions -- deep SDK imports (.js) trip the alias
   resolver; same exemption src/server/mcpServer.ts gets via .eslintrc. */
// Integration coverage for the remaining Metro tools: symbolicate,
// open_in_editor, get_events, and metroUrl auto-detection from a client's
// devServer handshake. A local HTTP server stands in for Metro (recording
// every request body) and carries a real WebSocket `/events` endpoint so the
// event-capture subscription runs end to end. Scenarios run in order and
// share state — they model one server lifetime.
import { createServer as createHttpServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';

import { Bridge, type BridgeEvents } from '@/server/bridge';
import { McpServerWrapper } from '@/server/mcpServer';
import { metroModule } from '@/server/metro';
import { getEventCapture } from '@/server/metro/eventCapture';
import { PROTOCOL_VERSION, type ServerMessage, type ToolResponse } from '@/shared/protocol';

vi.setConfig({ testTimeout: 15_000 });

interface RecordedRequest {
  body: string;
  method: string;
  url: string;
}

interface SymbolicateFrame {
  collapse?: boolean;
  column?: number;
  file?: string;
  lineNumber?: number;
  methodName?: string;
}

// Internal shape of MetroEventCapture — accessed structurally in tests to
// dispose deterministically (TS `private` is compile-time only).
interface CaptureInternals {
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  ws: WebSocket | null;
}

describe('metro tools (integration)', () => {
  let bridge: Bridge;
  let wrapper: McpServerWrapper;
  let mcpClient: Client;
  let port: number;
  let metroStub: Server;
  let eventsWss: WebSocketServer;
  let metroUrl: string;
  let closedMetroUrl: string;
  let symbolicateResponse: { stack: SymbolicateFrame[] } = { stack: [] };
  const metroRequests: RecordedRequest[] = [];
  const eventSockets: WebSocket[] = [];
  const openSockets: WebSocket[] = [];
  const captures: Array<{ dispose: () => void }> = [];

  const waitEvent = <K extends keyof BridgeEvents>(event: K): Promise<BridgeEvents[K]> => {
    return new Promise((resolve) => {
      bridge.once(event, ((...eventArgs: BridgeEvents[K]) => {
        resolve(eventArgs);
      }) as never);
    });
  };

  // Fake RN client whose handshake carries the devServer origin — the field
  // metro tools auto-detect the Metro URL from when no metroUrl is passed.
  const connectClientWithDevServer = async (): Promise<WebSocket> => {
    const added = waitEvent('clientAdded');
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('error', () => {});
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMessage;
      if (msg.type === 'server_hello') {
        ws.send(
          JSON.stringify({
            appName: 'MetroProbe',
            bundleId: 'com.metro.probe',
            devServer: {
              bundleLoadedFromServer: true,
              host: '127.0.0.1',
              port: (metroStub.address() as AddressInfo).port,
              url: metroUrl,
            },
            deviceId: 'METRO-DEV-1',
            modules: [],
            platform: 'ios',
            protocolVersion: PROTOCOL_VERSION,
            type: 'registration',
          })
        );
      }
      if (msg.type === 'tool_request') {
        const response: ToolResponse = {
          id: msg.id,
          result: { args: msg.args },
          type: 'tool_response',
        };
        ws.send(JSON.stringify(response));
      }
    });
    await added;
    openSockets.push(ws);
    return ws;
  };

  const callToolJson = async (
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
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
    return JSON.parse(text) as Record<string, unknown>;
  };

  beforeAll(async () => {
    bridge = new Bridge(0);
    await bridge.start();
    port = bridge.boundPort()!;
    expect(port).toBeGreaterThan(0);

    wrapper = new McpServerWrapper(bridge, [metroModule()]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await wrapper.connectTransport(serverTransport);

    mcpClient = new Client({ name: 'vitest-harness', version: '1.0.0' });
    await mcpClient.connect(clientTransport);

    // Local Metro stand-in: answers /status, /symbolicate and
    // /open-stack-frame, records every hit with its body.
    metroStub = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        metroRequests.push({
          body: Buffer.concat(chunks).toString('utf8'),
          method: req.method ?? '',
          url: req.url ?? '',
        });
        if (req.url === '/status') {
          res.writeHead(200);
          res.end('packager-status:running');
          return;
        }
        if (req.url === '/symbolicate' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(symbolicateResponse));
          return;
        }
        if (req.url === '/open-stack-frame' && req.method === 'POST') {
          res.writeHead(200);
          res.end('{}');
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    // Real WebSocket endpoint at /events — the event capture subscribes to it
    // exactly like it would to Metro's reporter stream.
    eventsWss = new WebSocketServer({ noServer: true });
    metroStub.on('upgrade', (req, socket, head) => {
      if (req.url === '/events') {
        eventsWss.handleUpgrade(req, socket, head, (client) => {
          eventSockets.push(client);
        });
        return;
      }
      socket.destroy();
    });

    await new Promise<void>((resolve) => {
      metroStub.listen(0, '127.0.0.1', resolve);
    });
    metroUrl = `http://127.0.0.1:${(metroStub.address() as AddressInfo).port}`;

    // Grab a port that is guaranteed closed: bind, read, release.
    const throwaway = createHttpServer();
    await new Promise<void>((resolve) => {
      throwaway.listen(0, '127.0.0.1', resolve);
    });
    closedMetroUrl = `http://127.0.0.1:${(throwaway.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => {
      throwaway.close(() => {
        resolve();
      });
    });
  });

  afterAll(async () => {
    // Dispose event captures BEFORE tearing the stub down so their sockets
    // close gracefully and no reconnect timers outlive the suite.
    for (const capture of captures) {
      capture.dispose();
    }
    for (const ws of eventSockets) {
      ws.close();
    }
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    await mcpClient.close();
    await bridge.stop();
    await new Promise<void>((resolve) => {
      eventsWss.close(() => {
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      metroStub.close(() => {
        resolve();
      });
    });
  });

  it('metro__status auto-detects the Metro URL from the client devServer handshake', async () => {
    await connectClientWithDevServer();
    // No metroUrl argument — the only way the stub can receive this hit is
    // through the devServer origin the fake client registered.
    const payload = await callToolJson('metro__status', {});
    expect(payload).toEqual({ metroUrl, running: true });
    expect(metroRequests).toContainEqual({ body: '', method: 'GET', url: '/status' });
  });

  it('metro__symbolicate parses a V8 stack string and applies token-saving trims', async () => {
    const cwd = process.cwd();
    symbolicateResponse = {
      stack: [
        {
          collapse: false,
          column: 7,
          file: `${cwd}/src/screens/Home.tsx`,
          lineNumber: 42,
          methodName: 'render',
        },
        {
          collapse: true,
          column: 3,
          file: `${cwd}/node_modules/react-native/Libraries/Core/Devtools/parseErrorStack.js`,
          lineNumber: 10,
          methodName: 'guard',
        },
      ],
    };
    const stack = [
      'TypeError: boom',
      '    at render (http://localhost:8081/index.bundle:100:20)',
      '    at http://localhost:8081/index.bundle:200:5',
    ].join('\n');
    const payload = await callToolJson('metro__symbolicate', { metroUrl, stack });
    expect(payload).toEqual({
      droppedFrameworkFrames: 1,
      frames: [{ column: 7, file: 'src/screens/Home.tsx', lineNumber: 42, methodName: 'render' }],
      totalFrames: 1,
    });

    // The POST body carries the parsed frames — header line stripped, method
    // and position split out, anonymous frame without methodName.
    const request = metroRequests.find((r) => {
      return r.url === '/symbolicate';
    });
    const body = JSON.parse(request!.body) as { stack: SymbolicateFrame[] };
    expect(body.stack).toEqual([
      {
        column: 20,
        file: 'http://localhost:8081/index.bundle',
        lineNumber: 100,
        methodName: 'render',
      },
      { column: 5, file: 'http://localhost:8081/index.bundle', lineNumber: 200 },
    ]);
  });

  it('metro__symbolicate parses a Hermes-style stack string', async () => {
    metroRequests.length = 0;
    symbolicateResponse = {
      stack: [
        {
          collapse: false,
          column: 34,
          file: 'src/Button.tsx',
          lineNumber: 12,
          methodName: 'onPress',
        },
      ],
    };
    const stack = 'onPress@/app/src/Button.tsx:12:34\n@/app/src/App.tsx:5:6';
    const payload = await callToolJson('metro__symbolicate', { metroUrl, stack });
    expect(payload).toMatchObject({ totalFrames: 1 });

    const request = metroRequests.find((r) => {
      return r.url === '/symbolicate';
    });
    const body = JSON.parse(request!.body) as { stack: SymbolicateFrame[] };
    expect(body.stack).toEqual([
      { column: 34, file: '/app/src/Button.tsx', lineNumber: 12, methodName: 'onPress' },
      { column: 6, file: '/app/src/App.tsx', lineNumber: 5 },
    ]);
  });

  it('metro__symbolicate accepts a frames array and honours fullPaths + includeFrameworkFrames', async () => {
    metroRequests.length = 0;
    const cwd = process.cwd();
    symbolicateResponse = {
      stack: [
        {
          collapse: false,
          column: 9,
          file: `${cwd}/src/Feature.tsx`,
          lineNumber: 77,
          methodName: 'doThing',
        },
        {
          collapse: true,
          column: 1,
          file: `${cwd}/node_modules/react/index.js`,
          lineNumber: 1,
          methodName: 'internal',
        },
      ],
    };
    const frames = [
      {
        column: 9,
        file: 'http://localhost:8081/index.bundle',
        lineNumber: 77,
        methodName: 'doThing',
      },
    ];
    const payload = await callToolJson('metro__symbolicate', {
      frames,
      fullPaths: true,
      includeFrameworkFrames: true,
      metroUrl,
    });
    expect(payload).toEqual({
      frames: [
        { column: 9, file: `${cwd}/src/Feature.tsx`, lineNumber: 77, methodName: 'doThing' },
        {
          column: 1,
          file: `${cwd}/node_modules/react/index.js`,
          lineNumber: 1,
          methodName: 'internal',
        },
      ],
      totalFrames: 2,
    });

    const request = metroRequests.find((r) => {
      return r.url === '/symbolicate';
    });
    const body = JSON.parse(request!.body) as { stack: SymbolicateFrame[] };
    expect(body.stack).toEqual(frames);
  });

  it('metro__symbolicate degrades gracefully when Metro is unreachable', async () => {
    const payload = (await callToolJson('metro__symbolicate', {
      metroUrl: closedMetroUrl,
      stack: '    at render (http://localhost:8081/index.bundle:100:20)',
    })) as { error?: string; frames?: unknown[]; skipped?: boolean };
    expect(payload.skipped).toBe(true);
    expect(payload.error).toContain('unreachable');
    // The raw parsed frames still come back so the agent keeps something.
    expect(payload.frames).toHaveLength(1);
  });

  it('metro__symbolicate errors when nothing parses out of the stack', async () => {
    const payload = await callToolJson('metro__symbolicate', {
      metroUrl,
      stack: 'complete garbage',
    });
    expect(payload).toEqual({ error: 'No frames parsed from input.', frames: [], skipped: true });
  });

  it('metro__open_in_editor posts the frame to /open-stack-frame', async () => {
    metroRequests.length = 0;
    const payload = await callToolJson('metro__open_in_editor', {
      column: 3,
      file: 'src/App.tsx',
      lineNumber: 10,
      metroUrl,
    });
    expect(payload).toEqual({ file: 'src/App.tsx', lineNumber: 10, metroUrl, ok: true });

    const request = metroRequests.find((r) => {
      return r.url === '/open-stack-frame';
    });
    expect(request!.method).toBe('POST');
    expect(JSON.parse(request!.body)).toEqual({ column: 3, file: 'src/App.tsx', lineNumber: 10 });
  });

  it('metro__open_in_editor degrades gracefully when Metro is unreachable', async () => {
    const payload = await callToolJson('metro__open_in_editor', {
      file: 'src/App.tsx',
      lineNumber: 10,
      metroUrl: closedMetroUrl,
    });
    expect(payload).toMatchObject({ ok: false, skipped: true });
    expect(String(payload.error)).toContain('unreachable');
  });

  it('metro__get_events subscribes via the auto-detected URL and buffers pushed events', async () => {
    // No metroUrl argument: the capture must land on the stub's /events
    // WebSocket through the client's devServer origin.
    const first = (await callToolJson('metro__get_events', {})) as {
      events: unknown[];
      metroUrl: string;
    };
    expect(first.metroUrl).toBe(metroUrl);
    captures.push(getEventCapture(metroUrl));

    await vi.waitFor(
      () => {
        expect(eventSockets.length).toBeGreaterThan(0);
      },
      { timeout: 5_000 }
    );
    eventSockets[0]!.send(JSON.stringify({ buildID: 'b1', type: 'bundle_build_done' }));
    eventSockets[0]!.send(JSON.stringify({ isInitialUpdate: false, type: 'hmr_update' }));

    let events: Array<{ data: Record<string, unknown>; id: number; type: string }> = [];
    await vi.waitFor(
      async () => {
        const payload = (await callToolJson('metro__get_events', {})) as {
          connected: boolean;
          events: Array<{ data: Record<string, unknown>; id: number; type: string }>;
        };
        expect(payload.events.length).toBeGreaterThanOrEqual(2);
        expect(payload.connected).toBe(true);
        events = payload.events;
      },
      { timeout: 5_000 }
    );
    expect(events[0]).toMatchObject({ data: { buildID: 'b1' }, type: 'bundle_build_done' });
    expect(events[1]).toMatchObject({ type: 'hmr_update' });
  });

  it('metro__get_events filters by type and since', async () => {
    const byType = (await callToolJson('metro__get_events', {
      metroUrl,
      type: 'bundle_build_done',
    })) as { events: Array<{ type: string }>; total: number };
    expect(byType.total).toBe(1);
    expect(byType.events[0]!.type).toBe('bundle_build_done');

    const byTypeArray = (await callToolJson('metro__get_events', {
      metroUrl,
      type: ['bundle_build_done', 'hmr_update'],
    })) as { total: number };
    expect(byTypeArray.total).toBe(2);

    const future = (await callToolJson('metro__get_events', {
      metroUrl,
      since: Date.now() + 60_000,
    })) as { events: unknown[]; total: number };
    expect(future.events).toEqual([]);
    expect(future.total).toBe(0);
  });

  it('metro__get_events reports gracefully when Metro is absent', async () => {
    const capture = getEventCapture(closedMetroUrl);
    const payload = (await callToolJson('metro__get_events', {
      metroUrl: closedMetroUrl,
    })) as { connected: boolean; events: unknown[] };
    expect(payload.connected).toBe(false);
    expect(payload.events).toEqual([]);

    // Let the failed connection settle (socket errored + closed), then
    // dispose so the auto-reconnect timer doesn't outlive the suite.
    const internals = capture as unknown as CaptureInternals;
    await vi.waitFor(
      () => {
        expect(internals.ws).toBeNull();
      },
      { timeout: 5_000 }
    );
    capture.dispose();
  });
});
