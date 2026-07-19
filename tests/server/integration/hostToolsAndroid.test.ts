/* eslint-disable import/extensions -- deep SDK imports (.js) trip the alias
   resolver; same exemption src/server/mcpServer.ts gets via .eslintrc. */
// Integration coverage for the Android-backed host tools: app lifecycle
// (launch / terminate / restart), device enumeration, screenshots, and the
// tap_fiber chain. A real Bridge on an ephemeral port, the real
// McpServerWrapper over an in-memory MCP transport, and a ProcessRunner stub
// serving canned adb/simctl output — no real processes are ever spawned.
// sharp is real: the screenshot fixture is an actual PNG and the response an
// actual WebP. Scenarios run in order and share state — they model one server
// lifetime.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { z } from 'zod';

import { serializeInputSchema } from '@/client/utils/serializeInputSchema';
import { Bridge, type BridgeEvents } from '@/server/bridge';
import { hostModule } from '@/server/host';
import { clearDeviceCache } from '@/server/host/deviceResolver';
import { type ProcessResult, type ProcessRunner } from '@/server/host/processRunner';
import { McpServerWrapper } from '@/server/mcpServer';
import {
  type ModuleDescriptor,
  PROTOCOL_VERSION,
  type ServerMessage,
  type ToolResponse,
} from '@/shared/protocol';

vi.setConfig({ testTimeout: 15_000 });

const ANDROID_SERIAL = 'emulator-5554';
const OFFLINE_SERIAL = 'emulator-5556';
const CLIENT_BUNDLE_ID = 'com.host.probe';
const EXPLICIT_APP_ID = 'com.explicit.app';

const SINGLE_DEVICE_STDOUT = `List of devices attached\n${ANDROID_SERIAL}\tdevice\n\n`;
const TWO_DEVICES_STDOUT = `List of devices attached\n${ANDROID_SERIAL}\tdevice\n${OFFLINE_SERIAL}\toffline\n\n`;

const SIMCTL_STDOUT = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
      { name: 'iPhone 17 Pro', state: 'Booted', udid: 'AAAAAAAA-0000-4000-8000-00000000000A' },
      { name: 'iPhone 16', state: 'Shutdown', udid: 'AAAAAAAA-0000-4000-8000-00000000000B' },
    ],
  },
});

const FIBER_BOUNDS = { centerX: 150, centerY: 300, height: 40, width: 200, x: 50, y: 280 };
const FIBER_BOUNDS_SECOND = { centerX: 400, centerY: 500, height: 40, width: 200, x: 300, y: 480 };

interface RecordedCall {
  args: string[];
  command: string;
}

const processResult = (stdout: Buffer | string): ProcessResult => {
  return {
    exitCode: 0,
    signal: null,
    stderr: Buffer.alloc(0),
    stdout: typeof stdout === 'string' ? Buffer.from(stdout, 'utf8') : stdout,
    timedOut: false,
  };
};

// The fake client ships a fiber_tree module so host__tap_fiber can dispatch
// fiber_tree__query over the wire; responses are canned per steps[0].testID.
const fiberTreeModule: ModuleDescriptor = {
  name: 'fiber_tree',
  tools: [
    {
      description: 'Canned fiber query used by the integration harness.',
      inputSchema: serializeInputSchema(z.looseObject({})),
      name: 'query',
    },
  ],
};

const fiberQueryResult = (args: Record<string, unknown>): unknown => {
  const steps = (args.steps as Array<Record<string, unknown>> | undefined) ?? [];
  const testID = steps[0]?.testID;
  if (testID === 'loginButton') {
    return {
      matches: [{ bounds: FIBER_BOUNDS, mcpId: 'fib-1', name: 'Pressable', testID: 'loginButton' }],
      total: 1,
    };
  }
  if (testID === 'row') {
    return {
      matches: [
        { bounds: FIBER_BOUNDS, mcpId: 'fib-1', name: 'Pressable', testID: 'row' },
        { bounds: FIBER_BOUNDS_SECOND, mcpId: 'fib-2', name: 'Pressable', testID: 'row' },
      ],
      total: 2,
    };
  }
  return { matches: [], total: 0 };
};

