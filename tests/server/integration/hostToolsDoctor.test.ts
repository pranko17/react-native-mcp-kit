/* eslint-disable import/extensions -- deep SDK imports (.js) trip the alias
   resolver; same exemption src/server/mcpServer.ts gets via .eslintrc. */
// Integration coverage for host__doctor: real Bridge + McpServerWrapper over an
// in-memory MCP transport, a local HTTP server standing in for Metro, and a
// fake RN client that answers the fiber_tree probe with a canned result.
import { createServer as createHttpServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { z } from 'zod';

import { serializeInputSchema } from '@/client/utils/serializeInputSchema';
import { Bridge } from '@/server/bridge';
import { hostModule } from '@/server/host';
import { runProcess } from '@/server/host/processRunner';
import { McpServerWrapper } from '@/server/mcpServer';
import { metroModule } from '@/server/metro';
import { type ModuleDescriptor, PROTOCOL_VERSION, type ServerMessage } from '@/shared/protocol';

vi.setConfig({ testTimeout: 15_000 });

const fiberTreeModule: ModuleDescriptor = {
  name: 'fiber_tree',
  tools: [
    {
      description: 'Fiber tree query.',
      inputSchema: serializeInputSchema(z.looseObject({})),
      name: 'query',
    },
  ],
};

interface DoctorReport {
  babelPlugin: { applied: boolean | null; checked: boolean; detail: string };
  clients: { connected: number; disconnected: number; list: unknown[] };
  metro: { detail: string; reachable: boolean; url: string };
  ok: boolean;
  problems: string[];
  server: {
    packageVersion: string;
    pid: number;
    port: number | null;
    sessions: number;
    uptimeSec: number;
  };
}

describe('host__doctor (integration)', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  const startServer = async (): Promise<{ bridge: Bridge; client: Client; port: number }> => {
    const bridge = new Bridge(0);
    await bridge.start();
    const port = bridge.boundPort()!;
    const wrapper = new McpServerWrapper(bridge, [hostModule(runProcess), metroModule()]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await wrapper.connectTransport(serverTransport);
    const client = new Client({ name: 'doctor-harness', version: '1.0.0' });
    await client.connect(clientTransport);
    cleanups.push(async () => {
      await client.close();
      await bridge.stop();
    });
    return { bridge, client, port };
  };

  // Fake RN client that answers the fiber_tree query probe with `queryResult`.
  // Resolves once the bridge has actually registered it (clientAdded), not
  // merely when the socket sent its registration.
  const connectClient = (
    bridge: Bridge,
    port: number,
    queryResult: unknown,
    devServerUrl?: string
  ): Promise<void> => {
    const registered = new Promise<void>((resolve) => {
      bridge.once('clientAdded', () => {
        resolve();
      });
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('error', () => {});
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMessage;
      if (msg.type === 'server_hello') {
        ws.send(
          JSON.stringify({
            appName: 'DoctorProbe',
            bundleId: 'com.doctor.probe',
            devServer: devServerUrl
              ? { bundleLoadedFromServer: true, host: 'x', port: 0, url: devServerUrl }
              : undefined,
            deviceId: 'IOS-DOC-1',
            modules: [fiberTreeModule],
            platform: 'ios',
            protocolVersion: PROTOCOL_VERSION,
            type: 'registration',
          })
        );
      }
      if (msg.type === 'tool_request') {
        ws.send(JSON.stringify({ id: msg.id, result: queryResult, type: 'tool_response' }));
      }
    });
    cleanups.push(() => {
      ws.close();
    });
    return registered;
  };

  const startMetroStub = async (): Promise<string> => {
    const stub: Server = createHttpServer((req, res) => {
      if (req.url === '/status') {
        res.writeHead(200);
        res.end('packager-status:running');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => {
      stub.listen(0, '127.0.0.1', resolve);
    });
    cleanups.push(() => {
      return new Promise<void>((resolve) => {
        stub.close(() => {
          resolve();
        });
      });
    });
    return `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  };

  // A guaranteed-closed URL: bind, read the port, release it.
  const closedUrl = async (): Promise<string> => {
    const throwaway = createHttpServer();
    await new Promise<void>((resolve) => {
      throwaway.listen(0, '127.0.0.1', resolve);
    });
    const url = `http://127.0.0.1:${(throwaway.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => {
      throwaway.close(() => {
        resolve();
      });
    });
    return url;
  };

  const runDoctor = async (
    client: Client,
    args: Record<string, unknown>
  ): Promise<DoctorReport> => {
    const res = await client.callTool({ arguments: args, name: 'host__doctor' });
    const content = res.content as Array<{ type: string; text?: string }>;
    return JSON.parse(content[0]!.text!) as DoctorReport;
  };

  it('reports the daemon, no clients, unreachable Metro, and an unprobed plugin', async () => {
    const { client } = await startServer();
    const report = await runDoctor(client, { metroUrl: await closedUrl() });

    expect(report.server.packageVersion).toMatch(/\d+\.\d+\.\d+/);
    expect(report.server.port).toBeGreaterThan(0);
    // Embedding mode (McpServerWrapper, no proxy layer) — zero proxy sessions.
    expect(report.server.sessions).toBe(0);
    expect(report.clients.connected).toBe(0);
    expect(report.metro.reachable).toBe(false);
    expect(report.babelPlugin.checked).toBe(false);
    expect(report.babelPlugin.applied).toBeNull();
    expect(report.ok).toBe(false);
    expect(report.problems.join('\n')).toContain('No RN client connected');
    expect(report.problems.join('\n')).toContain('Metro is not reachable');
  });

  it('passes clean when a client is connected, Metro answers, and the tree is stamped', async () => {
    const { bridge, client, port } = await startServer();
    const metroUrl = await startMetroStub();
    await connectClient(
      bridge,
      port,
      { matches: [{ mcpId: 'View:screens/Home:12' }], total: 4 },
      metroUrl
    );

    const report = await runDoctor(client, {});

    expect(report.clients.connected).toBe(1);
    expect(report.metro.reachable).toBe(true);
    expect(report.babelPlugin.checked).toBe(true);
    expect(report.babelPlugin.applied).toBe(true);
    expect(report.babelPlugin.detail).toContain('View:screens/Home:12');
    expect(report.ok).toBe(true);
    expect(report.problems).toHaveLength(0);
  });

  it('flags the babel plugin when the tree carries no mcpIds', async () => {
    const { bridge, client, port } = await startServer();
    const metroUrl = await startMetroStub();
    await connectClient(bridge, port, { matches: [], total: 0 }, metroUrl);

    const report = await runDoctor(client, {});

    expect(report.metro.reachable).toBe(true);
    expect(report.babelPlugin.checked).toBe(true);
    expect(report.babelPlugin.applied).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.problems.join('\n')).toContain('test-id babel plugin did not run');
  });

  it('probes each client and flags babel when one of several lacks mcpIds', async () => {
    const { bridge, client, port } = await startServer();
    const metroUrl = await startMetroStub();
    // Two apps: the first stamped, the second not (e.g. built without the plugin).
    await connectClient(bridge, port, { matches: [{ mcpId: 'View:A:1' }], total: 3 }, metroUrl);
    await connectClient(bridge, port, { matches: [], total: 0 }, metroUrl);

    const report = await runDoctor(client, {});

    expect(report.clients.connected).toBe(2);
    // Per-client probe (not one ambiguous "specify clientId" failure).
    expect(report.babelPlugin.checked).toBe(true);
    expect(report.babelPlugin.applied).toBe(false);
    expect(report.babelPlugin.detail).toContain('3 mcpIds');
    expect(report.babelPlugin.detail).toContain('no mcpIds');
    expect(report.ok).toBe(false);
    expect(report.problems.join('\n')).toContain('test-id babel plugin did not run');
  });
});
