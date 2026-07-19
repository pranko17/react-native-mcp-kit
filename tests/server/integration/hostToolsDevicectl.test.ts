/* eslint-disable import/extensions -- deep SDK imports (.js) trip the alias
   resolver; same exemption src/server/mcpServer.ts gets via .eslintrc. */
// Integration coverage for the devicectl branch of device resolution: an RN
// client registering isSimulator:false routes through `xcrun devicectl list
// devices --json-output <tmp>`. The ProcessRunner stub plays devicectl's part
// by writing the fixture JSON to the real tmp path it was given (devicectl
// prints a human-readable header to stdout, so src reads the file) — no fs
// mocks, no real xcrun. The CoreDevice tunnel behind real-device screenshots
// (RemoteXPC + DTX) is NOT under test: `captureScreenshot` is module-mocked
// and the tests stop at that boundary — routing into it and surfacing its
// failure.
import { writeFileSync } from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { Bridge, type BridgeEvents } from '@/server/bridge';
import { hostModule } from '@/server/host';
import { clearDeviceCache } from '@/server/host/deviceResolver';
import { type ProcessResult, type ProcessRunner } from '@/server/host/processRunner';
import { McpServerWrapper } from '@/server/mcpServer';
import { PROTOCOL_VERSION, type ServerMessage, type ToolResponse } from '@/shared/protocol';

const { captureScreenshotMock } = vi.hoisted(() => {
  return {
    captureScreenshotMock:
      vi.fn<(coreDeviceIdentifier: string, options?: { timeoutMs?: number }) => Promise<Buffer>>(),
  };
});

// The tunnel client is the boundary — mock the module's full export surface
// (captureScreenshot is its only export) so no mDNS / RemoteXPC ever runs.
vi.mock('@/server/host/coredevice/screenshot', () => {
  return { captureScreenshot: captureScreenshotMock };
});

vi.setConfig({ testTimeout: 15_000 });

const CORE_DEVICE_ID = 'CORE-DEVICE-0000-4000-8000-000000000001';
const DEVICE_NAME = 'Aleksei iPhone';
const REAL_BUNDLE_ID = 'com.probe.realdevice';

const EMPTY_SIMCTL_STDOUT = JSON.stringify({ devices: {} });
const ADB_NO_DEVICES_STDOUT = 'List of devices attached\n\n';

