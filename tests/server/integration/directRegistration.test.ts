/* eslint-disable import/extensions -- deep SDK imports (.js) trip the alias
   resolver; same exemption src/server/mcpServer.ts gets via .eslintrc. */
// End-to-end protocol test for direct tool registration: a real Bridge on an
// ephemeral port, the real McpServerWrapper over an in-memory MCP transport,
// and fake RN clients speaking the wire protocol over actual WebSockets.
// Scenarios run in order and share state — they model one server lifetime.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { z } from 'zod';

import { serializeInputSchema } from '@/client/utils/serializeInputSchema';
import {
  alertModule,
  consoleModule,
  deviceModule,
  errorsModule,
  fiberTreeModule,
  i18nextModule,
  logBoxModule,
  navigationModule,
  networkModule,
  reactQueryModule,
  reduxModule,
  storageModule,
} from '@/modules';
import { Bridge, type BridgeEvents } from '@/server/bridge';
import { McpServerWrapper } from '@/server/mcpServer';
import {
  type ModuleDescriptor,
  PROTOCOL_VERSION,
  type ServerMessage,
  type ToolResponse,
} from '@/shared/protocol';

vi.setConfig({ testTimeout: 15_000 });

// Real wire-format module descriptors from the real factories — handlers are
// never invoked server-side, so runtime deps can be stubbed with a Proxy.
const stub = new Proxy({}, { get: () => () => {} }) as never;

const realModules: ModuleDescriptor[] = [
  alertModule(),
  consoleModule(),
  deviceModule(),
  errorsModule(),
  fiberTreeModule(),
  i18nextModule(stub),
  logBoxModule(),
  navigationModule(stub),
  networkModule(),
  reactQueryModule(stub),
  reduxModule(stub),
  storageModule({ adapter: stub, name: 'mmkv' }),
].map((mod) => {
  return {
    description: mod.description,
    name: mod.name,
    tools: Object.entries(mod.tools).map(([name, tool]) => {
      return {
        description: tool.description,
        inputSchema: serializeInputSchema(tool.inputSchema),
        name,
        timeout: tool.timeout,
      };
    }),
  };
});

const MODULE_TOOL_COUNT = realModules.reduce((n, mod) => {
  return n + mod.tools.length;
}, 0);
const WRAPPER_TOOL_COUNT = 2; // wait_until + assert
const CONSOLE_TOOL_COUNT = realModules.find((m) => {
  return m.name === 'console';
})!.tools.length;

interface Identity {
  appName: string;
  bundleId: string;
  deviceId: string;
  label?: string;
}

const ID_A: Identity = { appName: 'A', bundleId: 'com.a', deviceId: 'DEV-A', label: 'Phone A' };
const ID_B: Identity = { appName: 'B', bundleId: 'com.b', deviceId: 'DEV-B', label: 'Phone B' };

