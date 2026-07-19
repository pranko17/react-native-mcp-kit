/* eslint-disable import/extensions -- deep SDK imports (.js) trip the alias
   resolver; same exemption src/server/mcpServer.ts gets via .eslintrc. */
// Integration coverage for the iOS branch of the host input tools: swipe,
// drag, long_press, press_key, type_text and type_text_batch. A real Bridge on
// an ephemeral port, the real McpServerWrapper over an in-memory MCP
// transport, and a ProcessRunner stub recording every invocation — the
// bundled ios-hid binary is never actually executed, only its (command, args)
// are asserted. Every call passes platform:'ios' so device resolution lands on
// the bare simctl scan (single booted sim fixture) without a WS client.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Bridge } from '@/server/bridge';
import { hostModule } from '@/server/host';
import { clearDeviceCache } from '@/server/host/deviceResolver';
import { type ProcessResult, type ProcessRunner } from '@/server/host/processRunner';
import { McpServerWrapper } from '@/server/mcpServer';

vi.setConfig({ testTimeout: 15_000 });

const UDID = 'AAAAAAAA-0000-4000-8000-000000000001';

const SIMCTL_STDOUT = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
      { name: 'iPhone 17 Pro', state: 'Booted', udid: UDID },
    ],
  },
});

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

describe('host input tools iOS (integration)', () => {
  let bridge: Bridge;
  let wrapper: McpServerWrapper;
  let mcpClient: Client;
  const runnerCalls: RecordedCall[] = [];

  // ProcessRunner stub: `xcrun simctl list` serves the fixture; the ios-hid
  // binary (an absolute path, not a bare command) just succeeds — it is never
  // actually executed.
  const runner: ProcessRunner = (command, args) => {
    runnerCalls.push({ args: [...args], command });
    if (command === 'xcrun' && args[0] === 'simctl' && args[1] === 'list') {
      return Promise.resolve(processResult(SIMCTL_STDOUT));
    }
    return Promise.resolve(processResult(''));
  };

  // The ios-hid call is always the second recorded invocation (after the
  // simctl device listing) — assert its binary path and exact args.
  const expectIosHidCall = (expectedArgs: string[]): void => {
    expect(runnerCalls).toHaveLength(2);
    expect(runnerCalls[0]).toEqual({
      args: ['simctl', 'list', 'devices', '--json'],
      command: 'xcrun',
    });
    expect(runnerCalls[1]!.command).toMatch(/bin[/\\]ios-hid$/);
    expect(runnerCalls[1]!.args).toEqual(expectedArgs);
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
    // every scenario re-reads the fixture.
    clearDeviceCache();
    runnerCalls.length = 0;
  });

  it('host__swipe converts durationMs to seconds for ios-hid', async () => {
    const payload = await callToolJson('host__swipe', {
      durationMs: 1000,
      platform: 'ios',
      x1: 100,
      x2: 320,
      y1: 200,
      y2: 640,
    });
    expect(payload).toMatchObject({
      durationMs: 1000,
      from: { x: 100, y: 200 },
      swiped: true,
      to: { x: 320, y: 640 },
    });
    expect(payload.device).toMatchObject({ nativeId: UDID, platform: 'ios' });
    expectIosHidCall(['swipe', UDID, '100', '200', '320', '640', '1']);
  });

  it('host__swipe applies the default duration (300ms → 0.3s)', async () => {
    const payload = await callToolJson('host__swipe', {
      platform: 'ios',
      x1: 10,
      x2: 20,
      y1: 30,
      y2: 40,
    });
    expect(payload).toMatchObject({ durationMs: 300, swiped: true });
    expectIosHidCall(['swipe', UDID, '10', '30', '20', '40', '0.3']);
  });

  it('host__drag defaults emit one slow swipe of holdMs + moveMs seconds', async () => {
    const payload = await callToolJson('host__drag', {
      platform: 'ios',
      x1: 50,
      x2: 50,
      y1: 600,
      y2: 100,
    });
    expect(payload).toMatchObject({
      dragged: true,
      holdMs: 500,
      moveMs: 400,
      totalMs: 900,
    });
    expectIosHidCall(['swipe', UDID, '50', '600', '50', '100', '0.9']);
  });

  it('host__drag holdMs:0 skips the hold and keeps only the move time', async () => {
    const payload = await callToolJson('host__drag', {
      durationMs: 100,
      holdMs: 0,
      platform: 'ios',
      x1: 1,
      x2: 2,
      y1: 3,
      y2: 4,
    });
    expect(payload).toMatchObject({ dragged: true, holdMs: 0, moveMs: 100, totalMs: 100 });
    expectIosHidCall(['swipe', UDID, '1', '3', '2', '4', '0.1']);
  });

  it('host__long_press holds a zero-distance swipe for the default duration', async () => {
    const payload = await callToolJson('host__long_press', { platform: 'ios', x: 150, y: 300 });
    expect(payload).toMatchObject({ durationMs: 700, longPressed: true, x: 150, y: 300 });
    expectIosHidCall(['swipe', UDID, '150', '300', '150', '300', '0.7']);
  });

  it('host__long_press passes an explicit durationMs (1500ms → 1.5s)', async () => {
    const payload = await callToolJson('host__long_press', {
      durationMs: 1500,
      platform: 'ios',
      x: 10,
      y: 20,
    });
    expect(payload).toMatchObject({ durationMs: 1500, longPressed: true });
    expectIosHidCall(['swipe', UDID, '10', '20', '10', '20', '1.5']);
  });

  it('host__press_key enter goes through the ios-hid text path', async () => {
    const payload = await callToolJson('host__press_key', { key: 'enter', platform: 'ios' });
    expect(payload).toMatchObject({ key: 'enter', pressed: true });
    expectIosHidCall(['type', UDID, '\n']);
  });

  it('host__press_key home goes through the ios-hid button path', async () => {
    const payload = await callToolJson('host__press_key', { key: 'home', platform: 'ios' });
    expect(payload).toMatchObject({ key: 'home', pressed: true });
    expectIosHidCall(['button', UDID, 'home']);
  });

  it('host__press_key backspace types the DEL control character', async () => {
    const payload = await callToolJson('host__press_key', { key: 'backspace', platform: 'ios' });
    expect(payload).toMatchObject({ key: 'backspace', pressed: true });
    expectIosHidCall(['type', UDID, '\u007F']);
  });

  it('host__press_key back is in the enum but unsupported on iOS Simulator', async () => {
    const payload = await callToolJson('host__press_key', { key: 'back', platform: 'ios' });
    expect(String(payload.error)).toContain("Key 'back' is not available on iOS Simulator");
    // Resolution ran, but no ios-hid call may follow a rejected key.
    for (const call of runnerCalls) {
      expect(call.command).toBe('xcrun');
    }
  });

  it('host__press_key rejects a value outside the key enum at schema validation', async () => {
    const res = await callTool('host__press_key', { key: 'jump', platform: 'ios' });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('key');
    expect(runnerCalls).toHaveLength(0);
  });

  it('host__type_text passes unicode through verbatim (clipboard paste backend)', async () => {
    const payload = await callToolJson('host__type_text', {
      platform: 'ios',
      text: 'héllo wörld — 21век',
    });
    expect(payload).toMatchObject({ length: 19, submitted: false, typed: true });
    expectIosHidCall(['type', UDID, 'héllo wörld — 21век']);
  });

  it('host__type_text submit:true appends a newline to the typed text', async () => {
    const payload = await callToolJson('host__type_text', {
      platform: 'ios',
      submit: true,
      text: 'query',
    });
    expect(payload).toMatchObject({ submitted: true, typed: true });
    expectIosHidCall(['type', UDID, 'query\n']);
  });

  it('host__type_text_batch taps then types per field via ios-hid', async () => {
    const payload = await callToolJson('host__type_text_batch', {
      fields: [
        { text: 'alice', x: 100, y: 200 },
        { submit: true, text: 'secret', x: 100, y: 320 },
      ],
      focusDelayMs: 0,
      platform: 'ios',
    });
    expect(payload).toMatchObject({
      fields: [
        { submitted: false, x: 100, y: 200 },
        { submitted: true, x: 100, y: 320 },
      ],
      filled: 2,
    });
    expect(runnerCalls).toHaveLength(5);
    expect(runnerCalls[0]).toEqual({
      args: ['simctl', 'list', 'devices', '--json'],
      command: 'xcrun',
    });
    const hidCalls = runnerCalls.slice(1).map((call) => {
      expect(call.command).toMatch(/bin[/\\]ios-hid$/);
      return call.args;
    });
    expect(hidCalls).toEqual([
      ['tap', UDID, '100', '200'],
      ['type', UDID, 'alice'],
      ['tap', UDID, '100', '320'],
      ['type', UDID, 'secret\n'],
    ]);
  });
});
