import React, { type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../hooks/useTheme';
import { spacing } from '../theme';

export const Row = ({
  label,
  value,
  children,
  testID,
}: {
  label: string;
  value?: string;
  children?: ReactNode;
  testID?: string;
}): React.JSX.Element => {
  const { colors } = useTheme();
  return (
    <View style={styles.row} testID={testID}>
      <Text style={[styles.label, { color: colors.subtext }]}>{label}</Text>
      {value !== undefined ? (
        <Text style={[styles.value, { color: colors.text }]}>{value}</Text>
      ) : (
        <View style={styles.slot}>{children}</View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 36,
    gap: spacing.md,
  },
  label: { fontSize: 14, flexShrink: 1 },
  value: { fontSize: 14, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  slot: { flexShrink: 0 },
});
