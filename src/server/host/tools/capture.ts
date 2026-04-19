import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';

import { resolveDevice } from '@/server/host/deviceResolver';
import { NATIVE_ID_SCHEMA, PLATFORM_ARG_SCHEMA, parseResolveOptions } from '@/server/host/helpers';
import { ProcessNotFoundError, type ProcessRunner } from '@/server/host/processRunner';
import { type HostToolHandler } from '@/server/host/types';

const SCREENSHOT_TIMEOUT_MS = 15_000;
const SCREENSHOT_DEFAULT_WIDTH = 370;
const SCREENSHOT_MIN_WIDTH = 64;
const SCREENSHOT_MAX_WIDTH = 1568;
const WEBP_QUALITY = 80;

const clampWidth = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return SCREENSHOT_DEFAULT_WIDTH;
  }
  return Math.max(SCREENSHOT_MIN_WIDTH, Math.min(SCREENSHOT_MAX_WIDTH, Math.floor(value)));
};

interface ResizedScreenshot {
  buffer: Buffer;
  height: number;
  width: number;
  originalHeight?: number;
  originalWidth?: number;
}

const resizeScreenshot = async (input: Buffer, targetWidth: number): Promise<ResizedScreenshot> => {
  const pipeline = sharp(input);
  const meta = await pipeline.metadata();
  const { data, info } = await pipeline
    .resize({ width: targetWidth, withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return {
    buffer: data,
    height: info.height,
    originalHeight: meta.height,
    originalWidth: meta.width,
    width: info.width,
  };
};

const hashBuffer = (buf: Buffer): string => {
  return createHash('sha256').update(buf).digest('hex');
};

// Per-device cache for screenshot diff
const lastScreenshotHash = new Map<string, string>();

interface ScreenshotImage {
  data: string;
  mimeType: 'image/webp';
  type: 'image';
}

interface ScreenshotText {
  text: string;
  type: 'text';
}

type ScreenshotResponse = [ScreenshotImage, ScreenshotText];

interface ScreenshotError {
  error: string;
}

interface ScreenshotUnchanged {
  message: string;
  unchanged: true;
}

interface ScreenshotMeta {
  bytes: number;
  height: number;
  width: number;
  originalHeight?: number;
  originalWidth?: number;
  scale?: number;
}

const buildResponse = (resized: ResizedScreenshot): ScreenshotResponse => {
  const meta: ScreenshotMeta = {
    bytes: resized.buffer.length,
    height: resized.height,
    originalHeight: resized.originalHeight,
    originalWidth: resized.originalWidth,
    scale: resized.originalWidth
      ? Number((resized.width / resized.originalWidth).toFixed(3))
      : undefined,
    width: resized.width,
  };
  return [
    {
      data: resized.buffer.toString('base64'),
      mimeType: 'image/webp',
      type: 'image',
    },
    {
      text: JSON.stringify(meta),
      type: 'text',
    },
  ];
};

const captureIos = async (
  udid: string,
  runner: ProcessRunner,
  width: number
): Promise<ScreenshotResponse | ScreenshotUnchanged | ScreenshotError> => {
  const tmpPath = join(tmpdir(), `rnmcp-ios-${randomUUID()}.png`);
  try {
    const proc = await runner('xcrun', ['simctl', 'io', udid, 'screenshot', tmpPath], {
      timeoutMs: SCREENSHOT_TIMEOUT_MS,
    });
    if (proc.timedOut) {
      return { error: `iOS screenshot timed out after ${SCREENSHOT_TIMEOUT_MS}ms` };
    }
    if (proc.exitCode !== 0) {
      return {
        error: `xcrun simctl io screenshot failed (exit ${proc.exitCode}): ${proc.stderr.toString('utf8').trim().slice(0, 500)}`,
      };
    }
    const raw = await readFile(tmpPath);
    const resized = await resizeScreenshot(raw, width);
    const hash = hashBuffer(resized.buffer);
    if (lastScreenshotHash.get(udid) === hash) {
      return { message: 'Screenshot unchanged since last capture.', unchanged: true };
    }
    lastScreenshotHash.set(udid, hash);
    return buildResponse(resized);
  } catch (err) {
    if (err instanceof ProcessNotFoundError) {
      return {
        error: 'xcrun not found. iOS screenshots require Xcode command line tools.',
      };
    }
    return { error: `Failed to capture iOS screenshot: ${(err as Error).message}` };
  } finally {
    rm(tmpPath, { force: true }).catch(() => {
      // best-effort cleanup
    });
  }
};

const captureAndroid = async (
  serial: string,
  runner: ProcessRunner,
  width: number
): Promise<ScreenshotResponse | ScreenshotUnchanged | ScreenshotError> => {
  try {
    const proc = await runner('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], {
      timeoutMs: SCREENSHOT_TIMEOUT_MS,
    });
    if (proc.timedOut) {
      return { error: `Android screenshot timed out after ${SCREENSHOT_TIMEOUT_MS}ms` };
    }
    if (proc.exitCode !== 0) {
      return {
        error: `adb screencap failed (exit ${proc.exitCode}): ${proc.stderr.toString('utf8').trim().slice(0, 500)}`,
      };
    }
    if (proc.stdout.length === 0) {
      return { error: 'adb screencap returned empty output' };
    }
    const resized = await resizeScreenshot(proc.stdout, width);
    const hash = hashBuffer(resized.buffer);
    if (lastScreenshotHash.get(serial) === hash) {
      return { message: 'Screenshot unchanged since last capture.', unchanged: true };
    }
    lastScreenshotHash.set(serial, hash);
    return buildResponse(resized);
  } catch (err) {
    if (err instanceof ProcessNotFoundError) {
      return {
        error: 'adb not found. Android screenshots require Android platform-tools on PATH.',
      };
    }
    return {
      error: `Failed to capture Android screenshot: ${(err as Error).message}`,
    };
  }
};

export const screenshotTool = (runner: ProcessRunner): HostToolHandler => {
  return {
    description: `WebP screenshot, resized to save tokens. Response is [image, metadata] where metadata is JSON with { width, height, originalWidth, originalHeight, scale, bytes }. Returns { unchanged: true } when the screen hasn't changed since the last capture — cheap polling. Use fiber_tree bounds for tap targeting; screenshots are for visual verification.`,
    handler: async (args, ctx) => {
      const resolved = await resolveDevice(ctx, parseResolveOptions(args), runner);
      if (!resolved.ok) {
        return { error: resolved.error };
      }
      const width = clampWidth(args.width);
      if (resolved.device.platform === 'ios') {
        return captureIos(resolved.device.nativeId, runner, width);
      }
      return captureAndroid(resolved.device.nativeId, runner, width);
    },
    inputSchema: {
      platform: PLATFORM_ARG_SCHEMA,
      width: {
        description: `Output width in pixels (aspect ratio preserved). Default ${SCREENSHOT_DEFAULT_WIDTH}, clamped ${SCREENSHOT_MIN_WIDTH}..${SCREENSHOT_MAX_WIDTH}. Bump up only if you need to read small text.`,
        type: 'number',
      },
      ...NATIVE_ID_SCHEMA,
    },
    timeout: SCREENSHOT_TIMEOUT_MS,
  };
};

export { SCREENSHOT_TIMEOUT_MS };
