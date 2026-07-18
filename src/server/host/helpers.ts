import { z } from 'zod';

export interface AppTargetError {
  error: string;
}

export const NATIVE_ID_SCHEMA = {
  serial: z
    .string()
    .describe(
      'Explicit adb serial of the target Android device (e.g. "emulator-5554"). Highest priority — bypasses clientId and platform-based device selection. Use values from host__list_devices output.'
    )
    .optional(),
  udid: z
    .string()
    .describe(
      'Explicit simctl UDID of the target iOS simulator. Highest priority — bypasses clientId and platform-based device selection. Use values from host__list_devices output.'
    )
    .optional(),
};

export const PLATFORM_ARG_SCHEMA = z
  .enum(['android', 'ios'])
  .describe(
    "Platform filter for device resolution. Ignored when clientId is provided (the client's own platform is used instead)."
  )
  .optional();

export const parsePlatformArg = (value: unknown): 'android' | 'ios' | undefined => {
  return value === 'ios' || value === 'android' ? value : undefined;
};

export const parseStringArg = (value: unknown): string | undefined => {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

export const parseResolveOptions = (
  args: Record<string, unknown>
): { platform?: 'android' | 'ios'; serial?: string; udid?: string } => {
  return {
    platform: parsePlatformArg(args.platform),
    serial: parseStringArg(args.serial),
    udid: parseStringArg(args.udid),
  };
};

export const parseCoord = (
  value: unknown,
  name: string
): { ok: true; value: number } | { error: string; ok: false } => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return { error: `'${name}' must be a non-negative finite number`, ok: false };
  }
  return { ok: true, value: Math.floor(value) };
};
