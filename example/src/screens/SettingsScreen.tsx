import React, { useMemo, useState } from 'react';
import { StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import DeviceInfo from 'react-native-device-info';

import { Button } from '../components/Button';
import { LanguagePicker } from '../components/LanguagePicker';
import { Row } from '../components/Row';
import { Screen } from '../components/Screen';
import { Section } from '../components/Section';
import { useTheme } from '../hooks/useTheme';
import { useSession } from '../providers/SessionProvider';
import { clearSampleData, countMmkvKeys, seedSampleData } from '../storage/adapters';
import { useAppDispatch, useAppSelector } from '../store';
import { decrement, increment, reset } from '../store/slices/counterSlice';
import { setDisplayName, setNotifications, toggleTheme } from '../store/slices/settingsSlice';
import { radius, spacing } from '../theme';

const safe = (fn: () => unknown): string => {
  try {
    return String(fn());
  } catch {
    return '—';
  }
};

export const SettingsScreen = (): React.JSX.Element => {
  const { colors, theme } = useTheme();
  const { t } = useTranslation();
  const dispatch = useAppDispatch();

  const notifications = useAppSelector((state) => state.settings.notificationsEnabled);
  const displayName = useAppSelector((state) => state.settings.displayName);
  const counter = useAppSelector((state) => state.counter.value);

  const { user, login, logout } = useSession();

  const [keyCount, setKeyCount] = useState<number>(() => countMmkvKeys());

  const device = useMemo(
    () => ({
      brand: safe(() => DeviceInfo.getBrand()),
      model: safe(() => DeviceInfo.getModel()),
      system: `${safe(() => DeviceInfo.getSystemName())} ${safe(() => DeviceInfo.getSystemVersion())}`,
      appVersion: safe(() => DeviceInfo.getVersion()),
    }),
    []
  );

  return (
    <Screen testID="settings-screen">
      <Section title={t('settings.appearance')} testID="section-appearance">
        <Row label={t('settings.theme')}>
          <Switch testID="theme-switch" value={theme === 'dark'} onValueChange={() => { dispatch(toggleTheme()); }} />
        </Row>
        <Row label={t('settings.notifications')}>
          <Switch testID="notifications-switch" value={notifications} onValueChange={(value) => { dispatch(setNotifications(value)); }} />
        </Row>
        <Text style={[styles.label, { color: colors.subtext }]}>{t('settings.language')}</Text>
        <LanguagePicker />
      </Section>

      <Section title={t('settings.counterTitle')} testID="section-counter">
        <Text style={[styles.counter, { color: colors.text }]} testID="counter-value">
          {counter}
        </Text>
        <View style={styles.grid}>
          <Button title={t('settings.decrement')} variant="secondary" onPress={() => dispatch(decrement())} testID="counter-dec" style={styles.cell} />
          <Button title={t('settings.increment')} variant="secondary" onPress={() => dispatch(increment())} testID="counter-inc" style={styles.cell} />
          <Button title={t('settings.reset')} variant="ghost" onPress={() => dispatch(reset())} testID="counter-reset" style={styles.cell} />
        </View>
      </Section>

      <Section title={t('settings.sessionTitle')} testID="section-session">
        <Text style={[styles.label, { color: colors.text }]} testID="session-status">
          {user ? t('settings.loggedInAs', { name: user.name }) : t('settings.loggedOut')}
        </Text>
        {user ? (
          <Button title={t('settings.logout')} variant="danger" onPress={logout} testID="session-logout" />
        ) : (
          <Button title={t('settings.login')} onPress={() => login('Ada')} testID="session-login" />
        )}
        <Text style={[styles.label, { color: colors.subtext }]}>{t('settings.displayName')}</Text>
        <TextInput
          testID="display-name-input"
          value={displayName}
          onChangeText={(value) => dispatch(setDisplayName(value))}
          style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.bg }]}
          placeholder="Guest"
          placeholderTextColor={colors.subtext}
        />
      </Section>

      <Section title={t('settings.storageTitle')} testID="section-storage">
        <Row label="MMKV keys" value={String(keyCount)} testID="mmkv-key-count" />
        <View style={styles.grid}>
          <Button
            title={t('settings.seed')}
            variant="secondary"
            testID="storage-seed"
            style={styles.cell}
            onPress={() => {
              seedSampleData();
              setKeyCount(countMmkvKeys());
            }}
          />
          <Button
            title={t('settings.clearStorage')}
            variant="ghost"
            testID="storage-clear"
            style={styles.cell}
            onPress={() => {
              clearSampleData();
              setKeyCount(countMmkvKeys());
            }}
          />
        </View>
      </Section>

      <Section title="Device" testID="section-device">
        <Row label="Brand" value={device.brand} />
        <Row label="Model" value={device.model} />
        <Row label="System" value={device.system} />
        <Row label="App version" value={device.appVersion} />
      </Section>
    </Screen>
  );
};

const styles = StyleSheet.create({
  label: { fontSize: 14, marginTop: spacing.xs },
  counter: { fontSize: 40, fontWeight: '800', textAlign: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  cell: { flexGrow: 1, minWidth: '30%' },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 15,
  },
});
