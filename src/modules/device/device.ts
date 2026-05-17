import { type McpModule } from '@/client/models/types';
import { getRN } from '@/shared/rn/core';
import {
  callDI,
  callDIAsync,
  DEVICE_INFO_UNAVAILABLE,
  loadDeviceInfo,
} from '@/shared/rn/deviceInfo';

// All fields the unified `info` tool can return. The handler reads from RN
// core modules (Platform, Dimensions, Appearance, AppState,
// AccessibilityInfo, Keyboard, Linking) plus — when installed — selected
// helpers from `react-native-device-info`. Pass `select` to filter; omit
// for the full payload.
//
// Fields backed by react-native-device-info (identity / app / battery /
// memoryStorage) return `{ unavailable: true, reason }` when the package
// isn't installed. Fields already surfaced in the handshake (appName,
// appVersion, bundleId, deviceId, label) are not duplicated here.
const INFO_FIELDS = [
  // RN core
  'platform', // { os, version, constants } from Platform
  'dimensions', // { screen, window, screenPixels, windowPixels, pixelRatio }
  'pixelRatio', // { pixelRatio, fontScale }
  'appearance', // { colorScheme: 'light' | 'dark' | null }
  'appState', // { state: 'active' | 'background' | 'inactive' }
  'accessibility', // { isScreenReaderEnabled, isReduceMotionEnabled }
  'keyboard', // { isVisible, metrics }
  'initialUrl', // { url }
  'dev', // { dev: boolean }
  // react-native-device-info (optional)
  'identity', // { model, manufacturer, deviceType, isTablet, hasNotch, hasDynamicIsland, systemName, systemVersion }
  'app', // { buildNumber, readableVersion, firstInstallTime, lastUpdateTime, installerPackageName }
  'battery', // { batteryLevel, isCharging, isLowBatteryLevel, powerState }
  'memoryStorage', // { totalMemory, usedMemory, maxMemory, totalDiskCapacity, freeDiskStorage }
] as const;

type InfoField = (typeof INFO_FIELDS)[number];

// react-native-device-info-backed fields share a single graceful-degradation
// payload when the package isn't installed.
const DI_FIELDS = new Set<InfoField>(['identity', 'app', 'battery', 'memoryStorage']);

