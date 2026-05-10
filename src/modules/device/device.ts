import { type McpModule } from '@/client/models/types';

// All fields the unified `info` tool can return. The handler reads from RN
// modules (Platform, Dimensions, Appearance, AppState, AccessibilityInfo,
// Keyboard, Linking) and returns the union as a flat record. Pass `select`
// to filter; omit for the full payload.
const INFO_FIELDS = [
  'platform', // { os, version, constants } from Platform
  'dimensions', // { screen, window, screenPixels, windowPixels, pixelRatio }
  'pixelRatio', // { pixelRatio, fontScale }
  'appearance', // { colorScheme: 'light' | 'dark' | null }
  'appState', // { state: 'active' | 'background' | 'inactive' }
  'accessibility', // { isScreenReaderEnabled, isReduceMotionEnabled }
  'keyboard', // { isVisible, metrics }
  'initialUrl', // { url }
  'dev', // { dev: boolean }
] as const;

type InfoField = (typeof INFO_FIELDS)[number];

export const deviceModule = (): McpModule => {
  // Lazy require to avoid importing react-native on server side
  const getRN = () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    return require('react-native');
  };

  const buildInfoField = async (field: InfoField): Promise<unknown> => {
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
  info({ select? }) — aggregate. Returns { platform, dimensions, pixelRatio,
  appearance, appState, accessibility, keyboard, initialUrl, dev }. Pass
  \`select: ['appState','keyboard']\` to limit to specific fields; omit for
  the full payload.

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
        description:
          'Aggregate device / platform introspection. Returns `{ platform, dimensions, pixelRatio, appearance, appState, accessibility, keyboard, initialUrl, dev }`. Pass `select: [...]` to limit to specific fields; omit for the full payload.',
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
            description: `Optional list of fields to return. Default = all. Known fields: ${INFO_FIELDS.join(' / ')}.`,
            examples: [['platform'], ['appState', 'keyboard'], ['accessibility']],
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
            description:
              'When true, only check Linking.canOpenURL and return `{ canOpen, url }` without opening. Default false.',
            type: 'boolean',
          },
          url: { description: 'URL to open (or check, when dryRun:true).', type: 'string' },
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
          duration: { description: 'Duration in ms (default: 400).', type: 'number' },
        },
      },
    },
  };
};
