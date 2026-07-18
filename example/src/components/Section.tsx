import React, { type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../hooks/useTheme';
import { spacing } from '../theme';
import { Card } from './Card';

export const Section = ({
  title,
  subtitle,
  children,
  testID,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  testID?: string;
}): React.JSX.Element => {
  const { colors } = useTheme();
  return (
    <View style={styles.wrap} testID={testID}>
      <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
      {subtitle ? <Text style={[styles.subtitle, { color: colors.subtext }]}>{subtitle}</Text> : null}
      <Card>{children}</Card>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  title: { fontSize: 18, fontWeight: '700' },
  subtitle: { fontSize: 13 },
});
