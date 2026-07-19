/* eslint-disable import/extensions -- deep SDK imports (.js) trip the alias
   resolver; same exemption src/server/mcpServer.ts gets via .eslintrc. */
// Integration coverage for the iOS branch of host-side device resolution: a
// real Bridge on an ephemeral port, the real McpServerWrapper over an
// in-memory MCP transport, and a ProcessRunner stub serving canned
// `xcrun simctl list devices --json` fixtures — no real xcrun/ios-hid
// processes are ever spawned. Scenarios run in order and share state — they
// model one server lifetime.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { Bridge, type BridgeEvents } from '@/server/bridge';
import { hostModule } from '@/server/host';
import { clearDeviceCache } from '@/server/host/deviceResolver';
import {
  ProcessNotFoundError,
  type ProcessResult,
  type ProcessRunner,
} from '@/server/host/processRunner';
import { McpServerWrapper } from '@/server/mcpServer';
import { PROTOCOL_VERSION, type ServerMessage, type ToolResponse } from '@/shared/protocol';

vi.setConfig({ testTimeout: 15_000 });

const UDID_PRO = 'AAAAAAAA-0000-4000-8000-000000000001';
const UDID_AIR = 'AAAAAAAA-0000-4000-8000-000000000002';
const IOS_BUNDLE_ID = 'com.probe.ios';

interface SimFixture {
  name: string;
  state: string;
  udid: string;
}

// Exact shape `listIosSimulators` parses: { devices: { "<runtime>": [ { name,
// state, udid } ] } } — the runtime key itself is opaque to the resolver.
const simctlJson = (sims: SimFixture[]): string => {
  return JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-0': sims,
    },
  });
};

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

