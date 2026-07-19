/* eslint-disable import/extensions -- deep SDK imports (.js) trip the alias
   resolver; same exemption src/server/mcpServer.ts gets via .eslintrc. */
// Integration coverage for the server-side host + metro modules: a real Bridge
// on an ephemeral port, the real McpServerWrapper over an in-memory MCP
// transport, a ProcessRunner stub instead of real adb/simctl, and a local HTTP
// server standing in for Metro. Scenarios run in order and share state — they
// model one server lifetime.
import { createServer as createHttpServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { z } from 'zod';

import { serializeInputSchema } from '@/client/utils/serializeInputSchema';
import { Bridge, type BridgeEvents } from '@/server/bridge';
import { hostModule } from '@/server/host';
import { clearDeviceCache } from '@/server/host/deviceResolver';
import { type ProcessResult, type ProcessRunner } from '@/server/host/processRunner';
import { McpServerWrapper } from '@/server/mcpServer';
import { metroModule } from '@/server/metro';
import {
  type ModuleDescriptor,
  PROTOCOL_VERSION,
  type ServerMessage,
  type ToolResponse,
} from '@/shared/protocol';

vi.setConfig({ testTimeout: 15_000 });

const HOST_TOOL_NAMES = [
  'host__connection_status',
  'host__doctor',
  'host__drag',
  'host__launch_app',
  'host__list_devices',
  'host__long_press',
  'host__press_key',
  'host__restart_app',
  'host__screenshot',
  'host__swipe',
  'host__tap',
  'host__tap_fiber',
  'host__terminate_app',
  'host__type_text',
  'host__type_text_batch',
];

const METRO_TOOL_NAMES = [
  'metro__get_events',
  'metro__open_in_editor',
  'metro__reload',
  'metro__status',
  'metro__symbolicate',
];

const WRAPPER_TOOL_NAMES = ['assert', 'wait_until'];

// Android is the deterministic device-resolution path: one online `adb
// devices` entry + one connected android client auto-resolve without touching
// xcrun/simctl or any label matching.
const ANDROID_SERIAL = 'emulator-5554';
const ADB_DEVICES_STDOUT = `List of devices attached\n${ANDROID_SERIAL}\tdevice\n\n`;

interface RecordedCall {
  args: string[];
  command: string;
}

const processResult = (stdout: string): ProcessResult => {
  return {
    exitCode: 0,
    signal: null,
    stderr: Buffer.alloc(0),
    stdout: Buffer.from(stdout, 'utf8'),
    timedOut: false,
  };
};

// ProcessRunner stub: records every (command, args) invocation and serves
// canned stdout — no real adb/simctl processes are ever spawned.
const createRunnerStub = (): { calls: RecordedCall[]; runner: ProcessRunner } => {
  const calls: RecordedCall[] = [];
  const runner: ProcessRunner = (command, args) => {
    calls.push({ args: [...args], command });
    if (command === 'adb' && args[0] === 'devices') {
      return Promise.resolve(processResult(ADB_DEVICES_STDOUT));
    }
    return Promise.resolve(processResult(''));
  };
  return { calls, runner };
};

const probeModule: ModuleDescriptor = {
  name: 'probe',
  tools: [
    {
      description: 'Echo probe used by the integration harness.',
      inputSchema: serializeInputSchema(z.looseObject({})),
      name: 'status',
    },
  ],
};

describe('host + metro tools (integration)', () => {
  let bridge: Bridge;
  let wrapper: McpServerWrapper;
  let mcpClient: Client;
  let port: number;
  let runnerCalls: RecordedCall[];
  let metroStub: Server;
  let metroUrl: string;
  let closedMetroUrl: string;
  const metroRequests: Array<{ method: string; url: string }> = [];
  const openSockets: WebSocket[] = [];

  const waitEvent = <K extends keyof BridgeEvents>(event: K): Promise<BridgeEvents[K]> => {
    return new Promise((resolve) => {
      bridge.once(event, ((...eventArgs: BridgeEvents[K]) => {
        resolve(eventArgs);
      }) as never);
    });
  };

  const connectClient = async (modules: ModuleDescriptor[]): Promise<WebSocket> => {
    const added = waitEvent('clientAdded');
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('error', () => {});
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMessage;
      if (msg.type === 'server_hello') {
        ws.send(
          JSON.stringify({
            appName: 'HostProbe',
            bundleId: 'com.host.probe',
            deviceId: 'ANDROID-DEV-1',
            modules,
            platform: 'android',
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

  const listToolNames = async (): Promise<string[]> => {
    const res = await mcpClient.listTools();
    return res.tools.map((t) => {
      return t.name;
    });
  };

  const callToolText = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const res = await mcpClient.callTool({ arguments: args, name });
    const content = res.content as Array<{ type: string; text?: string }>;
    return content
      .filter((c) => {
        return c.type === 'text';
      })
      .map((c) => {
        return c.text ?? '';
      })
      .join('\n');
  };

  beforeAll(async () => {
    bridge = new Bridge(0);
    await bridge.start();
    port = bridge.boundPort()!;
    expect(port).toBeGreaterThan(0);

    const stub = createRunnerStub();
    runnerCalls = stub.calls;
    wrapper = new McpServerWrapper(bridge, [hostModule(stub.runner), metroModule()]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await wrapper.connectTransport(serverTransport);

    mcpClient = new Client({ name: 'vitest-harness', version: '1.0.0' });
    await mcpClient.connect(clientTransport);

    // Local Metro stand-in: answers /status and /reload, records every hit.
    metroStub = createHttpServer((req, res) => {
      metroRequests.push({ method: req.method ?? '', url: req.url ?? '' });
      if (req.url === '/status') {
        res.writeHead(200);
        res.end('packager-status:running');
        return;
      }
      if (req.url === '/reload' && req.method === 'POST') {
        res.writeHead(200);
        res.end('OK');
        return;
      }
      res.writeHead(404);
      res.end();
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
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    await mcpClient.close();
    await bridge.stop();
    await new Promise<void>((resolve) => {
      metroStub.close(() => {
        resolve();
      });
    });
  });

  beforeEach(() => {
    // The device list is cached module-scope for 5s — reset between tests so
    // every scenario sees its own `adb devices` call recorded.
    clearDeviceCache();
  });

  it('serves every host tool, metro tool and both wrappers with no clients connected', async () => {
    const names = await listToolNames();
    expect(names).toHaveLength(
      HOST_TOOL_NAMES.length + METRO_TOOL_NAMES.length + WRAPPER_TOOL_NAMES.length
    );
    for (const name of [...HOST_TOOL_NAMES, ...METRO_TOOL_NAMES, ...WRAPPER_TOOL_NAMES]) {
      expect(names).toContain(name);
    }
  });

  it('publishes host__tap with required x/y and an optional injected clientId', async () => {
    const res = await mcpClient.listTools();
    const tool = res.tools.find((t) => {
      return t.name === 'host__tap';
    });
    const schema = tool!.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.required).toEqual(expect.arrayContaining(['x', 'y']));
    expect(schema.properties?.clientId).toBeDefined();
    expect(schema.required ?? []).not.toContain('clientId');
  });

  it('host__connection_status answers with an empty bridge (clientCount 0)', async () => {
    const payload = JSON.parse(await callToolText('host__connection_status', {})) as {
      clientCount: number;
      clients: unknown[];
      disconnected: unknown[];
    };
    expect(payload.clientCount).toBe(0);
    expect(payload.clients).toEqual([]);
    expect(payload.disconnected).toEqual([]);
  });

  it('rejects host__tap without the required x at schema validation', async () => {
    const res = await mcpClient.callTool({ arguments: { y: 10 }, name: 'host__tap' });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain('"x"');
    expect(runnerCalls).toHaveLength(0);
  });

  it('host__connection_status lists a connected fake client with its modules', async () => {
    await connectClient([probeModule]);
    const payload = JSON.parse(await callToolText('host__connection_status', {})) as {
      clientCount: number;
      clients: Array<{ id: string; modules: string[]; platform: string; status: string }>;
    };
    expect(payload.clientCount).toBe(1);
    expect(payload.clients[0]).toMatchObject({
      modules: ['probe'],
      platform: 'android',
      status: 'active',
    });
  });

  it('routes host__tap through android device resolution to the runner stub', async () => {
    runnerCalls.length = 0;
    const payload = JSON.parse(await callToolText('host__tap', { x: 100, y: 200 })) as {
      device?: { nativeId: string; platform: string };
      tapped?: boolean;
      x?: number;
      y?: number;
    };
    expect(payload).toMatchObject({ tapped: true, x: 100, y: 200 });
    expect(payload.device).toMatchObject({ nativeId: ANDROID_SERIAL, platform: 'android' });
    expect(runnerCalls).toEqual([
      { args: ['devices'], command: 'adb' },
      { args: ['-s', ANDROID_SERIAL, 'shell', 'input', 'tap', '100', '200'], command: 'adb' },
    ]);
  });

  it('metro__status reports running against the local Metro stub', async () => {
    const payload = JSON.parse(await callToolText('metro__status', { metroUrl })) as {
      metroUrl: string;
      running: boolean;
    };
    expect(payload.running).toBe(true);
    expect(payload.metroUrl).toBe(metroUrl);
    expect(metroRequests).toContainEqual({ method: 'GET', url: '/status' });
  });

  it('metro__reload posts to the stub and returns ok', async () => {
    const payload = JSON.parse(await callToolText('metro__reload', { metroUrl })) as {
      metroUrl: string;
      ok: boolean;
    };
    expect(payload.ok).toBe(true);
    expect(payload.metroUrl).toBe(metroUrl);
    expect(metroRequests).toContainEqual({ method: 'POST', url: '/reload' });
  });

  it('metro__reload degrades gracefully when Metro is unreachable', async () => {
    const payload = JSON.parse(
      await callToolText('metro__reload', { metroUrl: closedMetroUrl })
    ) as { ok: boolean; error?: string; skipped?: boolean };
    expect(payload.ok).toBe(false);
    expect(payload.skipped).toBe(true);
    expect(payload.error).toContain('unreachable');
  });
});