describe('host tools Android lifecycle / devices / screenshot / tap_fiber (integration)', () => {
  let bridge: Bridge;
  let wrapper: McpServerWrapper;
  let mcpClient: Client;
  let port: number;
  let adbDevicesStdout = SINGLE_DEVICE_STDOUT;
  let monkeyStdout = 'Events injected: 1\n';
  let screencapPng: Buffer;
  const installedPackages = [EXPLICIT_APP_ID, CLIENT_BUNDLE_ID];
  const runnerCalls: RecordedCall[] = [];
  const openSockets: WebSocket[] = [];

  // ProcessRunner stub: records every (command, args) invocation and serves
  // canned stdout — no real adb/simctl processes are ever spawned.
  const runner: ProcessRunner = (command, args) => {
    runnerCalls.push({ args: [...args], command });
    if (command === 'xcrun' && args[0] === 'simctl' && args[1] === 'list') {
      return Promise.resolve(processResult(SIMCTL_STDOUT));
    }
    if (command !== 'adb') {
      return Promise.resolve(processResult(''));
    }
    if (args[0] === 'devices') {
      return Promise.resolve(processResult(adbDevicesStdout));
    }
    if (args.includes('pm')) {
      const pkg = args[args.length - 1]!;
      const lines = installedPackages
        .filter((installed) => {
          return installed.includes(pkg);
        })
        .map((installed) => {
          return `package:${installed}`;
        });
      return Promise.resolve(processResult(lines.join('\n') + '\n'));
    }
    if (args.includes('monkey')) {
      return Promise.resolve(processResult(monkeyStdout));
    }
    if (args.includes('screencap')) {
      return Promise.resolve(processResult(screencapPng));
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

  const connectAndroidClient = async (): Promise<WebSocket> => {
    const added = waitEvent('clientAdded');
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('error', () => {});
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMessage;
      if (msg.type === 'server_hello') {
        ws.send(
          JSON.stringify({
            appName: 'AndroidProbe',
            bundleId: CLIENT_BUNDLE_ID,
            deviceId: 'ANDROID-DEV-1',
            modules: [fiberTreeModule],
            platform: 'android',
            protocolVersion: PROTOCOL_VERSION,
            type: 'registration',
          })
        );
      }
      if (msg.type === 'tool_request') {
        const result =
          msg.module === 'fiber_tree' && msg.method === 'query'
            ? fiberQueryResult(msg.args)
            : { args: msg.args };
        const response: ToolResponse = { id: msg.id, result, type: 'tool_response' };
        ws.send(JSON.stringify(response));
      }
    });
    await added;
    openSockets.push(ws);
    return ws;
  };

  const callTool = async (
    name: string,
    args: Record<string, unknown>
  ): Promise<Array<{ type: string; data?: string; mimeType?: string; text?: string }>> => {
    const res = await mcpClient.callTool({ arguments: args, name });
    return res.content as Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
  };

  const callToolJson = async (
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
    const content = await callTool(name, args);
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

    // Tiny but valid PNG for the screencap stub — sharp is real, so the
    // screenshot pipeline (decode → resize → webp) runs end to end.
    screencapPng = await sharp({
      create: { background: { b: 40, g: 90, r: 200 }, channels: 3, height: 96, width: 48 },
    })
      .png()
      .toBuffer();
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
    // every scenario sees its own `adb devices` call recorded.
    clearDeviceCache();
    runnerCalls.length = 0;
  });

  it('host__launch_app without appId and without clients demands an explicit appId', async () => {
    const payload = await callToolJson('host__launch_app', { platform: 'android' });
    expect(String(payload.error)).toContain('appId required');
  });

  it('host__launch_app with an explicit appId verifies the package then fires monkey', async () => {
    const payload = await callToolJson('host__launch_app', {
      appId: EXPLICIT_APP_ID,
      platform: 'android',
    });
    expect(payload).toMatchObject({ bundleId: EXPLICIT_APP_ID, launched: true });
    expect(payload.device).toMatchObject({ nativeId: ANDROID_SERIAL, platform: 'android' });
    expect(runnerCalls).toEqual([
      { args: ['devices'], command: 'adb' },
      {
        args: ['-s', ANDROID_SERIAL, 'shell', 'pm', 'list', 'packages', EXPLICIT_APP_ID],
        command: 'adb',
      },
      {
        args: [
          '-s',
          ANDROID_SERIAL,
          'shell',
          'monkey',
          '-p',
          EXPLICIT_APP_ID,
          '-c',
          'android.intent.category.LAUNCHER',
          '1',
        ],
        command: 'adb',
      },
    ]);
  });

  it('host__launch_app without appId falls back to the bundleId the client registered', async () => {
    await connectAndroidClient();
    const payload = await callToolJson('host__launch_app', {});
    expect(payload).toMatchObject({ bundleId: CLIENT_BUNDLE_ID, launched: true });
    const monkeyCall = runnerCalls.find((call) => {
      return call.args.includes('monkey');
    });
    expect(monkeyCall!.args).toContain(CLIENT_BUNDLE_ID);
  });

  it('host__terminate_app force-stops the registered bundleId', async () => {
    const payload = await callToolJson('host__terminate_app', {});
    expect(payload).toMatchObject({ bundleId: CLIENT_BUNDLE_ID, terminated: true });
    expect(runnerCalls).toEqual([
      { args: ['devices'], command: 'adb' },
      {
        args: ['-s', ANDROID_SERIAL, 'shell', 'am', 'force-stop', CLIENT_BUNDLE_ID],
        command: 'adb',
      },
    ]);
  });

  it('host__restart_app force-stops then relaunches in order', async () => {
    const payload = await callToolJson('host__restart_app', {});
    expect(payload).toMatchObject({ bundleId: CLIENT_BUNDLE_ID, restarted: true });
    expect(runnerCalls).toEqual([
      { args: ['devices'], command: 'adb' },
      {
        args: ['-s', ANDROID_SERIAL, 'shell', 'am', 'force-stop', CLIENT_BUNDLE_ID],
        command: 'adb',
      },
      {
        args: ['-s', ANDROID_SERIAL, 'shell', 'pm', 'list', 'packages', CLIENT_BUNDLE_ID],
        command: 'adb',
      },
      {
        args: [
          '-s',
          ANDROID_SERIAL,
          'shell',
          'monkey',
          '-p',
          CLIENT_BUNDLE_ID,
          '-c',
          'android.intent.category.LAUNCHER',
          '1',
        ],
        command: 'adb',
      },
    ]);
  });

  it('host__launch_app refuses a package pm does not know', async () => {
    const payload = await callToolJson('host__launch_app', { appId: 'com.missing.app' });
    expect(String(payload.error)).toContain("'com.missing.app' is not installed");
    const monkeyCall = runnerCalls.find((call) => {
      return call.args.includes('monkey');
    });
    expect(monkeyCall).toBeUndefined();
  });

  it('host__launch_app surfaces monkey "No activities found" as a launcher error', async () => {
    monkeyStdout = 'No activities found to run, monkey aborted.\n';
    try {
      const payload = await callToolJson('host__launch_app', { appId: EXPLICIT_APP_ID });
      expect(String(payload.error)).toContain('no launcher activity');
    } finally {
      monkeyStdout = 'Events injected: 1\n';
    }
  });

  it('host__list_devices merges android + ios fixtures and annotates the connected client', async () => {
    adbDevicesStdout = TWO_DEVICES_STDOUT;
    try {
      const payload = (await callToolJson('host__list_devices', {})) as {
        android: Array<Record<string, unknown>>;
        ios: Array<Record<string, unknown>>;
      };
      expect(payload.android).toEqual([
        {
          clientId: 'android-1',
          connected: true,
          serial: ANDROID_SERIAL,
          state: 'device',
        },
        { connected: false, serial: OFFLINE_SERIAL, state: 'offline' },
      ]);
      expect(payload.ios).toHaveLength(2);
      // No iOS client is connected — booted sims sort first but stay
      // unannotated.
      expect(payload.ios[0]).toMatchObject({
        connected: false,
        name: 'iPhone 17 Pro',
        state: 'Booted',
      });
      expect(payload.ios[1]).toMatchObject({ name: 'iPhone 16', state: 'Shutdown' });
    } finally {
      adbDevicesStdout = SINGLE_DEVICE_STDOUT;
    }
  });

  it('host__list_devices connected:true keeps only devices with a live client', async () => {
    adbDevicesStdout = TWO_DEVICES_STDOUT;
    try {
      const payload = (await callToolJson('host__list_devices', { connected: true })) as {
        android: Array<Record<string, unknown>>;
        ios: Array<Record<string, unknown>>;
      };
      expect(payload.android).toEqual([
        {
          clientId: 'android-1',
          connected: true,
          serial: ANDROID_SERIAL,
          state: 'device',
        },
      ]);
      expect(payload.ios).toEqual([]);
    } finally {
      adbDevicesStdout = SINGLE_DEVICE_STDOUT;
    }
  });

  it('host__screenshot pipes adb screencap through sharp into webp + metadata', async () => {
    const content = await callTool('host__screenshot', {});
    expect(runnerCalls).toEqual([
      { args: ['devices'], command: 'adb' },
      { args: ['-s', ANDROID_SERIAL, 'exec-out', 'screencap', '-p'], command: 'adb' },
    ]);
    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({ mimeType: 'image/webp', type: 'image' });

    const meta = JSON.parse(content[1]!.text!) as Record<string, unknown>;
    // 48x96 source stays as-is: default width 280 never enlarges.
    expect(meta).toMatchObject({
      height: 96,
      originalHeight: 96,
      originalWidth: 48,
      scale: 1,
      width: 48,
    });
    expect(typeof meta.hash).toBe('string');

    const webp = Buffer.from(content[0]!.data!, 'base64');
    const decoded = await sharp(webp).metadata();
    expect(decoded.format).toBe('webp');
    expect(decoded.width).toBe(48);
    expect(decoded.height).toBe(96);
  });

  it('host__screenshot reports unchanged on an identical second capture', async () => {
    const payload = (await callToolJson('host__screenshot', {})) as {
      lastMeta?: Record<string, unknown>;
      unchanged?: boolean;
    };
    expect(payload.unchanged).toBe(true);
    expect(payload.lastMeta).toMatchObject({ height: 96, width: 48 });
  });

  it('host__tap_fiber chains fiber_tree__query into an adb tap at the match center', async () => {
    const payload = await callToolJson('host__tap_fiber', {
      steps: [{ testID: 'loginButton' }],
    });
    expect(payload).toMatchObject({
      bounds: FIBER_BOUNDS,
      mcpId: 'fib-1',
      name: 'Pressable',
      tapped: true,
      testID: 'loginButton',
    });
    expect(payload.device).toMatchObject({ nativeId: ANDROID_SERIAL, platform: 'android' });
    // The query travels over the WS bridge; only the tap reaches the runner.
    expect(runnerCalls).toEqual([
      { args: ['devices'], command: 'adb' },
      {
        args: [
          '-s',
          ANDROID_SERIAL,
          'shell',
          'input',
          'tap',
          String(FIBER_BOUNDS.centerX),
          String(FIBER_BOUNDS.centerY),
        ],
        command: 'adb',
      },
    ]);
  });

  it('host__tap_fiber returns candidates on an ambiguous match', async () => {
    const payload = (await callToolJson('host__tap_fiber', { steps: [{ testID: 'row' }] })) as {
      candidates?: Array<Record<string, unknown>>;
      error?: string;
      total?: number;
    };
    expect(payload.error).toContain('2 matches');
    expect(payload.total).toBe(2);
    expect(payload.candidates).toHaveLength(2);
    expect(payload.candidates![0]).toMatchObject({ bounds: FIBER_BOUNDS, mcpId: 'fib-1' });
    expect(payload.candidates![1]).toMatchObject({ bounds: FIBER_BOUNDS_SECOND, mcpId: 'fib-2' });
    expect(runnerCalls).toHaveLength(0);
  });

  it('host__tap_fiber with index taps the selected candidate', async () => {
    const payload = await callToolJson('host__tap_fiber', {
      index: 1,
      steps: [{ testID: 'row' }],
    });
    expect(payload).toMatchObject({ mcpId: 'fib-2', tapped: true });
    const tapCall = runnerCalls.find((call) => {
      return call.args.includes('tap');
    });
    expect(tapCall!.args).toEqual([
      '-s',
      ANDROID_SERIAL,
      'shell',
      'input',
      'tap',
      String(FIBER_BOUNDS_SECOND.centerX),
      String(FIBER_BOUNDS_SECOND.centerY),
    ]);
  });

  it('host__tap_fiber reports no match with the query total', async () => {
    const payload = await callToolJson('host__tap_fiber', { steps: [{ testID: 'ghost' }] });
    expect(payload).toEqual({ error: 'no match for given steps', total: 0 });
    expect(runnerCalls).toHaveLength(0);
  });
});
