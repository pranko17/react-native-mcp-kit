import { type McpModule } from '@/client/models/types';

export const deviceModule = (): McpModule => {
  // Lazy require to avoid importing react-native on server side
  const getRN = () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    return require('react-native');
  };

  return {
    name: 'device',
    tools: {
      // === Linking ===
      can_open_url: {
        description: 'Check if a URL can be opened by an installed app',
        handler: async (args) => {
          const { Linking } = getRN();
          const canOpen = await Linking.canOpenURL(args.url as string);
          return { canOpen, url: args.url };
        },
        inputSchema: {
          url: { description: 'URL to check', type: 'string' },
        },
      },

      // === Keyboard ===
      dismiss_keyboard: {
        description: 'Dismiss the currently visible keyboard',
        handler: () => {
          const { Keyboard } = getRN();
          Keyboard.dismiss();
          return { success: true };
        },
      },

      // === Accessibility ===
      get_accessibility_info: {
        description: 'Get accessibility settings (screen reader, reduce motion, bold text, etc.)',
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

      // === App State ===
      get_app_state: {
        description: 'Get current app state (active, background, inactive)',
        handler: () => {
          const { AppState } = getRN();
          return { state: AppState.currentState };
        },
      },

      // === Appearance ===
      get_appearance: {
        description: 'Get current color scheme (light, dark, or null)',
        handler: () => {
          const { Appearance } = getRN();
          return { colorScheme: Appearance.getColorScheme() };
        },
      },

      // === Device Info ===
      get_device_info: {
        description:
          'Get comprehensive device info: platform, OS version, dimensions, pixel ratio, appearance',
        handler: () => {
          const { Appearance, Dimensions, PixelRatio, Platform } = getRN();
          return {
            appearance: Appearance.getColorScheme(),
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
        description: 'Get screen and window dimensions (width, height, scale, fontScale)',
        handler: () => {
          const { Dimensions } = getRN();
          return {
            screen: Dimensions.get('screen'),
            window: Dimensions.get('window'),
          };
        },
      },

      get_initial_url: {
        description: 'Get the URL that launched the app (deep link)',
        handler: async () => {
          const { Linking } = getRN();
          const url = await Linking.getInitialURL();
          return { url };
        },
      },

      get_keyboard_state: {
        description: 'Check if keyboard is currently visible and get its metrics',
        handler: () => {
          const { Keyboard } = getRN();
          return {
            isVisible: Keyboard.isVisible(),
            metrics: Keyboard.metrics(),
          };
        },
      },

      get_pixel_ratio: {
        description: 'Get device pixel density and font scale',
        handler: () => {
          const { PixelRatio } = getRN();
          return {
            fontScale: PixelRatio.getFontScale(),
            pixelRatio: PixelRatio.get(),
          };
        },
      },
      get_platform: {
        description:
          'Get platform info (OS, version, constants including model, brand, manufacturer on Android)',
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
        description: 'Open the app settings page in device settings',
        handler: async () => {
          const { Linking } = getRN();
          await Linking.openSettings();
          return { success: true };
        },
      },
      open_url: {
        description: 'Open a URL with the appropriate installed app (browser, maps, phone, etc.)',
        handler: async (args) => {
          const { Linking } = getRN();
          await Linking.openURL(args.url as string);
          return { success: true, url: args.url };
        },
        inputSchema: {
          url: { description: 'URL to open', type: 'string' },
        },
      },

      // === App Control ===
      reload: {
        description: 'Reload the app (dev mode only, like pressing R in Metro)',
        handler: () => {
          const { DevSettings } = getRN();
          DevSettings.reload();
          return { success: true };
        },
      },

      // === Vibration ===
      vibrate: {
        description: 'Vibrate the device',
        handler: (args) => {
          const { Vibration } = getRN();
          const duration = (args.duration as number) || 400;
          Vibration.vibrate(duration);
          return { success: true };
        },
        inputSchema: {
          duration: { description: 'Vibration duration in ms (default: 400)', type: 'number' },
        },
      },
    },
  };
};