describe('direct tool registration (integration)', () => {
  let bridge: Bridge;
  let wrapper: McpServerWrapper;
  let mcpClient: Client;
  let port: number;
  let listChangedCount = 0;
  const openSockets: WebSocket[] = [];

  const waitEvent = <K extends keyof BridgeEvents>(event: K): Promise<BridgeEvents[K]> => {
    return new Promise((resolve) => {
      bridge.once(event, ((...eventArgs: BridgeEvents[K]) => {
        resolve(eventArgs);
      }) as never);
    });
  };

  const registrationPayload = (modules: ModuleDescriptor[], identity: Identity): string => {
    return JSON.stringify({
      modules,
      platform: 'ios',
      protocolVersion: PROTOCOL_VERSION,
      type: 'registration',
      ...identity,
    });
  };

  // Fake RN client: registers on server_hello, answers every tool_request by
  // echoing the received args back so routing and arg passthrough are visible.
  const connectClient = async (
    modules: ModuleDescriptor[],
    identity: Identity
  ): Promise<WebSocket> => {
    const added = waitEvent('clientAdded');
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('error', () => {});
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMessage;
      if (msg.type === 'server_hello') {
        ws.send(registrationPayload(modules, identity));
      }
      if (msg.type === 'tool_request') {
        const response: ToolResponse = {
          id: msg.id,
          result: { args: msg.args, from: identity.deviceId, tool: `${msg.module}__${msg.method}` },
          type: 'tool_response',
        };
        ws.send(JSON.stringify(response));
      }
    });
    await added;
    openSockets.push(ws);
    return ws;
  };

  const closeClient = async (ws: WebSocket): Promise<void> => {
    const removed = waitEvent('clientRemoved');
    ws.close();
    await removed;
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
    return (
      content
        .filter((c) => {
          return c.type === 'text';
        })
        .map((c) => {
          return c.text ?? '';
        })
        .join('\n') ?? ''
    );
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
    mcpClient.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      listChangedCount += 1;
    });
    await mcpClient.connect(clientTransport);
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

  let wsA: WebSocket;
  let wsB: WebSocket;

  it('completes the MCP handshake with the package server identity', () => {
    expect(mcpClient.getServerVersion()?.name).toBe('react-native-mcp-kit');
  });

  it('serves only wait_until + assert with no host modules and no clients', async () => {
    const names = await listToolNames();
    expect(names.sort()).toEqual(['assert', 'wait_until']);
    for (const legacy of ['call', 'list_tools', 'describe_tool', 'connection_status']) {
      expect(names).not.toContain(legacy);
    }
  });

  it('registers every module tool when a client connects (49 + 2 wrappers)', async () => {
    const before = listChangedCount;
    wsA = await connectClient(realModules, ID_A);
    const names = await listToolNames();
    expect(MODULE_TOOL_COUNT).toBe(49);
    expect(names).toHaveLength(MODULE_TOOL_COUNT + WRAPPER_TOOL_COUNT);
    expect(names).toContain('fiber_tree__query');
    await vi.waitFor(() => {
      expect(listChangedCount).toBeGreaterThan(before);
    });
  });

  it('injects an optional clientId into every module tool schema', async () => {
    const res = await mcpClient.listTools();
    const tool = res.tools.find((t) => {
      return t.name === 'fiber_tree__query';
    });
    const schema = tool!.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties?.clientId).toBeDefined();
    expect(schema.required ?? []).not.toContain('clientId');
  });

  it('routes a direct call to the single client and strips clientId from inner args', async () => {
    const auto = await callToolText('navigation__navigate', { screen: 'CART' });
    expect(auto).toContain('"from": "DEV-A"');
    expect(auto).toContain('navigation__navigate');

    const explicit = await callToolText('navigation__navigate', {
      clientId: 'ios-1',
      screen: 'CART',
    });
    expect(explicit).toContain('"from": "DEV-A"');
    expect(explicit).not.toContain('clientId');
  });

  it('passes undeclared args through to the client (loose root object)', async () => {
    const text = await callToolText('fiber_tree__query', {
      steps: [{ scope: 'root' }],
      undeclaredExtra: 42,
    });
    expect(text).toContain('"undeclaredExtra": 42');
  });

  it('rejects a call missing required args at schema validation', async () => {
    const res = await mcpClient.callTool({ arguments: {}, name: 'fiber_tree__query' });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain('steps');
  });

  it('registers, serves and unregisters a dynamic tool', async () => {
    const added = waitEvent('dynamicToolAdded');
    wsA.send(
      JSON.stringify({
        module: '__dynamic',
        tool: { description: 'Force logout', name: 'logout' },
        type: 'tool_register',
      })
    );
    await added;
    expect(await listToolNames()).toContain('__dynamic__logout');

    const text = await callToolText('__dynamic__logout', {});
    expect(text).toContain('"from": "DEV-A"');

    const removed = waitEvent('dynamicToolRemoved');
    wsA.send(JSON.stringify({ module: '__dynamic', toolName: 'logout', type: 'tool_unregister' }));
    await removed;
    expect(await listToolNames()).not.toContain('__dynamic__logout');
  });

  it('dedups the catalog when a second client ships identical modules', async () => {
    wsB = await connectClient(realModules, ID_B);
    const names = await listToolNames();
    expect(names).toHaveLength(MODULE_TOOL_COUNT + WRAPPER_TOOL_COUNT);
  });

  it('errors on an ambiguous call with two clients and no clientId', async () => {
    const text = await callToolText('navigation__navigate', { screen: 'CART' });
    expect(text).toContain('Multiple clients');
  });

  it('broadcasts to every client matching a regex clientId', async () => {
    const text = await callToolText('navigation__navigate', {
      clientId: '/^ios/',
      screen: 'CART',
    });
    const envelope = JSON.parse(text) as { failedCount: number; okCount: number };
    expect(envelope.okCount).toBe(2);
    expect(envelope.failedCount).toBe(0);
  });

  it('routes to the matching client with an explicit clientId', async () => {
    const text = await callToolText('navigation__navigate', { clientId: 'ios-2', screen: 'CART' });
    expect(text).toContain('"from": "DEV-B"');
  });

  it('keeps the first registration and warns on a schema conflict', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      return true;
    });
    try {
      const demoX: ModuleDescriptor[] = [
        {
          name: 'demo',
          tools: [
            {
              description: 'ping v1',
              inputSchema: serializeInputSchema(z.looseObject({ a: z.string().optional() })),
              name: 'ping',
            },
          ],
        },
      ];
      const demoY: ModuleDescriptor[] = [
        {
          name: 'demo',
          tools: [
            {
              description: 'ping v2 DIFFERENT',
              inputSchema: serializeInputSchema(z.looseObject({ b: z.number().optional() })),
              name: 'ping',
            },
          ],
        },
      ];
      const wsX = await connectClient(demoX, {
        appName: 'X',
        bundleId: 'com.x',
        deviceId: 'DEV-X',
      });
      const wsY = await connectClient(demoY, {
        appName: 'Y',
        bundleId: 'com.y',
        deviceId: 'DEV-Y',
      });

      const names = await listToolNames();
      expect(
        names.filter((n) => {
          return n === 'demo__ping';
        })
      ).toHaveLength(1);
      const written = stderrSpy.mock.calls
        .map((call) => {
          return String(call[0]);
        })
        .join('');
      expect(written).toContain('schema differs across clients');

      // The mismatched client is still individually addressable.
      const text = await callToolText('demo__ping', { clientId: 'ios-4' });
      expect(text).toContain('"from": "DEV-Y"');

      await closeClient(wsX);
      await closeClient(wsY);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('diffs a re-registration on the same socket, dedup holding via the other client', async () => {
    const consoleOnly = realModules.filter((m) => {
      return m.name === 'console';
    });
    const reregistered = waitEvent('clientReregistered');
    wsB.send(registrationPayload(consoleOnly, ID_B));
    await reregistered;

    // A still ships everything — the shared tools stay registered.
    const names = await listToolNames();
    expect(names).toHaveLength(MODULE_TOOL_COUNT + WRAPPER_TOOL_COUNT);
  });

  it('releases tools by refcount when the last owning client disconnects', async () => {
    await closeClient(wsA);
    const names = await listToolNames();
    expect(names).toHaveLength(CONSOLE_TOOL_COUNT + WRAPPER_TOOL_COUNT);
    expect(names).toContain('console__get_logs');
  });

  it('returns to the base catalog when every client is gone', async () => {
    await closeClient(wsB);
    const names = await listToolNames();
    expect(names).toHaveLength(WRAPPER_TOOL_COUNT);
  });

  it('re-adopts the sticky client id and re-registers tools on reconnect', async () => {
    const wsA2 = await connectClient(realModules, ID_A);
    const names = await listToolNames();
    expect(names).toHaveLength(MODULE_TOOL_COUNT + WRAPPER_TOOL_COUNT);

    // Same identity triple → the ghost slot ios-1 is reused, not ios-5.
    const text = await callToolText('navigation__navigate', { clientId: 'ios-1', screen: 'CART' });
    expect(text).toContain('"from": "DEV-A"');

    await closeClient(wsA2);
  });
});
