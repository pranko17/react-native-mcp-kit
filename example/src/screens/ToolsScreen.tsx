import React, { useState } from 'react';
import { Alert, StyleSheet, Switch, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../components/Button';
import { Row } from '../components/Row';
import { Screen } from '../components/Screen';
import { Section } from '../components/Section';
import { useTheme } from '../hooks/useTheme';
import { useFeatureFlags, type FeatureFlags } from '../providers/FeatureFlagsProvider';
import { API_BASE } from '../query/api';
import { spacing } from '../theme';

export const ToolsScreen = (): React.JSX.Element => {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { flags, setFlag } = useFeatureFlags();
  const [lastRequest, setLastRequest] = useState<string | null>(null);

  const showAlert = (): void => {
    Alert.alert('react-native-mcp-kit', 'This native alert can also be shown/answered via alert__show.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'OK' },
    ]);
  };

  const logExample = (): void => {
    console.log('[demo] console.log with an object', { user: 'ada', cart: [1, 2, 3], at: new Date() });
  };
  const warnExample = (): void => {
    console.warn('[demo] console.warn — captured by the console module (and LogBox in dev)');
  };
  const errorExample = (): void => {
    console.error('[demo] console.error with a stack', new Error('demo error object'));
  };
  const groupExample = (): void => {
    console.group('[demo] group');
    console.log('inside the group');
    console.groupEnd();
  };

  const throwUncaught = (): void => {
    // Thrown async so it reaches the global handler -> the `errors` module.
    setTimeout(() => {
      throw new Error('Demo: uncaught error thrown from ToolsScreen');
    }, 0);
  };
  const rejectPromise = (): void => {
    void Promise.reject(new Error('Demo: unhandled promise rejection from ToolsScreen'));
  };

  const logboxWarn = (): void => {
    console.warn('Demo LogBox warning: this row can be inspected/dismissed via the log_box module.');
  };

  const request = async (method: string, url: string, body?: unknown): Promise<void> => {
    setLastRequest(`${method} …`);
    try {
      const response = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      setLastRequest(t('tools.requestDone', { method, status: response.status }));
    } catch (caught) {
      setLastRequest(`${method} ✕ ${String(caught)}`);
    }
  };

  const flagKeys = Object.keys(flags) as (keyof FeatureFlags)[];

  return (
    <Screen testID="tools-screen">
      <Text style={[styles.subtitle, { color: colors.subtext }]}>{t('tools.subtitle')}</Text>

      <Section title={t('tools.alertsTitle')} testID="section-alert">
        <Button title={t('tools.showAlert')} onPress={showAlert} testID="btn-alert" />
      </Section>

      <Section title={t('tools.logsTitle')} testID="section-console">
        <View style={styles.grid}>
          <Button title={t('tools.logInfo')} variant="secondary" onPress={logExample} testID="btn-log" style={styles.cell} />
          <Button title={t('tools.logWarn')} variant="secondary" onPress={warnExample} testID="btn-warn" style={styles.cell} />
          <Button title={t('tools.logError')} variant="secondary" onPress={errorExample} testID="btn-error" style={styles.cell} />
          <Button title={t('tools.logGroup')} variant="secondary" onPress={groupExample} testID="btn-group" style={styles.cell} />
        </View>
      </Section>

      <Section title={t('tools.errorsTitle')} testID="section-errors">
        <Button title={t('tools.throwError')} variant="danger" onPress={throwUncaught} testID="btn-throw" />
        <Button title={t('tools.rejectPromise')} variant="danger" onPress={rejectPromise} testID="btn-reject" />
      </Section>

      <Section title={t('tools.logboxTitle')} testID="section-logbox">
        <Button title={t('tools.logboxWarn')} variant="secondary" onPress={logboxWarn} testID="btn-logbox" />
      </Section>

      <Section title={t('tools.networkTitle')} testID="section-network">
        <View style={styles.grid}>
          <Button title={t('tools.getOk')} variant="secondary" onPress={() => void request('GET', `${API_BASE}/products/1`)} testID="btn-get-ok" style={styles.cell} />
          <Button title={t('tools.get404')} variant="secondary" onPress={() => void request('GET', `${API_BASE}/http/404`)} testID="btn-get-404" style={styles.cell} />
          <Button title={t('tools.postEcho')} variant="secondary" onPress={() => void request('POST', `${API_BASE}/products/add`, { title: 'MCP widget', price: 42 })} testID="btn-post" style={styles.cell} />
        </View>
        {lastRequest ? (
          <Text style={[styles.status, { color: colors.text }]} testID="network-status">
            {lastRequest}
          </Text>
        ) : null}
      </Section>

      <Section title={t('tools.flagsTitle')} testID="section-flags">
        {flagKeys.map((key) => (
          <Row key={key} label={key}>
            <Switch
              testID={`flag-${key}`}
              value={flags[key]}
              onValueChange={(value) => setFlag(key, value)}
            />
          </Row>
        ))}
      </Section>
    </Screen>
  );
};

const styles = StyleSheet.create({
  subtitle: { fontSize: 13 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  cell: { flexGrow: 1, minWidth: '46%' },
  status: { fontSize: 14, fontWeight: '600', marginTop: spacing.xs },
});
