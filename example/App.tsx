import React from 'react';
import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  type Theme,
} from '@react-navigation/native';
import { Provider as ReduxProvider } from 'react-redux';
import { McpProvider, type McpProviderProps } from 'react-native-mcp-kit';

import './src/i18n';
import i18n from './src/i18n';
import { demoModule } from './src/mcp/demoModule';
import { navigationRef, RootNavigator } from './src/navigation';
import { FeatureFlagsProvider } from './src/providers/FeatureFlagsProvider';
import { SessionProvider } from './src/providers/SessionProvider';
import { queryClient } from './src/query/queryClient';
import { storages } from './src/storage/adapters';
import { store } from './src/store';
import { useTheme } from './src/hooks/useTheme';
import { getColors, type ThemeName } from './src/theme';

// i18next's `t` is heavily overloaded (it can return objects when a key points
// at a nested resource), while the kit's `I18nLike` simplifies it to
// `(...args) => string`. A real i18next instance satisfies everything the
// module actually calls, so this interop cast is safe.
const mcpI18n = i18n as unknown as McpProviderProps['i18n'];

const navTheme = (theme: ThemeName): Theme => {
  const base = theme === 'dark' ? DarkTheme : DefaultTheme;
  const colors = getColors(theme);
  return {
    ...base,
    colors: {
      ...base.colors,
      background: colors.bg,
      card: colors.card,
      text: colors.text,
      border: colors.border,
      primary: colors.primary,
    },
  };
};

// Inside Redux, so it can theme the StatusBar + NavigationContainer.
const AppShell = (): React.JSX.Element => {
  const { theme } = useTheme();
  return (
    <>
      <StatusBar barStyle={theme === 'dark' ? 'light-content' : 'dark-content'} />
      <NavigationContainer ref={navigationRef} theme={navTheme(theme)}>
        <RootNavigator />
      </NavigationContainer>
    </>
  );
};

const App = (): React.JSX.Element => {
  return (
    <SafeAreaProvider>
      <ReduxProvider store={store}>
        <QueryClientProvider client={queryClient}>
          {/*
            McpProvider wires every optional module at once:
              navigationRef -> navigation   queryClient -> query
              i18n          -> i18n          store       -> redux
              storages      -> storage       modules     -> custom "demo"
            Always-on modules (alert/console/device/errors/log_box/network/fiber_tree)
            register on mount. `debug` prints all MCP traffic to the Metro console.
          */}
          <McpProvider
            debug
            navigationRef={navigationRef}
            queryClient={queryClient}
            i18n={mcpI18n}
            store={store}
            storages={storages}
            modules={[demoModule()]}
          >
            <SessionProvider>
              <FeatureFlagsProvider>
                <AppShell />
              </FeatureFlagsProvider>
            </SessionProvider>
          </McpProvider>
        </QueryClientProvider>
      </ReduxProvider>
    </SafeAreaProvider>
  );
};

export default App;
