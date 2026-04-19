import { resolveDevice, type ResolvedDevice } from '@/server/host/deviceResolver';
import {
  type AppTargetError,
  NATIVE_ID_SCHEMA,
  parseResolveOptions,
  parseStringArg,
  PLATFORM_ARG_SCHEMA,
} from '@/server/host/helpers';
import { ProcessNotFoundError, type ProcessRunner } from '@/server/host/processRunner';
import { type HostContext, type HostToolHandler } from '@/server/host/types';

const LAUNCH_TIMEOUT_MS = 15_000;

interface LaunchSuccess {
  bundleId: string;
  device: ResolvedDevice;
  launched: true;
}

interface TerminateSuccess {
  bundleId: string;
  device: ResolvedDevice;
  terminated: true;
}

interface RestartSuccess {
  bundleId: string;
  device: ResolvedDevice;
  restarted: true;
}

interface ResolvedLaunchTarget {
  bundleId: string;
  device: ResolvedDevice;
  ok: true;
}

type LaunchTargetResolution = ResolvedLaunchTarget | { error: string; ok: false };

const launchIos = async (
  udid: string,
  bundleId: string,
  runner: ProcessRunner
): Promise<{ ok: true } | AppTargetError> => {
  try {
    const proc = await runner('xcrun', ['simctl', 'launch', udid, bundleId], {
      timeoutMs: LAUNCH_TIMEOUT_MS,
    });
    if (proc.timedOut) {
      return { error: `iOS launch timed out after ${LAUNCH_TIMEOUT_MS}ms` };
    }
    if (proc.exitCode !== 0) {
      return {
        error: `xcrun simctl launch failed (exit ${proc.exitCode}): ${proc.stderr.toString('utf8').trim().slice(0, 500)}`,
      };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof ProcessNotFoundError) {
      return {
        error: 'xcrun not found. iOS launch requires Xcode command line tools.',
      };
    }
    return { error: `Failed to launch iOS app: ${(err as Error).message}` };
  }
};

const PM_LIST_TIMEOUT_MS = 5_000;

// `adb shell pm list packages <name>` returns every package whose name CONTAINS
// <name>, so we still have to filter for an exact match in code. Returns true
// if the package is installed, false if it isn't, and null if pm itself failed
// (in which case the caller should fall through to the launch attempt and let
// monkey produce its own error).
const isAndroidPackageInstalled = async (
  serial: string,
  packageName: string,
  runner: ProcessRunner
): Promise<boolean | null> => {
  try {
    const proc = await runner(
      'adb',
      ['-s', serial, 'shell', 'pm', 'list', 'packages', packageName],
      { timeoutMs: PM_LIST_TIMEOUT_MS }
    );
    if (proc.timedOut || proc.exitCode !== 0) {
      return null;
    }
    const lines = proc.stdout.toString('utf8').split('\n');
    return lines.some((line) => {
      return line.trim() === `package:${packageName}`;
    });
  } catch {
    return null;
  }
};

const launchAndroid = async (
  serial: string,
  packageName: string,
  runner: ProcessRunner
): Promise<{ ok: true } | AppTargetError> => {
  // Verify the package exists first — `adb shell monkey` produces a confusing
  // exit code (252 with verbose-args echo on stderr) when the target package
  // isn't installed, which makes the original failure hard to diagnose.
  const installed = await isAndroidPackageInstalled(serial, packageName, runner);
  if (installed === false) {
    return {
      error: `Package '${packageName}' is not installed on '${serial}'. Verify the bundleId — Android applicationId is usually different from the iOS bundle id (use \`adb -s ${serial} shell pm list packages\` to see what's installed).`,
    };
  }

  try {
    const proc = await runner(
      'adb',
      [
        '-s',
        serial,
        'shell',
        'monkey',
        '-p',
        packageName,
        '-c',
        'android.intent.category.LAUNCHER',
        '1',
      ],
      { timeoutMs: LAUNCH_TIMEOUT_MS }
    );
    if (proc.timedOut) {
      return { error: `Android launch timed out after ${LAUNCH_TIMEOUT_MS}ms` };
    }
    if (proc.exitCode !== 0) {
      return {
        error: `adb shell monkey failed (exit ${proc.exitCode}) for package '${packageName}': ${proc.stderr.toString('utf8').trim().slice(0, 500)}`,
      };
    }
    // monkey reports "No activities found to run, monkey aborted." to stdout on missing packages
    const stdoutText = proc.stdout.toString('utf8');
    if (stdoutText.includes('No activities found')) {
      return {
        error: `adb shell monkey: no launcher activity found for package '${packageName}'. The app is installed but has no LAUNCHER intent.`,
      };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof ProcessNotFoundError) {
      return {
        error: 'adb not found. Android launch requires Android platform-tools on PATH.',
      };
    }
    return { error: `Failed to launch Android app: ${(err as Error).message}` };
  }
};

const terminateIos = async (
  udid: string,
  bundleId: string,
  runner: ProcessRunner
): Promise<{ ok: true } | AppTargetError> => {
  try {
    const proc = await runner('xcrun', ['simctl', 'terminate', udid, bundleId], {
      timeoutMs: LAUNCH_TIMEOUT_MS,
    });
    if (proc.timedOut) {
      return { error: `iOS terminate timed out after ${LAUNCH_TIMEOUT_MS}ms` };
    }
    if (proc.exitCode !== 0) {
      return {
        error: `xcrun simctl terminate failed (exit ${proc.exitCode}): ${proc.stderr.toString('utf8').trim().slice(0, 500)}`,
      };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof ProcessNotFoundError) {
      return {
        error: 'xcrun not found. iOS terminate requires Xcode command line tools.',
      };
    }
    return { error: `Failed to terminate iOS app: ${(err as Error).message}` };
  }
};

