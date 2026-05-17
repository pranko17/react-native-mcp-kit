import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';

import { captureScreenshot } from '@/server/host/coredevice/screenshot';
import { resolveDevice } from '@/server/host/deviceResolver';
import { NATIVE_ID_SCHEMA, PLATFORM_ARG_SCHEMA, parseResolveOptions } from '@/server/host/helpers';
import { ProcessNotFoundError, type ProcessRunner } from '@/server/host/processRunner';
import { type HostToolHandler } from '@/server/host/types';

const SCREENSHOT_TIMEOUT_MS = 15_000;
const SCREENSHOT_DEFAULT_WIDTH = 280;
const SCREENSHOT_MIN_WIDTH = 64;
const SCREENSHOT_MAX_WIDTH = 1568;
const WEBP_QUALITY = 80;

const clampWidth = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return SCREENSHOT_DEFAULT_WIDTH;
  }
  return Math.max(SCREENSHOT_MIN_WIDTH, Math.min(SCREENSHOT_MAX_WIDTH, Math.floor(value)));
};

interface Region {
  height: number;
  width: number;
  x: number;
  y: number;
}

const parseRegion = (raw: unknown): Region | { error: string } | null => {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'region must be an object { x, y, width, height }.' };
  }
  const r = raw as Record<string, unknown>;
  const x = Number(r.x);
  const y = Number(r.y);
  const width = Number(r.width);
  const height = Number(r.height);
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return { error: 'region.x / y / width / height must all be finite numbers.' };
  }
  if (width <= 0 || height <= 0) {
    return { error: 'region.width and region.height must be positive.' };
  }
  return {
    height: Math.floor(height),
    width: Math.floor(width),
    x: Math.max(0, Math.floor(x)),
    y: Math.max(0, Math.floor(y)),
  };
};

interface ResizedScreenshot {
  buffer: Buffer;
  height: number;
  width: number;
  originalHeight?: number;
  originalWidth?: number;
  region?: Region;
}

