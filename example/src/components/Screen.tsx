import React, { type ReactNode } from 'react';
import { ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '../hooks/useTheme';
import { spacing } from '../theme';

interface ScreenProps {
  children: ReactNode;
  scroll?: boolean;
  testID?: string;
  contentStyle?: StyleProp<ViewStyle>;
}

export const Screen = ({
  children,
  scroll = true,
  testID,
  contentStyle,
}: ScreenProps): React.JSX.Element => {
  const { colors } = useTheme();

  if (!scroll) {
    return (
      <View testID={testID} style={[styles.flex, { backgroundColor: colors.bg }, contentStyle]}>
        {children}
      </View>
    );
  }

  return (
    <ScrollView
      testID={testID}
      style={[styles.flex, { backgroundColor: colors.bg }]}
      contentContainerStyle={[styles.content, contentStyle]}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing.lg, paddingBottom: spacing.xl * 2, gap: spacing.lg },
});
