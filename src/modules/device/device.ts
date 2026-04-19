import { type McpModule } from '@/client/models/types';

export const deviceModule = (): McpModule => {
  // Lazy require to avoid importing react-native on server side
  const getRN = () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    return require('react-native');
  };

  return {
    description: `Device + platform introspection, plus a few imperative actions (open URL, dismiss keyboard, reload, vibrate).

Dimension helpers return values in both logical DP and physical pixels —
physical pixel helpers (screenPixels / windowPixels in get_dimensions)
match what host__tap / adb input tap consume.`,
    name: 'device',
    tools: {
      can_open_url: {
        description: 'Check if a URL can be opened by an installed app.',
        handler: async (args) => {
          const { Linking } = getRN();
          const canOpen = await Linking.canOpenURL(args.url as string);
          return { canOpen, url: args.url };
        },
        inputSchema: {
          url: { description: 'URL to check.', type: 'string' },
        },
      },

      dismiss_keyboard: {
        description: 'Dismiss the currently visible keyboard.',
        handler: () => {
          const { Keyboard } = getRN();
          Keyboard.dismiss();
          return { success: true };
        },
      },

      get_accessibility_info: {
        description: 'Screen reader / reduce motion / bold text settings.',
        handler: async () => {
          const { AccessibilityInfo } = getRN();
          const [isScreenReaderEnabled, isReduceMotionEnabled] = await Promise.all([
            AccessibilityInfo.isScreenReaderEnabled(),
            AccessibilityInfo.isReduceMotionEnabled(),
          ]);
          return {
            isReduceMotionEnabled,
            isScreenReaderEnabled,
          };
        },
      },

      get_app_state: {
        description: 'App lifecycle state: active / background / inactive.',
        handler: () => {
          const { AppState } = getRN();
          return { state: AppState.currentState };
        },
      },

      get_appearance: {
        description: 'Current color scheme: light / dark / null.',
        handler: () => {
          const { Appearance } = getRN();
          return { colorScheme: Appearance.getColorScheme() };
        },
      },

      get_device_info: {
        description: 'Platform, OS version, dimensions, pixel ratio, appearance, dev flag.',
        handler: () => {
          const { Appearance, Dimensions, PixelRatio, Platform } = getRN();
          return {
            appearance: Appearance.getColorScheme(),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            dev: Boolean((globalThis as any).__DEV__),
            dimensions: {
              screen: Dimensions.get('screen'),
              window: Dimensions.get('window'),
            },
            pixelRatio: PixelRatio.get(),
            platform: {
              constants: Platform.constants,
              os: Platform.OS,
              version: Platform.Version,
            },
          };
        },
      },

      get_dimensions: {
        description: 'Screen + window dimensions in both DP (raw RN) and physical pixels.',
        handler: () => {
          const { Dimensions, PixelRatio } = getRN();
          const ratio = PixelRatio.get();
          const screen = Dimensions.get('screen');
          const window = Dimensions.get('window');
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
        },
      },

      get_initial_url: {
        description: 'Deep link that launched the app, if any.',
        handler: async () => {
          const { Linking } = getRN();
          const url = await Linking.getInitialURL();
          return { url };
        },
      },

      get_keyboard_state: {
        description: 'Keyboard visibility + metrics.',
        handler: () => {
          const { Keyboard } = getRN();
          return {
            isVisible: Keyboard.isVisible(),
            metrics: Keyboard.metrics(),
          };
        },
      },

      get_pixel_ratio: {
        description: 'Pixel density + font scale.',
        handler: () => {
          const { PixelRatio } = getRN();
          return {
            fontScale: PixelRatio.getFontScale(),
            pixelRatio: PixelRatio.get(),
          };
        },
      },
      get_platform: {
        description: 'OS, version, native constants (model/brand/manufacturer on Android).',
        handler: () => {
          const { Platform } = getRN();
          return {
            constants: Platform.constants,
            os: Platform.OS,
            version: Platform.Version,
          };
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
        description: 'Open a URL with the appropriate installed app.',
        handler: async (args) => {
          const { Linking } = getRN();
          await Linking.openURL(args.url as string);
          return { success: true, url: args.url };
        },
        inputSchema: {
          url: { description: 'URL to open.', type: 'string' },
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