const terminateAndroid = async (
  serial: string,
  packageName: string,
  runner: ProcessRunner
): Promise<{ ok: true } | AppTargetError> => {
  try {
    const proc = await runner('adb', ['-s', serial, 'shell', 'am', 'force-stop', packageName], {
      timeoutMs: LAUNCH_TIMEOUT_MS,
    });
    if (proc.timedOut) {
      return { error: `Android terminate timed out after ${LAUNCH_TIMEOUT_MS}ms` };
    }
    // am force-stop returns exit 0 even for non-existent packages (known quirk),
    // but we still surface any unexpected non-zero exit as an error.
    if (proc.exitCode !== 0) {
      return {
        error: `adb shell am force-stop failed (exit ${proc.exitCode}): ${proc.stderr.toString('utf8').trim().slice(0, 500)}`,
      };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof ProcessNotFoundError) {
      return {
        error: 'adb not found. Android terminate requires Android platform-tools on PATH.',
      };
    }
    return { error: `Failed to terminate Android app: ${(err as Error).message}` };
  }
};

const resolveLaunchTarget = async (
  ctx: HostContext,
  args: Record<string, unknown>,
  runner: ProcessRunner
): Promise<LaunchTargetResolution> => {
  const resolved = await resolveDevice(ctx, parseResolveOptions(args), runner);
  if (!resolved.ok) {
    return { error: resolved.error, ok: false };
  }
  const explicitAppId = parseStringArg(args.appId);
  const bundleId = explicitAppId ?? resolved.device.bundleId;
  if (!bundleId) {
    return {
      error:
        "appId required. Pass it explicitly (e.g. 'by.21vek.mobile') or target a clientId whose client registered its bundleId metadata.",
      ok: false,
    };
  }
  return { bundleId, device: resolved.device, ok: true };
};

const APPID_SCHEMA = {
  description:
    'iOS bundle ID or Android package name. Optional when a connected client already registered its bundleId.',
  examples: ['com.example.app', 'com.example.android'],
  type: 'string',
} as const;

export const launchAppTool = (runner: ProcessRunner): HostToolHandler => {
  return {
    description: 'Launch an installed app on a booted simulator / emulator / device.',
    handler: async (args, ctx) => {
      const target = await resolveLaunchTarget(ctx, args, runner);
      if (!target.ok) {
        return { error: target.error };
      }
      const result =
        target.device.platform === 'ios'
          ? await launchIos(target.device.nativeId, target.bundleId, runner)
          : await launchAndroid(target.device.nativeId, target.bundleId, runner);
      if ('error' in result) {
        return { error: result.error };
      }
      const success: LaunchSuccess = {
        bundleId: target.bundleId,
        device: target.device,
        launched: true,
      };
      return success;
    },
    inputSchema: {
      appId: APPID_SCHEMA,
      platform: PLATFORM_ARG_SCHEMA,
      ...NATIVE_ID_SCHEMA,
    },
    timeout: LAUNCH_TIMEOUT_MS,
  };
};

export const terminateAppTool = (runner: ProcessRunner): HostToolHandler => {
  return {
    description: 'Force-stop an installed app on the target device.',
    handler: async (args, ctx) => {
      const target = await resolveLaunchTarget(ctx, args, runner);
      if (!target.ok) {
        return { error: target.error };
      }
      const result =
        target.device.platform === 'ios'
          ? await terminateIos(target.device.nativeId, target.bundleId, runner)
          : await terminateAndroid(target.device.nativeId, target.bundleId, runner);
      if ('error' in result) {
        return { error: result.error };
      }
      const success: TerminateSuccess = {
        bundleId: target.bundleId,
        device: target.device,
        terminated: true,
      };
      return success;
    },
    inputSchema: {
      appId: APPID_SCHEMA,
      platform: PLATFORM_ARG_SCHEMA,
      ...NATIVE_ID_SCHEMA,
    },
    timeout: LAUNCH_TIMEOUT_MS,
  };
};

const RESTART_TEARDOWN_DELAY_MS = 200;

export const restartAppTool = (runner: ProcessRunner): HostToolHandler => {
  return {
    description:
      'Terminate then immediately relaunch an app (host__terminate_app + host__launch_app in one call, with a short teardown delay).',
    handler: async (args, ctx) => {
      const target = await resolveLaunchTarget(ctx, args, runner);
      if (!target.ok) {
        return { error: target.error };
      }
      const terminated =
        target.device.platform === 'ios'
          ? await terminateIos(target.device.nativeId, target.bundleId, runner)
          : await terminateAndroid(target.device.nativeId, target.bundleId, runner);
      if ('error' in terminated) {
        return { error: terminated.error };
      }
      // Give the OS a moment to finish tearing down before re-launch.
      await new Promise((r) => {
        return setTimeout(r, RESTART_TEARDOWN_DELAY_MS);
      });
      const launched =
        target.device.platform === 'ios'
          ? await launchIos(target.device.nativeId, target.bundleId, runner)
          : await launchAndroid(target.device.nativeId, target.bundleId, runner);
      if ('error' in launched) {
        return { error: launched.error };
      }
      const success: RestartSuccess = {
        bundleId: target.bundleId,
        device: target.device,
        restarted: true,
      };
      return success;
    },
    inputSchema: {
      appId: APPID_SCHEMA,
      platform: PLATFORM_ARG_SCHEMA,
      ...NATIVE_ID_SCHEMA,
    },
    timeout: LAUNCH_TIMEOUT_MS * 2 + RESTART_TEARDOWN_DELAY_MS + 500,
  };
};
