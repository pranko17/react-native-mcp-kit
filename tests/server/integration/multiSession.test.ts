// Multi-session integration: a real Bridge + DaemonCore + ProxyService (the
// daemon side) with RemoteBackend + McpFront session proxies attached over
// real WebSockets on the bridge port, driven end-to-end through the MCP SDK
// Client over InMemoryTransport. A fake RN app speaks the wire protocol so
// module tools flow through the shared catalog to every session.
//
// Not covered here (needs real processes): proxyMain's detached daemon spawn
// and daemonMain's EADDRINUSE race exit — thin child_process/exit wiring.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { z } from 'zod';

import { Bridge } from '@/server/bridge';
import { DaemonCore } from '@/server/daemonCore';
import { doctorTool } from '@/server/host/tools/doctor';
import { type HostModule } from '@/server/host/types';
import { McpFront } from '@/server/mcpFront';
import { ProxyService } from '@/server/proxyService';
import { RemoteBackend, VersionMismatchError } from '@/server/remoteBackend';
import { type ModuleDescriptor, PROTOCOL_VERSION, type ServerMessage } from '@/shared/protocol';

vi.setConfig({ testTimeout: 15_000 });

const VERSION = '9.9.9-test';

const echoHostModule: HostModule = {
  name: 'host',
  tools: {
    doctor: doctorTool(),
    echo: {
      description: 'Echo the given text back.',
      handler: (args) => {
        return Promise.resolve({ echoed: (args as { text?: string }).text ?? null });
      },
      inputSchema: z.looseObject({ text: z.string().optional() }),
    },
  },
};

const demoModules: ModuleDescriptor[] = [
  {
    description: 'Demo module',
    name: 'demo',
    tools: [{ description: 'Ping the app', name: 'ping' }],
  },
];

interface Harness {
  bridge: Bridge;
  core: DaemonCore;
  port: number;
  service: ProxyService;
}

interface SessionHandle {
  client: Client;
  remote: RemoteBackend;
}

