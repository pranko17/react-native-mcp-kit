import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enrichDevicesWithClientStatus, resolveDevice } from '@/server/host/deviceResolver';
import { ProcessNotFoundError, type ProcessRunner } from '@/server/host/processRunner';
import { type HostModule } from '@/server/host/types';

const SCREENSHOT_TIMEOUT_MS = 15_000;

interface ScreenshotImage {
  data: string;
  mimeType: 'image/png';
  type: 'image';
}

interface ScreenshotError {
  error: string;
}

const captureIos = async (
  udid: string,
  runner: ProcessRunner
): Promise<[ScreenshotImage] | ScreenshotError> => {
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
    const buffer = await readFile(tmpPath);
    return [
      {
        data: buffer.toString('base64'),
        mimeType: 'image/png',
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
  runner: ProcessRunner
): Promise<[ScreenshotImage] | ScreenshotError> => {
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
    return [
      {
        data: proc.stdout.toString('base64'),
        mimeType: 'image/png',
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

export const hostModule = (runner: ProcessRunner): HostModule => {
  return {
    description:
      'OS-level operations that run on the MCP server host via xcrun simctl / adb. Works when the React Native app is hung, disconnected, or not installed.',
    name: 'host',
    tools: {
      list_devices: {
        description:
          'List all iOS simulators (booted or not) and Android devices (online or offline) visible via xcrun simctl / adb. Each device is annotated with connected=true and a clientId when it matches a currently-connected React Native client. Connected devices appear first in each platform group.',
        handler: async (_args, ctx) => {
          return enrichDevicesWithClientStatus(ctx.bridge, runner);
        },
        inputSchema: {},
        timeout: SCREENSHOT_TIMEOUT_MS,
      },
      screenshot: {
        description:
          'Capture a raw PNG screenshot from an iOS simulator (xcrun simctl io) or Android device (adb exec-out screencap). Prefers the device of the connected React Native client when clientId is provided or exactly one client is connected; falls back to the single booted sim / online device otherwise.',
        handler: async (args, ctx) => {
          const rawPlatform = args.platform;
          const platform: 'android' | 'ios' | undefined =
            rawPlatform === 'ios' || rawPlatform === 'android' ? rawPlatform : undefined;
          const resolved = await resolveDevice(ctx, { platform }, runner);
          if (!resolved.ok) {
            return { error: resolved.error };
          }
          if (resolved.device.platform === 'ios') {
            return captureIos(resolved.device.nativeId, runner);
          }
          return captureAndroid(resolved.device.nativeId, runner);
        },
        inputSchema: {
          platform: {
            description:
              'Optional platform filter: "ios" or "android". Ignored when clientId is provided on the outer call tool (the client\'s own platform is used instead).',
            enum: ['android', 'ios'],
            type: 'string',
          },
        },
        timeout: SCREENSHOT_TIMEOUT_MS,
      },
    },
  };
};