// Exact shape `listIosRealDevices` parses out of the devicectl JSON file:
// result.devices[] with hardwareProperties.platform === 'iOS' filtering, plus
// identifier / deviceProperties.name / connectionProperties.pairingState.
const devicectlJson = (pairingState: string): string => {
  return JSON.stringify({
    result: {
      devices: [
        {
          connectionProperties: { pairingState },
          deviceProperties: { name: DEVICE_NAME },
          hardwareProperties: { platform: 'iOS' },
          identifier: CORE_DEVICE_ID,
        },
        {
          // Non-iOS entry — must be filtered out by the platform check.
          connectionProperties: { pairingState: 'paired' },
          deviceProperties: { name: 'Living Room' },
          hardwareProperties: { platform: 'tvOS' },
          identifier: 'CORE-DEVICE-TVOS-000000000002',
        },
      ],
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

describe('host tools real iOS device via devicectl (integration)', () => {
  let bridge: Bridge;
  let wrapper: McpServerWrapper;
  let mcpClient: Client;
  let port: number;
  let devicectlStdout = devicectlJson('paired');
  const runnerCalls: RecordedCall[] = [];
  const openSockets: WebSocket[] = [];

  // ProcessRunner stub: on a devicectl invocation it plays the binary's part —
  // writes the fixture JSON to the (real, tmpdir) path passed after
  // --json-output, then reports success. simctl / adb serve empty fixtures.
  const runner: ProcessRunner = (command, args) => {
    runnerCalls.push({ args: [...args], command });
    if (command === 'xcrun' && args[0] === 'devicectl') {
      const jsonFlag = args.indexOf('--json-output');
      if (jsonFlag !== -1) {
        writeFileSync(args[jsonFlag + 1]!, devicectlStdout, 'utf8');
      }
      return Promise.resolve(processResult(''));
    }
    if (command === 'xcrun' && args[0] === 'simctl' && args[1] === 'list') {
      return Promise.resolve(processResult(EMPTY_SIMCTL_STDOUT));
    }
    if (command === 'adb' && args[0] === 'devices') {
      return Promise.resolve(processResult(ADB_NO_DEVICES_STDOUT));
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

  // Fake RN client on a REAL device: registers isSimulator:false so the
  // resolver takes the devicectl path instead of simctl.
  const connectRealIosClient = async (): Promise<WebSocket> => {
    const added = waitEvent('clientAdded');
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('error', () => {});
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMessage;
      if (msg.type === 'server_hello') {
        ws.send(
          JSON.stringify({
            appName: 'RealDeviceProbe',
            bundleId: REAL_BUNDLE_ID,
            deviceId: 'REAL-DEV-1',
            isSimulator: false,
            label: DEVICE_NAME,
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

    await connectRealIosClient();
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
    captureScreenshotMock.mockReset();
  });

  it('host__list_devices covers only simulators — real devices are out of scope today', async () => {
    // Boundary pin: enrichDevicesWithClientStatus enumerates simctl + adb
    // only; devicectl-paired real devices never appear in the listing, even
    // with a real-device client connected. Update this test when list_devices
    // learns about devicectl.
    const payload = (await callToolJson('host__list_devices', {})) as {
      android: unknown[];
      ios: unknown[];
    };
    expect(payload.ios).toEqual([]);
    expect(payload.android).toEqual([]);
    const devicectlCalls = runnerCalls.filter((call) => {
      return call.args[0] === 'devicectl';
    });
    expect(devicectlCalls).toHaveLength(0);
  });

  it('resolves the isSimulator:false client through devicectl and routes host__screenshot into the CoreDevice capture', async () => {
    const pngFromDevice = await sharp({
      create: { background: { b: 20, g: 120, r: 60 }, channels: 3, height: 160, width: 90 },
    })
      .png()
      .toBuffer();
    captureScreenshotMock.mockResolvedValueOnce(pngFromDevice);

    const content = await callTool('host__screenshot', { clientId: 'ios-1' });

    // Resolution went through devicectl (fixture written by the stub into the
    // tmp path from --json-output) — never through simctl.
    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0]!.command).toBe('xcrun');
    expect(runnerCalls[0]!.args.slice(0, 3)).toEqual(['devicectl', 'list', 'devices']);
    expect(runnerCalls[0]!.args[3]).toBe('--json-output');

    // The resolved nativeId is the CoreDevice identifier from the fixture —
    // the tvOS entry was filtered out, the label matched the iPhone.
    expect(captureScreenshotMock).toHaveBeenCalledTimes(1);
    expect(captureScreenshotMock).toHaveBeenCalledWith(CORE_DEVICE_ID, { timeoutMs: 15_000 });

    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({ mimeType: 'image/webp', type: 'image' });
    const meta = JSON.parse(content[1]!.text!) as Record<string, unknown>;
    expect(meta).toMatchObject({
      height: 160,
      originalHeight: 160,
      originalWidth: 90,
      scale: 1,
      width: 90,
    });
  });

  it('surfaces a tunnel failure as the real-device screenshot error (boundary — the tunnel itself is not tested)', async () => {
    captureScreenshotMock.mockRejectedValueOnce(new Error('tunnel unavailable'));
    const payload = await callToolJson('host__screenshot', { clientId: 'ios-1' });
    expect(String(payload.error)).toBe(
      'Failed to capture real-device screenshot: tunnel unavailable'
    );
  });

  it('reports no paired device when devicectl lists the device as unpaired', async () => {
    devicectlStdout = devicectlJson('unpaired');
    try {
      const payload = await callToolJson('host__screenshot', { clientId: 'ios-1' });
      expect(String(payload.error)).toContain("Cannot resolve iOS client 'ios-1'");
      expect(String(payload.error)).toContain('Paired devices: (none)');
      expect(captureScreenshotMock).not.toHaveBeenCalled();
    } finally {
      devicectlStdout = devicectlJson('paired');
    }
  });

  it('launches on a real device through devicectl process launch', async () => {
    const payload = (await callToolJson('host__launch_app', { clientId: 'ios-1' })) as {
      launched?: boolean;
    };
    expect(payload.launched).toBe(true);
    const launch = runnerCalls.find((call) => {
      return call.args.includes('launch');
    });
    expect(launch?.command).toBe('xcrun');
    expect(launch?.args).toEqual([
      'devicectl',
      'device',
      'process',
      'launch',
      '--device',
      CORE_DEVICE_ID,
      REAL_BUNDLE_ID,
    ]);
  });

  it('refuses bare terminate on a real device with an actionable error', async () => {
    const payload = (await callToolJson('host__terminate_app', { clientId: 'ios-1' })) as {
      error?: string;
    };
    expect(payload.error).toContain('devicectl can only terminate by PID');
    expect(payload.error).toContain('host__restart_app');
    const simctlTerminate = runnerCalls.find((call) => {
      return call.args.includes('terminate');
    });
    expect(simctlTerminate).toBeUndefined();
  });

  it('restarts on a real device with a single --terminate-existing launch', async () => {
    const payload = (await callToolJson('host__restart_app', { clientId: 'ios-1' })) as {
      restarted?: boolean;
    };
    expect(payload.restarted).toBe(true);
    const launches = runnerCalls.filter((call) => {
      return call.args.includes('launch');
    });
    expect(launches).toHaveLength(1);
    expect(launches[0]!.args).toEqual([
      'devicectl',
      'device',
      'process',
      'launch',
      '--device',
      CORE_DEVICE_ID,
      '--terminate-existing',
      REAL_BUNDLE_ID,
    ]);
    const simctl = runnerCalls.find((call) => {
      return call.args[0] === 'simctl' && call.args[1] === 'terminate';
    });
    expect(simctl).toBeUndefined();
  });
});