describe('host tools iOS device resolution (integration)', () => {
  let bridge: Bridge;
  let wrapper: McpServerWrapper;
  let mcpClient: Client;
  let port: number;
  let simctlStdout = simctlJson([]);
  let xcrunMissing = false;
  const runnerCalls: RecordedCall[] = [];
  const openSockets: WebSocket[] = [];

  // ProcessRunner stub: records every (command, args) invocation. `xcrun
  // simctl list` serves the current fixture; the ios-hid binary (a path, not
  // a bare command) just succeeds — it is never actually executed.
  const runner: ProcessRunner = (command, args) => {
    runnerCalls.push({ args: [...args], command });
    if (xcrunMissing && command === 'xcrun') {
      return Promise.reject(new ProcessNotFoundError('xcrun'));
    }
    if (command === 'xcrun' && args[0] === 'simctl' && args[1] === 'list') {
      return Promise.resolve(processResult(simctlStdout));
    }
    return Promise.resolve(processResult(''));
  };

  const waitEvent = <K extends keyof BridgeEvents>(event: K): Promise<BridgeEvents[K]> => {
    return new Promise((resolve) => {
      bridge.once(event, ((...eventArgs: BridgeEvents[K]) => {
        resolve(eventArgs);
      }) as never);
    });
  };

  // Fake iOS RN client: registers with a label + deviceId so device
  // resolution can label-match it against the simctl fixture.
  const connectIosClient = async (label: string, deviceId: string): Promise<WebSocket> => {
    const added = waitEvent('clientAdded');
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('error', () => {});
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMessage;
      if (msg.type === 'server_hello') {
        ws.send(
          JSON.stringify({
            appName: 'IosProbe',
            bundleId: IOS_BUNDLE_ID,
            deviceId,
            label,
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

    wrapper = new McpServerWrapper(bridge, [hostModule(runner)]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await wrapper.connectTransport(serverTransport);

    mcpClient = new Client({ name: 'vitest-harness', version: '1.0.0' });
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

  beforeEach(() => {
    // The device list is cached module-scope for 5s — reset between tests so
    // every scenario re-reads its own fixture.
    clearDeviceCache();
    runnerCalls.length = 0;
  });

  it('resolves the single booted simulator and taps through ios-hid', async () => {
    simctlStdout = simctlJson([
      { name: 'iPhone 17 Pro', state: 'Booted', udid: UDID_PRO },
      { name: 'iPhone Air', state: 'Shutdown', udid: UDID_AIR },
    ]);
    const payload = await callToolJson('host__tap', { x: 120, y: 240 });
    expect(payload).toMatchObject({ tapped: true, x: 120, y: 240 });
    expect(payload.device).toEqual({
      displayName: 'iPhone 17 Pro',
      kind: 'simulator',
      nativeId: UDID_PRO,
      platform: 'ios',
    });
    expect(runnerCalls).toHaveLength(2);
    expect(runnerCalls[0]).toEqual({
      args: ['simctl', 'list', 'devices', '--json'],
      command: 'xcrun',
    });
    // The input backend is the bundled ios-hid binary invoked by absolute
    // path — the stub records the call without ever executing it.
    expect(runnerCalls[1]!.command).toMatch(/bin[/\\]ios-hid$/);
    expect(runnerCalls[1]!.args).toEqual(['tap', UDID_PRO, '120', '240']);
  });

  it('errors with boot guidance when no simulator is booted', async () => {
    simctlStdout = simctlJson([
      { name: 'iPhone 17 Pro', state: 'Shutdown', udid: UDID_PRO },
      { name: 'iPhone Air', state: 'Shutdown', udid: UDID_AIR },
    ]);
    const payload = await callToolJson('host__tap', { platform: 'ios', x: 1, y: 1 });
    expect(String(payload.error)).toContain('No booted iOS simulator');
    // No ios-hid invocation may happen on a failed resolution.
    for (const call of runnerCalls) {
      expect(call.command).toBe('xcrun');
    }
  });

  it('errors with the booted list when several simulators are booted and no clientId given', async () => {
    simctlStdout = simctlJson([
      { name: 'iPhone 17 Pro', state: 'Booted', udid: UDID_PRO },
      { name: 'iPhone Air', state: 'Booted', udid: UDID_AIR },
    ]);
    const payload = await callToolJson('host__tap', { platform: 'ios', x: 1, y: 1 });
    expect(String(payload.error)).toContain('Multiple iOS simulators booted');
    expect(String(payload.error)).toContain(UDID_PRO);
    expect(String(payload.error)).toContain(UDID_AIR);
  });

  it('maps ProcessNotFoundError from the runner to a missing-xcrun message', async () => {
    xcrunMissing = true;
    try {
      const payload = await callToolJson('host__tap', { platform: 'ios', x: 1, y: 1 });
      expect(String(payload.error)).toContain('xcrun not found');
    } finally {
      xcrunMissing = false;
    }
  });

  it('label-matches a connected client to its booted simulator by clientId', async () => {
    simctlStdout = simctlJson([
      { name: 'iPhone 17 Pro', state: 'Booted', udid: UDID_PRO },
      { name: 'iPhone Air', state: 'Booted', udid: UDID_AIR },
    ]);
    await connectIosClient('iPhone 17 Pro', UDID_PRO);
    const payload = await callToolJson('host__tap', { clientId: 'ios-1', x: 10, y: 20 });
    expect(payload).toMatchObject({ tapped: true, x: 10, y: 20 });
    // Two sims are booted — only the client's label disambiguates, and the
    // client's registered bundleId rides along on the resolved device.
    expect(payload.device).toEqual({
      bundleId: IOS_BUNDLE_ID,
      displayName: 'iPhone 17 Pro',
      kind: 'simulator',
      nativeId: UDID_PRO,
      platform: 'ios',
    });
    expect(runnerCalls[1]!.command).toMatch(/bin[/\\]ios-hid$/);
    expect(runnerCalls[1]!.args).toEqual(['tap', UDID_PRO, '10', '20']);
  });

  it('rejects an unknown clientId with the list of known clients', async () => {
    const payload = await callToolJson('host__tap', { clientId: 'ghost-9', x: 1, y: 1 });
    expect(String(payload.error)).toContain("Client 'ghost-9' not found");
    expect(String(payload.error)).toContain('ios-1');
    expect(runnerCalls).toHaveLength(0);
  });

  it('launches the app via simctl using the bundleId registered by the client', async () => {
    simctlStdout = simctlJson([
      { name: 'iPhone 17 Pro', state: 'Booted', udid: UDID_PRO },
      { name: 'iPhone Air', state: 'Booted', udid: UDID_AIR },
    ]);
    const payload = await callToolJson('host__launch_app', { clientId: 'ios-1' });
    expect(payload).toMatchObject({ bundleId: IOS_BUNDLE_ID, launched: true });
    expect(runnerCalls).toEqual([
      { args: ['simctl', 'list', 'devices', '--json'], command: 'xcrun' },
      { args: ['simctl', 'launch', UDID_PRO, IOS_BUNDLE_ID], command: 'xcrun' },
    ]);
  });
});
