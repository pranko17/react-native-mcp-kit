import type { McpModule } from '../client/types';

interface NavigationRef {
  canGoBack: () => boolean;
  getCurrentRoute: () => unknown;
  getRootState: () => unknown;
  goBack: () => void;
  navigate: (screen: string, params?: Record<string, unknown>) => void;
}

export const navigationModule = (navigation: NavigationRef): McpModule => {
  return {
    name: 'navigation',
    tools: {
      get_current_route: {
        description: 'Get the currently focused route name and params',
        handler: () => {
          return navigation.getCurrentRoute();
        },
      },
      get_state: {
        description: 'Get the full navigation state tree',
        handler: () => {
          return navigation.getRootState();
        },
      },
      go_back: {
        description: 'Go back to the previous screen',
        handler: () => {
          if (navigation.canGoBack()) {
            navigation.goBack();
            return { success: true };
          }
          return { reason: 'Cannot go back', success: false };
        },
      },
      navigate: {
        description: 'Navigate to a specific screen',
        handler: (args) => {
          navigation.navigate(args.screen as string, args.params as Record<string, unknown>);
          return { currentRoute: navigation.getCurrentRoute(), success: true };
        },
        inputSchema: {
          params: { description: 'Optional route params', type: 'object' },
          screen: { description: 'Screen name to navigate to', type: 'string' },
        },
      },
    },
  };
};