describe('multi-session daemon (integration)', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  const startDaemon = async (options?: {
    idleTimeoutMs?: number;
    onIdle?: () => void;
    packageVersion?: string;
  }): Promise<Harness> => {
    const bridge = new Bridge(0);
    const core = new DaemonCore(bridge, [echoHostModule]);
    const service = new ProxyService(bridge, core, {
      idleTimeoutMs: options?.idleTimeoutMs ?? 60_000,
      onIdle: options?.onIdle ?? ((): void => {}),
      packageVersion: options?.packageVersion ?? VERSION,
    });
    await bridge.start();
    cleanups.push(() => {
      return bridge.stop();
    });
    return { bridge, core, port: bridge.boundPort()!, service };
  };

  const attachSession = async (port: number): Promise<SessionHandle> => {
    const remote = await RemoteBackend.connect(port, VERSION);
    const front = new McpFront(remote, VERSION);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await front.connectTransport(serverTransport);
    const client = new Client({ name: 'test-agent', version: '0.0.0' });
    await client.connect(clientTransport);
    cleanups.push(() => {
      remote.close();
    });
    return { client, remote };
  };

  // Fake RN app: registers demo modules on server_hello, answers demo__ping.
  const connectApp = (port: number): Promise<WebSocket> => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.on('error', reject);
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as ServerMessage;
        if (msg.type === 'server_hello') {
          ws.send(
            JSON.stringify({
              appName: 'MultiSession',
              bundleId: 'com.multi',
              deviceId: 'DEV-MS',
              modules: demoModules,
              platform: 'ios',
              protocolVersion: PROTOCOL_VERSION,
              type: 'registration',
            })
          );
          resolve(ws);
        }
        if (msg.type === 'tool_request') {
          ws.send(
            JSON.stringify({
              id: msg.id,
              result: { pong: true },
              type: 'tool_response',
            })
          );
        }
      });
      cleanups.push(() => {
        ws.close();
      });
    });
  };

  const toolNames = async (client: Client): Promise<string[]> => {
    const listed = await client.listTools();
    return listed.tools.map((t) => {
      return t.name;
    });
  };

  it('serves an identical catalog to two concurrent sessions', async () => {
    const { port } = await startDaemon();
    const a = await attachSession(port);
    const b = await attachSession(port);

    const namesA = await toolNames(a.client);
    const namesB = await toolNames(b.client);
    expect(namesA).toEqual(namesB);
    expect(namesA).toContain('host__echo');
    expect(namesA).toContain('wait_until');
    expect(namesA).toContain('assert');

    const result = await b.client.callTool({
      arguments: { text: 'hi' },
      name: 'host__echo',
    });
    const content = result.content as Array<{ text: string; type: string }>;
    expect(JSON.parse(content[0]!.text)).toEqual({ echoed: 'hi' });
  });

  it('reports the attached session count via host__doctor', async () => {
    const { port } = await startDaemon();

    const a = await attachSession(port);
    const first = await a.client.callTool({ arguments: {}, name: 'host__doctor' });
    const firstReport = JSON.parse((first.content as Array<{ text: string }>)[0]!.text) as {
      server: { sessions: number };
    };
    expect(firstReport.server.sessions).toBe(1);

    const b = await attachSession(port);
    const second = await b.client.callTool({ arguments: {}, name: 'host__doctor' });
    const secondReport = JSON.parse((second.content as Array<{ text: string }>)[0]!.text) as {
      server: { sessions: number };
    };
    expect(secondReport.server.sessions).toBe(2);
  });

  it('propagates app module tools and tools_changed to every session', async () => {
    const { port } = await startDaemon();
    const a = await attachSession(port);
    const b = await attachSession(port);

    const changedA = new Promise<void>((resolve) => {
      const off = a.remote.onToolsChanged(() => {
        off();
        resolve();
      });
    });
    const changedB = new Promise<void>((resolve) => {
      const off = b.remote.onToolsChanged(() => {
        off();
        resolve();
      });
    });

    await connectApp(port);
    await changedA;
    await changedB;

    expect(await toolNames(a.client)).toContain('demo__ping');
    expect(await toolNames(b.client)).toContain('demo__ping');

    const result = await a.client.callTool({ arguments: {}, name: 'demo__ping' });
    const content = result.content as Array<{ text: string; type: string }>;
    expect(JSON.parse(content[0]!.text)).toEqual({ pong: true });
  });

  it('rejects a session whose package version differs from the daemon', async () => {
    const { port } = await startDaemon({ packageVersion: '1.0.0-other' });
    await expect(RemoteBackend.connect(port, VERSION)).rejects.toThrow(VersionMismatchError);
    await expect(RemoteBackend.connect(port, VERSION)).rejects.toThrow(/1\.0\.0-other/);
  });

  it('raises MethodNotFound over the proxy for an unknown tool', async () => {
    const { port } = await startDaemon();
    const { client } = await attachSession(port);
    await expect(client.callTool({ arguments: {}, name: 'demo__ping' })).rejects.toThrow(
      /not found/
    );
  });

  it('surfaces schema validation as an in-band isError result over the proxy', async () => {
    const { port } = await startDaemon();
    const { client } = await attachSession(port);
    const result = await client.callTool({
      arguments: { predicate: {} },
      name: 'assert',
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ text: string; type: string }>;
    expect(content[0]!.text).toContain('"tool"');
  });

  it('fires onIdle only after the last proxy disconnects and the timeout passes', async () => {
    const onIdle = vi.fn();
    const { port, service } = await startDaemon({ idleTimeoutMs: 120, onIdle });

    const a = await attachSession(port);
    const b = await attachSession(port);
    expect(service.proxyCount()).toBe(2);

    a.remote.close();
    await vi.waitFor(() => {
      expect(service.proxyCount()).toBe(1);
    });
    await new Promise((r) => {
      return setTimeout(r, 200);
    });
    expect(onIdle).not.toHaveBeenCalled();

    b.remote.close();
    await vi.waitFor(() => {
      expect(onIdle).toHaveBeenCalledOnce();
    });
  });

  it('fires onIdle for a daemon no proxy ever connected to', async () => {
    const onIdle = vi.fn();
    await startDaemon({ idleTimeoutMs: 80, onIdle });
    await vi.waitFor(() => {
      expect(onIdle).toHaveBeenCalledOnce();
    });
  });

  it('stays alive while an app is connected with no sessions, dies once both are gone', async () => {
    const onIdle = vi.fn();
    const { port, service } = await startDaemon({ idleTimeoutMs: 150, onIdle });

    // Session attaches first (cancels the daemon's initial idle timer), then an
    // app connects.
    const s = await attachSession(port);
    const app = await connectApp(port);

    // Drop the only session — the app is still connected, so NOT idle.
    s.remote.close();
    await vi.waitFor(() => {
      expect(service.proxyCount()).toBe(0);
    });
    await new Promise((r) => {
      return setTimeout(r, 350);
    });
    expect(onIdle).not.toHaveBeenCalled();

    // Now the app leaves too — fully idle, daemon exits.
    app.close();
    await vi.waitFor(() => {
      expect(onIdle).toHaveBeenCalledOnce();
    });
  });

  it('emits down on the session backend when the daemon stops', async () => {
    const { bridge, port } = await startDaemon();
    const { remote } = await attachSession(port);
    const down = new Promise<void>((resolve) => {
      remote.on('down', resolve);
    });
    await bridge.stop();
    await down;
  });
});
