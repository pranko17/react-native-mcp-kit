/* eslint-disable import/extensions -- deep SDK imports (.js) trip the alias
   resolver; same exemption src/server/mcpServer.ts gets via .eslintrc. */
// Integration coverage for the Android branch of the host input tools: swipe,
// drag, long_press, press_key, type_text and type_text_batch. A real Bridge on
// an ephemeral port, the real McpServerWrapper over an in-memory MCP
// transport, and a ProcessRunner stub recording every adb invocation — no real
// adb processes are ever spawned. Every call passes platform:'android' so
// device resolution lands on the bare adb scan without needing a WS client.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Bridge } from '@/server/bridge';
import { hostModule } from '@/server/host';
import { clearDeviceCache } from '@/server/host/deviceResolver';
import {
  ProcessNotFoundError,
  type ProcessResult,
  type ProcessRunner,
} from '@/server/host/processRunner';
import { McpServerWrapper } from '@/server/mcpServer';

vi.setConfig({ testTimeout: 15_000 });

const SERIAL = 'emulator-5554';
const ADB_DEVICES_STDOUT = `List of devices attached\n${SERIAL}\tdevice\n\n`;

interface RecordedCall {
  args: string[];
  at: number;
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

const shellInput = (...rest: string[]): RecordedCall => {
  return {
    args: ['-s', SERIAL, 'shell', 'input', ...rest],
    at: expect.any(Number),
    command: 'adb',
  };
};

const CLEAR_FIELD_CALLS = [
  shellInput('keycombination', '113', '29'),
  shellInput('keyevent', 'KEYCODE_DEL'),
];

const DEVICES_CALL: RecordedCall = { args: ['devices'], at: expect.any(Number), command: 'adb' };

describe('host input tools Android (integration)', () => {
  let bridge: Bridge;
  let wrapper: McpServerWrapper;
  let mcpClient: Client;
  let adbMissing = false;
  const runnerCalls: RecordedCall[] = [];

  // ProcessRunner stub: records every (command, args) invocation with a
  // timestamp and serves canned adb output — no real processes are spawned.
  const runner: ProcessRunner = (command, args) => {
    runnerCalls.push({ args: [...args], at: Date.now(), command });
    if (adbMissing && command === 'adb') {
      return Promise.reject(new ProcessNotFoundError('adb'));
    }
    if (command === 'adb' && args[0] === 'devices') {
      return Promise.resolve(processResult(ADB_DEVICES_STDOUT));
    }
    return Promise.resolve(processResult(''));
  };

  const callTool = async (
    name: string,
    args: Record<string, unknown>
  ): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> => {
    const res = await mcpClient.callTool({ arguments: args, name });
    return res as { content: Array<{ type: string; text?: string }>; isError?: boolean };
  };

  const callToolJson = async (
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
    const { content } = await callTool(name, args);
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
    expect(bridge.boundPort()).toBeGreaterThan(0);

    wrapper = new McpServerWrapper(bridge, [hostModule(runner)]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await wrapper.connectTransport(serverTransport);

    mcpClient = new Client({ name: 'vitest-harness', version: '1.0.0' });
    await mcpClient.connect(clientTransport);
  });

  afterAll(async () => {
    await mcpClient.close();
    await bridge.stop();
  });

  beforeEach(() => {
    // The device list is cached module-scope for 5s — reset between tests so
    // every scenario sees its own `adb devices` call recorded.
    clearDeviceCache();
    runnerCalls.length = 0;
  });

  it('host__swipe emits adb input swipe with the default duration', async () => {
    const payload = await callToolJson('host__swipe', {
      platform: 'android',
      x1: 100,
      x2: 300,
      y1: 200,
      y2: 400,
    });
    expect(payload).toMatchObject({
      durationMs: 300,
      from: { x: 100, y: 200 },
      swiped: true,
      to: { x: 300, y: 400 },
    });
    expect(payload.device).toMatchObject({ nativeId: SERIAL, platform: 'android' });
    expect(runnerCalls).toEqual([
      DEVICES_CALL,
      shellInput('swipe', '100', '200', '300', '400', '300'),
    ]);
  });

  it('host__swipe passes an explicit durationMs through to adb', async () => {
    const payload = await callToolJson('host__swipe', {
      durationMs: 1000,
      platform: 'android',
      x1: 10,
      x2: 20,
      y1: 30,
      y2: 40,
    });
    expect(payload).toMatchObject({ durationMs: 1000, swiped: true });
    expect(runnerCalls[1]).toEqual(shellInput('swipe', '10', '30', '20', '40', '1000'));
  });

  it('host__drag defaults fold holdMs + moveMs into one slow adb swipe', async () => {
    const payload = await callToolJson('host__drag', {
      platform: 'android',
      x1: 50,
      x2: 50,
      y1: 600,
      y2: 100,
    });
    expect(payload).toMatchObject({
      dragged: true,
      from: { x: 50, y: 600 },
      holdMs: 500,
      moveMs: 400,
      to: { x: 50, y: 100 },
      totalMs: 900,
    });
    expect(runnerCalls).toEqual([
      DEVICES_CALL,
      shellInput('swipe', '50', '600', '50', '100', '900'),
    ]);
  });

  it('host__drag caps holdMs + durationMs at the swipe duration ceiling', async () => {
    const payload = await callToolJson('host__drag', {
      durationMs: 400,
      holdMs: 4800,
      platform: 'android',
      x1: 1,
      x2: 2,
      y1: 3,
      y2: 4,
    });
    // 4800 + 400 exceeds SWIPE_DURATION_MAX_MS — the total is clamped to 5000.
    expect(payload).toMatchObject({ dragged: true, holdMs: 4800, moveMs: 400, totalMs: 5000 });
    expect(runnerCalls[1]).toEqual(shellInput('swipe', '1', '3', '2', '4', '5000'));
  });

  it('host__long_press maps to a zero-distance swipe held for the default duration', async () => {
    const payload = await callToolJson('host__long_press', {
      platform: 'android',
      x: 150,
      y: 300,
    });
    expect(payload).toMatchObject({ durationMs: 700, longPressed: true, x: 150, y: 300 });
    expect(runnerCalls).toEqual([
      DEVICES_CALL,
      shellInput('swipe', '150', '300', '150', '300', '700'),
    ]);
  });

  it('host__long_press passes an explicit durationMs into the swipe command', async () => {
    const payload = await callToolJson('host__long_press', {
      durationMs: 1200,
      platform: 'android',
      x: 10,
      y: 20,
    });
    expect(payload).toMatchObject({ durationMs: 1200, longPressed: true });
    expect(runnerCalls[1]).toEqual(shellInput('swipe', '10', '20', '10', '20', '1200'));
  });

  it('host__press_key maps the semantic name to the Android keycode', async () => {
    const payload = await callToolJson('host__press_key', { key: 'back', platform: 'android' });
    expect(payload).toMatchObject({ key: 'back', pressed: true });
    expect(runnerCalls).toEqual([DEVICES_CALL, shellInput('keyevent', 'KEYCODE_BACK')]);
  });

  it('host__press_key rejects a value outside the key enum at schema validation', async () => {
    const res = await callTool('host__press_key', { key: 'jump', platform: 'android' });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('key');
    expect(runnerCalls).toHaveLength(0);
  });

  it('host__type_text clears the field then types with adb shell escaping applied', async () => {
    const payload = await callToolJson('host__type_text', {
      platform: 'android',
      text: 'a b\tc"d\'e$f!g\\h',
    });
    expect(payload).toMatchObject({ length: 15, submitted: false, typed: true });
    // Whitespace becomes %s; quotes, $, ! and backslash get backslash-escaped
    // so `adb shell input text` receives them literally.
    expect(runnerCalls).toEqual([
      DEVICES_CALL,
      ...CLEAR_FIELD_CALLS,
      shellInput('text', 'a%sb%sc\\"d\\\'e\\$f\\!g\\\\h'),
    ]);
  });

  it('host__type_text submit:true presses KEYCODE_ENTER after typing', async () => {
    const payload = await callToolJson('host__type_text', {
      platform: 'android',
      submit: true,
      text: 'query',
    });
    expect(payload).toMatchObject({ submitted: true, typed: true });
    expect(runnerCalls).toEqual([
      DEVICES_CALL,
      ...CLEAR_FIELD_CALLS,
      shellInput('text', 'query'),
      shellInput('keyevent', 'KEYCODE_ENTER'),
    ]);
  });

  it('host__type_text refuses non-ASCII up front without touching the device input', async () => {
    const payload = await callToolJson('host__type_text', {
      platform: 'android',
      text: 'привет',
    });
    expect(String(payload.error)).toContain('ASCII');
    const inputCalls = runnerCalls.filter((call) => {
      return call.args.includes('input');
    });
    expect(inputCalls).toHaveLength(0);
  });

  it('host__type_text_batch runs tap → clear → type per field and submits where asked', async () => {
    const payload = await callToolJson('host__type_text_batch', {
      fields: [
        { text: 'alice', x: 100, y: 200 },
        { submit: true, text: 'secret', x: 100, y: 320 },
      ],
      focusDelayMs: 0,
      platform: 'android',
    });
    expect(payload).toMatchObject({
      fields: [
        { submitted: false, x: 100, y: 200 },
        { submitted: true, x: 100, y: 320 },
      ],
      filled: 2,
    });
    expect(runnerCalls).toEqual([
      DEVICES_CALL,
      shellInput('tap', '100', '200'),
      ...CLEAR_FIELD_CALLS,
      shellInput('text', 'alice'),
      shellInput('tap', '100', '320'),
      ...CLEAR_FIELD_CALLS,
      shellInput('text', 'secret'),
      shellInput('keyevent', 'KEYCODE_ENTER'),
    ]);
  });

  it('host__type_text_batch waits focusDelayMs between the tap and the typing', async () => {
    await callToolJson('host__type_text_batch', {
      fields: [{ text: 'x', x: 10, y: 20 }],
      focusDelayMs: 150,
      platform: 'android',
    });
    const tapCall = runnerCalls.find((call) => {
      return call.args.includes('tap');
    });
    const clearCall = runnerCalls.find((call) => {
      return call.args.includes('keycombination');
    });
    // Only a lower bound — upper-bound timing assertions flake under load.
    expect(clearCall!.at - tapCall!.at).toBeGreaterThanOrEqual(140);
  });

  it('host__type_text_batch stops at the first failing field with filled/failedAt', async () => {
    const payload = await callToolJson('host__type_text_batch', {
      fields: [
        { text: 'ok', x: 1, y: 2 },
        { text: 'кириллица', x: 3, y: 4 },
      ],
      focusDelayMs: 0,
      platform: 'android',
    });
    expect(payload).toMatchObject({ failedAt: 1, filled: 1 });
    expect(String(payload.error)).toContain('ASCII');
  });

  it('maps ProcessNotFoundError from the runner to a missing-adb message', async () => {
    adbMissing = true;
    try {
      const payload = await callToolJson('host__tap', { platform: 'android', x: 1, y: 1 });
      expect(String(payload.error)).toContain('adb not found');
      expect(String(payload.error)).toContain('platform-tools');
    } finally {
      adbMissing = false;
    }
  });
});
