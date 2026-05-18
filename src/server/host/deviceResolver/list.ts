import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProcessNotFoundError, type ProcessRunner } from '@/server/host/processRunner';

import {
  type AndroidDevice,
  type DeviceResolution,
  type IosRealDevice,
  type IosSimulator,
} from './types';

const CACHE_TTL_MS = 5_000;
const LIST_TIMEOUT_MS = 5_000;

interface Cache<T> {
  result: T;
  timestamp: number;
}

let iosCache: Cache<IosSimulator[]> | null = null;
let iosRealCache: Cache<IosRealDevice[]> | null = null;
let androidCache: Cache<AndroidDevice[]> | null = null;

export const clearDeviceCache = (): void => {
  iosCache = null;
  iosRealCache = null;
  androidCache = null;
};

export const XCRUN_MISSING_ERROR =
  'xcrun not found. iOS host tools require Xcode command line tools (macOS only).';
export const ADB_MISSING_ERROR =
  'adb not found. Android host tools require Android platform-tools on PATH.';

// Map a thrown error to a user-facing DeviceResolution error. Handles the
// common ProcessNotFoundError → "install the toolchain" message; everything
// else gets wrapped as a context-prefixed message.
export const toDeviceError = (
  err: unknown,
  context: string,
  toolMissing: string
): DeviceResolution => {
  if (err instanceof ProcessNotFoundError) {
    return { error: toolMissing, ok: false };
  }
  return { error: `${context}: ${(err as Error).message}`, ok: false };
};

export const listIosSimulators = async (runner: ProcessRunner): Promise<IosSimulator[]> => {
  if (iosCache && Date.now() - iosCache.timestamp < CACHE_TTL_MS) {
    return iosCache.result;
  }
  const proc = await runner('xcrun', ['simctl', 'list', 'devices', '--json'], {
    timeoutMs: LIST_TIMEOUT_MS,
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `xcrun simctl list failed (exit ${proc.exitCode}): ${proc.stderr.toString('utf8').trim().slice(0, 500)}`
    );
  }
  const parsed = JSON.parse(proc.stdout.toString('utf8')) as {
    devices: Record<string, Array<{ name?: string; state?: string; udid?: string }>>;
  };
  const out: IosSimulator[] = [];
  for (const runtime of Object.values(parsed.devices ?? {})) {
    for (const d of runtime) {
      if (typeof d.udid === 'string' && typeof d.name === 'string' && typeof d.state === 'string') {
        out.push({ name: d.name, state: d.state, udid: d.udid });
      }
    }
  }
  iosCache = { result: out, timestamp: Date.now() };
  return out;
};

// Paired physical iOS devices come from `xcrun devicectl` — simctl knows
// nothing about them. The JSON output of `list devices` is the only stable
// integration surface (its stdout has a human-readable header first).
export const listIosRealDevices = async (runner: ProcessRunner): Promise<IosRealDevice[]> => {
  if (iosRealCache && Date.now() - iosRealCache.timestamp < CACHE_TTL_MS) {
    return iosRealCache.result;
  }
  const tmpPath = join(tmpdir(), `rnmcp-devicectl-${randomUUID()}.json`);
  try {
    const proc = await runner('xcrun', ['devicectl', 'list', 'devices', '--json-output', tmpPath], {
      timeoutMs: LIST_TIMEOUT_MS,
    });
    if (proc.exitCode !== 0) {
      throw new Error(
        `xcrun devicectl list failed (exit ${proc.exitCode}): ${proc.stderr.toString('utf8').trim().slice(0, 500)}`
      );
    }
    const raw = readFileSync(tmpPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      result?: {
        devices?: Array<{
          connectionProperties?: { pairingState?: string };
          deviceProperties?: { name?: string };
          hardwareProperties?: { platform?: string };
          identifier?: string;
        }>;
      };
    };
    const devices = parsed.result?.devices ?? [];
    const out: IosRealDevice[] = [];
    for (const d of devices) {
      if (d.hardwareProperties?.platform !== 'iOS') continue;
      const id = d.identifier;
      const name = d.deviceProperties?.name;
      const pairingState = d.connectionProperties?.pairingState;
      if (typeof id === 'string' && typeof name === 'string' && typeof pairingState === 'string') {
        out.push({ coreDeviceIdentifier: id, name, pairingState });
      }
    }
    iosRealCache = { result: out, timestamp: Date.now() };
    return out;
  } finally {
    rm(tmpPath, { force: true }).catch(() => {
      // best-effort
    });
  }
};

export const listAndroidDevices = async (runner: ProcessRunner): Promise<AndroidDevice[]> => {
  if (androidCache && Date.now() - androidCache.timestamp < CACHE_TTL_MS) {
    return androidCache.result;
  }
  const proc = await runner('adb', ['devices'], { timeoutMs: LIST_TIMEOUT_MS });
  if (proc.exitCode !== 0) {
    throw new Error(
      `adb devices failed (exit ${proc.exitCode}): ${proc.stderr.toString('utf8').trim().slice(0, 500)}`
    );
  }
  const lines = proc.stdout.toString('utf8').split('\n');
  const out: AndroidDevice[] = [];
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const match = line.match(/^(\S+)\s+(\S+)\s*$/);
    if (match?.[1] && match[2]) {
      out.push({ serial: match[1], state: match[2] });
    }
  }
  androidCache = { result: out, timestamp: Date.now() };
  return out;
};
