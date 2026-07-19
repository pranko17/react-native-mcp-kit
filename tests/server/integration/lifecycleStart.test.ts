// Integration test for the pre-transport client-wait window: a real Bridge on
// an ephemeral port, the real McpServerWrapper, and a fake RN client speaking
// the wire protocol over an actual WebSocket. Scenarios run in order and share
// state — the no-client case must precede the first connect.
//
// Only the wait window is exercised here. The stdio tail of start()
// (StdioServerTransport + process.stdin) is thin SDK wiring covered by the
// connectTransport equivalent in directRegistration.test.ts — spawning a real
// stdio process would test the SDK, not this package.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { Bridge } from '@/server/bridge';
import { McpServerWrapper } from '@/server/mcpServer';
import { type ModuleDescriptor, PROTOCOL_VERSION, type ServerMessage } from '@/shared/protocol';

vi.setConfig({ testTimeout: 15_000 });

const demoModules: ModuleDescriptor[] = [
  {
    description: 'Lifecycle demo module',
    name: 'demo',
    tools: [{ description: 'Ping', name: 'ping' }],
  },
];

// waitForFirstClient is private and the start() that calls it owns the stdio
// transport — tests reach the window through a structural cast instead.
// moduleTools (also private) is read to observe the registration/resolve
// ordering contract.
interface WrapperInternals {
  moduleTools: Map<string, unknown>;
  waitForFirstClient(ms: number): Promise<void>;
}

describe('start() first-client wait window (integration)', () => {
  let bridge: Bridge;
  let wrapper: McpServerWrapper;
  let port: number;
  const openSockets: WebSocket[] = [];

  const internals = (): WrapperInternals => {
    return wrapper as unknown as WrapperInternals;
  };

  // Fake RN client: registers the demo module on server_hello. Fire-and-forget
  // — resolution is observed through waitForFirstClient itself.
  const connectClient = (): void => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('error', () => {});
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMessage;
      if (msg.type === 'server_hello') {
        ws.send(
          JSON.stringify({
            appName: 'Lifecycle',
            bundleId: 'com.lifecycle',
            deviceId: 'DEV-LC',
            modules: demoModules,
            platform: 'ios',
            protocolVersion: PROTOCOL_VERSION,
            type: 'registration',
          })
        );
      }
    });
    openSockets.push(ws);
  };

  beforeAll(async () => {
    bridge = new Bridge(0);
    await bridge.start();
    port = bridge.boundPort()!;
    expect(port).toBeGreaterThan(0);
    wrapper = new McpServerWrapper(bridge, []);
  });

  afterAll(async () => {
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    await bridge.stop();
  });

  it('resolves at the timeout when no client ever connects', async () => {
    expect(bridge.isAnyClientConnected()).toBe(false);
    const startedAt = Date.now();
    await internals().waitForFirstClient(50);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(500);
  });

  it('resolves soon after a client connects mid-window, tools already registered', async () => {
    const startedAt = Date.now();
    const window = internals().waitForFirstClient(5000);
    setTimeout(connectClient, 50);
    await window;
    const elapsed = Date.now() - startedAt;
    // Lower bound: the window actually waited for the connect; upper bound:
    // resolution came from clientAdded, nowhere near the 5000ms timeout.
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(2000);
    // The setImmediate deferral in onClient guarantees the clientAdded tool
    // registrations (synchronous in subscribeToBridge's listener) land before
    // the window resolves — read the registry synchronously right after await.
    expect(internals().moduleTools.has('demo__ping')).toBe(true);
  });

  it('resolves immediately when a client is already connected', async () => {
    expect(bridge.isAnyClientConnected()).toBe(true);
    const startedAt = Date.now();
    await internals().waitForFirstClient(2000);
    const elapsed = Date.now() - startedAt;
    // The connected-client short-circuit returns synchronously — nowhere near
    // the 2000ms timeout.
    expect(elapsed).toBeLessThan(100);
  });
});
