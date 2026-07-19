/* eslint-disable import/extensions -- deep SDK imports (.js) trip the alias
   resolver; same exemption src/server/mcpServer.ts gets via .eslintrc. */
// Integration coverage for host__screenshot region cropping: a real Bridge on
// an ephemeral port, the real McpServerWrapper over an in-memory MCP
// transport, and a ProcessRunner stub serving a real 100×200 PNG from the adb
// screencap stub. sharp is real — the crop → resize → webp pipeline runs end
// to end, and the returned WebP is decoded back to assert dimensions. The
// source PNG is a noise pattern so different crops always produce different
// bytes (the diff-cache never short-circuits across tests).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Bridge } from '@/server/bridge';
import { hostModule } from '@/server/host';
import { clearDeviceCache } from '@/server/host/deviceResolver';
import { type ProcessResult, type ProcessRunner } from '@/server/host/processRunner';
import { McpServerWrapper } from '@/server/mcpServer';

vi.setConfig({ testTimeout: 15_000 });

const SERIAL = 'emulator-5554';
const ADB_DEVICES_STDOUT = `List of devices attached\n${SERIAL}\tdevice\n\n`;
const SOURCE_WIDTH = 100;
const SOURCE_HEIGHT = 200;

const processResult = (stdout: Buffer | string): ProcessResult => {
  return {
    exitCode: 0,
    signal: null,
    stderr: Buffer.alloc(0),
    stdout: typeof stdout === 'string' ? Buffer.from(stdout, 'utf8') : stdout,
    timedOut: false,
  };
};

describe('host__screenshot region crop (integration)', () => {
  let bridge: Bridge;
  let wrapper: McpServerWrapper;
  let mcpClient: Client;
  let screencapPng: Buffer;

  // ProcessRunner stub: serves the device list and the PNG fixture — no real
  // adb processes are ever spawned.
  const runner: ProcessRunner = (command, args) => {
    if (command === 'adb' && args[0] === 'devices') {
      return Promise.resolve(processResult(ADB_DEVICES_STDOUT));
    }
    if (command === 'adb' && args.includes('screencap')) {
      return Promise.resolve(processResult(screencapPng));
    }
    return Promise.resolve(processResult(''));
  };

  const takeScreenshot = async (
    args: Record<string, unknown>
  ): Promise<{
    image: Buffer;
    meta: Record<string, unknown>;
  }> => {
    const res = await mcpClient.callTool({
      arguments: { platform: 'android', ...args },
      name: 'host__screenshot',
    });
    const content = res.content as Array<{ type: string; data?: string; text?: string }>;
    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({ mimeType: 'image/webp', type: 'image' });
    return {
      image: Buffer.from(content[0]!.data!, 'base64'),
      meta: JSON.parse(content[1]!.text!) as Record<string, unknown>,
    };
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

    // 100×200 deterministic noise PNG — every crop rectangle yields distinct
    // pixel data, keeping the per-device screenshot diff-cache out of the way.
    const raw = Buffer.alloc(SOURCE_WIDTH * SOURCE_HEIGHT * 3);
    for (let i = 0; i < raw.length; i++) {
      raw[i] = (i * 31) % 251;
    }
    screencapPng = await sharp(raw, {
      raw: { channels: 3, height: SOURCE_HEIGHT, width: SOURCE_WIDTH },
    })
      .png()
      .toBuffer();
  });

  afterAll(async () => {
    await mcpClient.close();
    await bridge.stop();
  });

  beforeEach(() => {
    // The device list is cached module-scope for 5s — reset between tests.
    clearDeviceCache();
  });

  it('crops the region from ORIGINAL device pixels before any resize', async () => {
    const { image, meta } = await takeScreenshot({
      region: { height: 60, width: 50, x: 10, y: 20 },
    });
    // The 50×60 crop is below the default 280px target width and
    // withoutEnlargement never upscales — output equals the crop exactly.
    expect(meta).toMatchObject({
      height: 60,
      originalHeight: SOURCE_HEIGHT,
      originalWidth: SOURCE_WIDTH,
      region: { height: 60, width: 50, x: 10, y: 20 },
      scale: 1,
      width: 50,
    });
    const decoded = await sharp(image).metadata();
    expect(decoded.format).toBe('webp');
    expect(decoded.width).toBe(50);
    expect(decoded.height).toBe(60);
  });

  it('resizes AFTER cropping when the width parameter is below the region size', async () => {
    const { image, meta } = await takeScreenshot({
      region: { height: 160, width: 80, x: 10, y: 20 },
      width: 64,
    });
    // Crop-before-resize: the 80×160 region shrinks to 64×128 and scale is
    // image/region (64/80), not image/full-screen. Were the resize applied
    // first, an 80px-wide region could not exist inside a 64px-wide image.
    expect(meta).toMatchObject({
      height: 128,
      originalHeight: SOURCE_HEIGHT,
      originalWidth: SOURCE_WIDTH,
      region: { height: 160, width: 80, x: 10, y: 20 },
      scale: 0.8,
      width: 64,
    });
    const decoded = await sharp(image).metadata();
    expect(decoded.width).toBe(64);
    expect(decoded.height).toBe(128);
  });

  it('clips an out-of-bounds region to the image bounds without erroring', async () => {
    const { image, meta } = await takeScreenshot({
      region: { height: 500, width: 500, x: 60, y: 150 },
    });
    // 500×500 at (60, 150) overflows the 100×200 source — clipped to what
    // actually fits so edge-hugging fiber bounds need no guarding.
    expect(meta).toMatchObject({
      height: 50,
      region: { height: 50, width: 40, x: 60, y: 150 },
      scale: 1,
      width: 40,
    });
    const decoded = await sharp(image).metadata();
    expect(decoded.width).toBe(40);
    expect(decoded.height).toBe(50);
  });
});
