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

const resizeScreenshot = async (input: Buffer, targetWidth: number): Promise<Buffer> => {
  return sharp(input)
    .resize({ width: targetWidth, withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
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

interface ScreenshotError {
  error: string;
}

interface ScreenshotUnchanged {
  message: string;
  unchanged: true;
}

const captureIos = async (
  udid: string,
  runner: ProcessRunner,
  width: number
): Promise<[ScreenshotImage] | ScreenshotUnchanged | ScreenshotError> => {
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
    const hash = hashBuffer(resized);
    if (lastScreenshotHash.get(udid) === hash) {
      return { message: 'Screenshot unchanged since last capture.', unchanged: true };
    }
    lastScreenshotHash.set(udid, hash);
    return [
      {
        data: resized.toString('base64'),
        mimeType: 'image/webp',
        type: 'image',
      },
    ];
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
): Promise<[ScreenshotImage] | ScreenshotUnchanged | ScreenshotError> => {
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
    const hash = hashBuffer(resized);
    if (lastScreenshotHash.get(serial) === hash) {
      return { message: 'Screenshot unchanged since last capture.', unchanged: true };
    }
    lastScreenshotHash.set(serial, hash);
    return [
      {
        data: resized.toString('base64'),
        mimeType: 'image/webp',
        type: 'image',
      },
    ];
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
    description: `Capture a WebP screenshot from an iOS simulator or Android device, resized to save vision tokens. Default width ${SCREENSHOT_DEFAULT_WIDTH}px (pass \`width\` to override, max ${SCREENSHOT_MAX_WIDTH}). Returns "unchanged: true" if the screen hasn't changed since the last capture (saves tokens on redundant checks). For tap targeting prefer fiber_tree__find_all bounds — screenshots are only needed for visual verification or when targeting non-React surfaces.`,
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
        description: `Output width in pixels. Aspect ratio preserved, height auto-computed. Default ${SCREENSHOT_DEFAULT_WIDTH}. Capped to ${SCREENSHOT_MIN_WIDTH}..${SCREENSHOT_MAX_WIDTH}. Use higher values when you need to read small text; default is enough for visual verification.`,
        type: 'number',
      },
      ...NATIVE_ID_SCHEMA,
    },
    timeout: SCREENSHOT_TIMEOUT_MS,
  };
};

export { SCREENSHOT_TIMEOUT_MS };
