import React from 'react';
import { Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { useTheme } from '../hooks/useTheme';
import { CartScreen } from '../screens/CartScreen';
import { HomeScreen } from '../screens/HomeScreen';
import { ProductDetailScreen } from '../screens/ProductDetailScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { ShopScreen } from '../screens/ShopScreen';
import { ToolsScreen } from '../screens/ToolsScreen';
import { useAppSelector } from '../store';
import { type ThemeColors } from '../theme';
import { type RootTabParamList, type ShopStackParamList } from './types';

// Shared ref — passed to BOTH <NavigationContainer ref> and
// <McpProvider navigationRef>, which is what wires up the `navigation` module.
export const navigationRef = createNavigationContainerRef<RootTabParamList>();

const Tab = createBottomTabNavigator<RootTabParamList>();
const ShopStack = createNativeStackNavigator<ShopStackParamList>();

const headerOptions = (colors: ThemeColors) => ({
  headerStyle: { backgroundColor: colors.card },
  headerTitleStyle: { color: colors.text },
  headerTintColor: colors.primary,
});

const tabIcon =
  (emoji: string) =>
  // eslint-disable-next-line react/no-unstable-nested-components
  ({ focused }: { focused: boolean; color: string; size: number }): React.JSX.Element => (
    <Text style={{ fontSize: 18, opacity: focused ? 1 : 0.5 }}>{emoji}</Text>
  );

const ShopNavigator = (): React.JSX.Element => {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <ShopStack.Navigator
      screenOptions={{ ...headerOptions(colors), contentStyle: { backgroundColor: colors.bg } }}
    >
      <ShopStack.Screen name="ShopList" component={ShopScreen} options={{ title: t('shop.title') }} />
      <ShopStack.Screen
        name="ProductDetail"
        component={ProductDetailScreen}
        options={({ route }) => ({ title: route.params.title })}
      />
    </ShopStack.Navigator>
  );
};

export const RootNavigator = (): React.JSX.Element => {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const cartCount = useAppSelector((state) =>
    state.cart.items.reduce((sum, item) => sum + item.qty, 0)
  );

  return (
    <Tab.Navigator
      screenOptions={{
        ...headerOptions(colors),
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.subtext,
      }}
    >
      <Tab.Screen name="HomeTab" component={HomeScreen} options={{ title: t('tabs.home'), tabBarIcon: tabIcon('🏠') }} />
      <Tab.Screen name="ShopTab" component={ShopNavigator} options={{ title: t('tabs.shop'), headerShown: false, tabBarIcon: tabIcon('🛍️') }} />
      <Tab.Screen
        name="CartTab"
        component={CartScreen}
        options={{ title: t('tabs.cart'), tabBarIcon: tabIcon('🛒'), tabBarBadge: cartCount > 0 ? cartCount : undefined }}
      />
      <Tab.Screen name="ToolsTab" component={ToolsScreen} options={{ title: t('tabs.tools'), tabBarIcon: tabIcon('🧪') }} />
      <Tab.Screen name="SettingsTab" component={SettingsScreen} options={{ title: t('tabs.settings'), tabBarIcon: tabIcon('⚙️') }} />
    </Tab.Navigator>
  );
};