export const deviceModule = (): McpModule => {
  const buildInfoField = async (field: InfoField): Promise<unknown> => {
    // react-native-device-info-backed fields go first so we can short-circuit
    // when the package is missing without poking at RN.
    if (DI_FIELDS.has(field)) {
      const DI = loadDeviceInfo();
      if (!DI) return DEVICE_INFO_UNAVAILABLE;
      switch (field) {
        case 'identity':
          // Identity excludes handshake-duplicated fields (deviceId, label,
          // appName/appVersion/bundleId).
          return {
            deviceType: callDI<string>(DI.getDeviceType),
            hasDynamicIsland: callDI<boolean>(DI.hasDynamicIsland),
            hasNotch: callDI<boolean>(DI.hasNotch),
            isTablet: callDI<boolean>(DI.isTablet),
            manufacturer: callDI<string>(DI.getManufacturerSync ?? DI.getBrand),
            model: callDI<string>(DI.getModel),
            systemName: callDI<string>(DI.getSystemName),
            systemVersion: callDI<string>(DI.getSystemVersion),
          };
        case 'app': {
          // App excludes bundleId / version / appName already in handshake.
          const [firstInstallTime, lastUpdateTime, installerPackageName] = await Promise.all([
            callDIAsync<number>(DI.getFirstInstallTime),
            callDIAsync<number>(DI.getLastUpdateTime),
            callDIAsync<string>(DI.getInstallerPackageName),
          ]);
          return {
            buildNumber: callDI<string>(DI.getBuildNumber),
            firstInstallTime,
            installerPackageName,
            lastUpdateTime,
            readableVersion: callDI<string>(DI.getReadableVersion),
          };
        }
        case 'battery': {
          const [batteryLevel, isCharging, powerState] = await Promise.all([
            callDIAsync<number>(DI.getBatteryLevel),
            callDIAsync<boolean>(DI.isBatteryCharging),
            callDIAsync<unknown>(DI.getPowerState),
          ]);
          return {
            batteryLevel,
            isCharging,
            isLowBatteryLevel: typeof batteryLevel === 'number' ? batteryLevel < 0.2 : null,
            powerState,
          };
        }
        case 'memoryStorage': {
          const [totalMemory, usedMemory, maxMemory, totalDiskCapacity, freeDiskStorage] =
            await Promise.all([
              callDIAsync<number>(DI.getTotalMemory),
              callDIAsync<number>(DI.getUsedMemory),
              callDIAsync<number>(DI.getMaxMemory),
              callDIAsync<number>(DI.getTotalDiskCapacity),
              callDIAsync<number>(DI.getFreeDiskStorage),
            ]);
          return {
            freeDiskStorage,
            maxMemory,
            totalDiskCapacity,
            totalMemory,
            usedMemory,
          };
        }
      }
    }

    const RN = getRN();
    switch (field) {
      case 'platform':
        return {
          constants: RN.Platform.constants,
          os: RN.Platform.OS,
          version: RN.Platform.Version,
        };
      case 'dimensions': {
        const ratio = RN.PixelRatio.get();
        const screen = RN.Dimensions.get('screen');
        const window = RN.Dimensions.get('window');
        return {
          pixelRatio: ratio,
          screen,
          screenPixels: {
            height: Math.round(screen.height * ratio),
            width: Math.round(screen.width * ratio),
          },
          window,
          windowPixels: {
            height: Math.round(window.height * ratio),
            width: Math.round(window.width * ratio),
          },
        };
      }
      case 'pixelRatio':
        return {
          fontScale: RN.PixelRatio.getFontScale(),
          pixelRatio: RN.PixelRatio.get(),
        };
      case 'appearance':
        return { colorScheme: RN.Appearance.getColorScheme() };
      case 'appState':
        return { state: RN.AppState.currentState };
      case 'accessibility': {
        const [isScreenReaderEnabled, isReduceMotionEnabled] = await Promise.all([
          RN.AccessibilityInfo.isScreenReaderEnabled(),
          RN.AccessibilityInfo.isReduceMotionEnabled(),
        ]);
        return { isReduceMotionEnabled, isScreenReaderEnabled };
      }
      case 'keyboard':
        return {
          isVisible: RN.Keyboard.isVisible(),
          metrics: RN.Keyboard.metrics(),
        };
      case 'initialUrl': {
        const url = await RN.Linking.getInitialURL();
        return { url };
      }
      case 'dev':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { dev: Boolean((globalThis as any).__DEV__) };
      default:
        return null;
    }
  };

  return {
    description: `Device + platform introspection, plus a few imperative actions (open URL, dismiss keyboard, reload, vibrate).

Dimension helpers return values in both logical DP and physical pixels —
physical pixel helpers (screenPixels / windowPixels under \`dimensions\`)
match what host__tap / adb input tap consume.

READS
  info({ select? }) — one aggregate read. Returns any subset of:
    RN core: platform, dimensions, pixelRatio, appearance, appState,
      accessibility, keyboard, initialUrl, dev
    react-native-device-info (optional dep): identity, app, battery,
      memoryStorage
  Pass \`select: ['battery','keyboard']\` to limit fields; omit for the full
  payload. DI-backed fields gracefully return
  \`{ unavailable: true, reason }\` when the package isn't installed. Fields
  already in the handshake (appName / appVersion / bundleId / deviceId /
  label) are not duplicated.

ACTIONS
  open_url({ url, dryRun? }) — opens the URL via Linking. \`dryRun: true\`
  only checks Linking.canOpenURL without launching anything (returns
  { canOpen, url }).
  open_settings — open the app settings page.
  dismiss_keyboard — Keyboard.dismiss().
  reload — DevSettings.reload() (dev only).
  vibrate({ duration? }) — Vibration.vibrate(duration|400).`,
    name: 'device',
    tools: {
      dismiss_keyboard: {
        description: 'Dismiss the currently visible keyboard.',
        handler: () => {
          const { Keyboard } = getRN();
          Keyboard.dismiss();
          return { success: true };
        },
      },
      info: {
        description: `Aggregate device / platform introspection. Returns any subset of: ${INFO_FIELDS.join(' / ')}. Pass \`select: ['battery','keyboard']\` to limit to specific fields; omit for the full payload. Fields backed by react-native-device-info (identity / app / battery / memoryStorage) return \`{ unavailable: true, reason }\` when the package isn't installed.`,
        handler: async (args) => {
          const requested = Array.isArray(args.select)
            ? (args.select as string[]).filter((f): f is InfoField => {
                return (INFO_FIELDS as readonly string[]).includes(f);
              })
            : INFO_FIELDS;
          if (Array.isArray(args.select) && requested.length === 0) {
            return {
              availableFields: INFO_FIELDS,
              error: `select must contain at least one known field. Got ${JSON.stringify(args.select)}.`,
            };
          }
          const entries = await Promise.all(
            requested.map(async (field) => {
              return [field, await buildInfoField(field)] as const;
            })
          );
          const out: Record<string, unknown> = {};
          for (const [key, value] of entries) out[key] = value;
          return out;
        },
        inputSchema: {
          select: {
            description: `Optional list of fields to return. Omit for all. identity / app / battery / memoryStorage require react-native-device-info; they return { unavailable: true, reason } when the package isn't installed.`,
            examples: [['battery'], ['identity', 'app'], ['platform', 'dimensions']],
            items: { enum: INFO_FIELDS, type: 'string' },
            minItems: 1,
            type: 'array',
          },
        },
      },
      open_settings: {
        description: 'Open the app settings page in device settings.',
        handler: async () => {
          const { Linking } = getRN();
          await Linking.openSettings();
          return { success: true };
        },
      },
      open_url: {
        description:
          'Open a URL with the appropriate installed app. Pass `dryRun: true` to only check whether an app can handle it (returns `{ canOpen, url }`) without launching.',
        handler: async (args) => {
          const { Linking } = getRN();
          const url = args.url as string;
          if (args.dryRun === true) {
            const canOpen = await Linking.canOpenURL(url);
            return { canOpen, url };
          }
          await Linking.openURL(url);
          return { success: true, url };
        },
        inputSchema: {
          dryRun: {
            default: false,
            description:
              'When true, only check Linking.canOpenURL and return `{ canOpen, url }` without opening.',
            type: 'boolean',
          },
          url: {
            description: 'URL to open (or check, when dryRun:true).',
            examples: ['https://example.com', 'myapp://settings'],
            minLength: 1,
            type: 'string',
          },
        },
      },
      reload: {
        description: 'Reload the app (dev mode only — like pressing R in Metro).',
        handler: () => {
          const { DevSettings } = getRN();
          DevSettings.reload();
          return { success: true };
        },
      },
      vibrate: {
        description: 'Vibrate the device.',
        handler: (args) => {
          const { Vibration } = getRN();
          const duration = (args.duration as number) || 400;
          Vibration.vibrate(duration);
          return { success: true };
        },
        inputSchema: {
          duration: {
            default: 400,
            description: 'Duration in ms.',
            minimum: 0,
            type: 'number',
          },
        },
      },
    },
  };
};
