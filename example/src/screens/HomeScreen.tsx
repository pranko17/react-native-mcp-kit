import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { type BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { useNavigation } from '@react-navigation/native';

import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Screen } from '../components/Screen';
import { useTheme } from '../hooks/useTheme';
import { useSession } from '../providers/SessionProvider';
import { type RootTabParamList } from '../navigation/types';
import { spacing } from '../theme';

type Nav = BottomTabNavigationProp<RootTabParamList>;

interface Capability {
  modules: string;
  desc: string;
  target?: keyof RootTabParamList;
}

const CAPABILITIES: Capability[] = [
  { modules: 'fiber_tree', desc: 'Walk the live React tree — props, hooks, bounds, mcpId.', target: 'ShopTab' },
  { modules: 'query · network', desc: 'React Query cache + intercepted fetch on the product list.', target: 'ShopTab' },
  { modules: 'redux', desc: 'Inspect state & dispatch cart actions.', target: 'CartTab' },
  { modules: 'alert · console · errors · log_box', desc: 'Trigger side effects the agent can read back.', target: 'ToolsTab' },
  { modules: 'feature_flags (useMcpModule)', desc: 'A module registered from a feature subtree.', target: 'ToolsTab' },
  { modules: 'i18n · storage · device', desc: 'Language, key-value stores, platform facts.', target: 'SettingsTab' },
  { modules: 'session (useMcpTool)', desc: 'Ad-hoc dynamic tools tied to a component.', target: 'SettingsTab' },
];

export const HomeScreen = (): React.JSX.Element => {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { user } = useSession();
  const navigation = useNavigation<Nav>();

  return (
    <Screen testID="home-screen">
      <Card testID="home-hero">
        <Text style={[styles.title, { color: colors.text }]}>{t('home.title')}</Text>
        <Text style={[styles.subtitle, { color: colors.subtext }]}>{t('home.subtitle')}</Text>
        <Text style={[styles.welcome, { color: colors.primary }]}>
          {t('home.welcome', { name: user ? user.name : t('home.guest') })}
        </Text>
      </Card>

      <View style={styles.quick}>
        <Button title={t('tabs.shop')} onPress={() => navigation.navigate('ShopTab')} testID="go-shop" style={styles.quickBtn} />
        <Button title={t('tabs.cart')} variant="secondary" onPress={() => navigation.navigate('CartTab')} testID="go-cart" style={styles.quickBtn} />
        <Button title={t('tabs.tools')} variant="secondary" onPress={() => navigation.navigate('ToolsTab')} testID="go-tools" style={styles.quickBtn} />
        <Button title={t('tabs.settings')} variant="secondary" onPress={() => navigation.navigate('SettingsTab')} testID="go-settings" style={styles.quickBtn} />
      </View>

      <Text style={[styles.section, { color: colors.text }]}>{t('home.capabilities')}</Text>
      <Text style={[styles.hint, { color: colors.subtext }]}>{t('home.hint')}</Text>

      {CAPABILITIES.map((cap, index) => (
        <Card key={index} testID={`capability-${index}`}>
          <View style={styles.capHead}>
            <Text style={[styles.capModules, { color: colors.accent }]}>{cap.modules}</Text>
            {cap.target ? (
              <Button title="→" variant="ghost" onPress={() => navigation.navigate(cap.target as never)} />
            ) : null}
          </View>
          <Text style={[styles.capDesc, { color: colors.subtext }]}>{cap.desc}</Text>
        </Card>
      ))}
    </Screen>
  );
};

const styles = StyleSheet.create({
  title: { fontSize: 24, fontWeight: '800' },
  subtitle: { fontSize: 14 },
  welcome: { fontSize: 16, fontWeight: '700', marginTop: spacing.xs },
  quick: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  quickBtn: { flexGrow: 1, minWidth: '46%' },
  section: { fontSize: 18, fontWeight: '700', marginTop: spacing.sm },
  hint: { fontSize: 13, marginBottom: spacing.xs },
  capHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  capModules: { fontSize: 15, fontWeight: '700', flexShrink: 1 },
  capDesc: { fontSize: 13 },
});