const resizeScreenshot = async (
  input: Buffer,
  targetWidth: number,
  region: Region | null
): Promise<ResizedScreenshot> => {
  const pipeline = sharp(input);
  const meta = await pipeline.metadata();
  const origW = meta.width ?? 0;
  const origH = meta.height ?? 0;

  let appliedRegion: Region | undefined;
  let stage = pipeline;
  if (region && origW > 0 && origH > 0) {
    // Clip region to the actual image bounds so agents can pass fiber
    // bounds without guarding the edges.
    const left = Math.min(region.x, origW - 1);
    const top = Math.min(region.y, origH - 1);
    const w = Math.min(region.width, origW - left);
    const h = Math.min(region.height, origH - top);
    if (w > 0 && h > 0) {
      stage = pipeline.extract({ height: h, left, top, width: w });
      appliedRegion = { height: h, width: w, x: left, y: top };
    }
  }

  const { data, info } = await stage
    .resize({ width: targetWidth, withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: data,
    height: info.height,
    originalHeight: origH || undefined,
    originalWidth: origW || undefined,
    region: appliedRegion,
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
  /**
   * Applied crop rectangle in ORIGINAL device pixels — absent when the full
   * screen was captured. Agent maps image pixel (px, py) back to device pixel
   * as (region.x + px / scale, region.y + py / scale).
   */
  region?: Region;
  scale?: number;
}

const buildResponse = (resized: ResizedScreenshot): ScreenshotResponse => {
  // `scale` = image-to-source ratio. When a region was cropped it's the
  // image/region ratio; otherwise it's image/full-screen. Agents use it for
  // pixel-back-to-device math.
  const sourceWidth = resized.region?.width ?? resized.originalWidth;
  const meta: ScreenshotMeta = {
    bytes: resized.buffer.length,
    height: resized.height,
    originalHeight: resized.originalHeight,
    originalWidth: resized.originalWidth,
    region: resized.region,
    scale: sourceWidth ? Number((resized.width / sourceWidth).toFixed(3)) : undefined,
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
  width: number,
  region: Region | null
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
    const resized = await resizeScreenshot(raw, width, region);
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

// Real iOS device — talks DTX to the device's instruments dtservicehub
// through the CoreDevice tunnel (see src/server/host/coredevice/). No
// simulator involved.
const captureIosRealDevice = async (
  coreDeviceIdentifier: string,
  width: number,
  region: Region | null
): Promise<ScreenshotResponse | ScreenshotUnchanged | ScreenshotError> => {
  try {
    const raw = await captureScreenshot(coreDeviceIdentifier, {
      timeoutMs: SCREENSHOT_TIMEOUT_MS,
    });
    const resized = await resizeScreenshot(raw, width, region);
    const hash = hashBuffer(resized.buffer);
    if (lastScreenshotHash.get(coreDeviceIdentifier) === hash) {
      return { message: 'Screenshot unchanged since last capture.', unchanged: true };
    }
    lastScreenshotHash.set(coreDeviceIdentifier, hash);
    return buildResponse(resized);
  } catch (err) {
    return {
      error: `Failed to capture real-device screenshot: ${(err as Error).message}`,
    };
  }
};

const captureAndroid = async (
  serial: string,
  runner: ProcessRunner,
  width: number,
  region: Region | null
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
    const resized = await resizeScreenshot(proc.stdout, width, region);
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
    description: `WebP screenshot, resized to save vision tokens. Response is [image, metadata] where metadata is JSON with { width, height, originalWidth, originalHeight, scale, bytes, region? }.

TOKEN BUDGETING
  • Vision tokens are driven by image area. Default width ${SCREENSHOT_DEFAULT_WIDTH} gives a readable full-screen view at ~300 tokens. Bump only to read small text.
  • Pass \`region: { x, y, width, height }\` (physical device pixels) to crop to a single element — typical tap-target shrinks to ~20-60 vision tokens. Grab the rect from fiber_tree__query bounds.
  • { unchanged: true } is returned when the resized bytes are identical to the previous capture — cheap polling.

Use fiber_tree bounds for tap targeting; screenshots are for visual verification of what the UI looks like right now.`,
    handler: async (args, ctx) => {
      const resolved = await resolveDevice(ctx, parseResolveOptions(args), runner);
      if (!resolved.ok) {
        return { error: resolved.error };
      }
      const width = clampWidth(args.width);
      const region = parseRegion(args.region);
      if (region && 'error' in region) {
        return { error: region.error };
      }
      if (resolved.device.platform === 'ios') {
        if (resolved.device.kind === 'real-device') {
          return captureIosRealDevice(resolved.device.nativeId, width, region);
        }
        return captureIos(resolved.device.nativeId, runner, width, region);
      }
      return captureAndroid(resolved.device.nativeId, runner, width, region);
    },
    inputSchema: {
      platform: PLATFORM_ARG_SCHEMA,
      region: {
        description:
          'Crop rectangle in original device pixels (top-left origin). Out-of-bounds values are clipped. Typical use: pass fiber_tree bounds ({ x, y, width, height }) to snapshot just one component. Omitted = full screen.',
        examples: [{ height: 128, width: 900, x: 60, y: 200 }],
        type: 'object',
      },
      width: {
        description: `Output width in image pixels (aspect ratio preserved, applied AFTER cropping). Default ${SCREENSHOT_DEFAULT_WIDTH}, clamped ${SCREENSHOT_MIN_WIDTH}..${SCREENSHOT_MAX_WIDTH}. Bump up only if you need to read small text.`,
        type: 'number',
      },
      ...NATIVE_ID_SCHEMA,
    },
    timeout: SCREENSHOT_TIMEOUT_MS,
  };
};

export { SCREENSHOT_TIMEOUT_MS };
