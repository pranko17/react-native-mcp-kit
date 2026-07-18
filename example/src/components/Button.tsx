import React from 'react';
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '../hooks/useTheme';
import { radius, spacing } from '../theme';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

export const Button = ({
  title,
  onPress,
  variant = 'primary',
  disabled = false,
  testID,
  style,
}: ButtonProps): React.JSX.Element => {
  const { colors } = useTheme();

  const bg = {
    primary: colors.primary,
    secondary: colors.card,
    danger: colors.danger,
    ghost: 'transparent',
  }[variant];

  const fg = {
    primary: colors.primaryText,
    secondary: colors.text,
    danger: '#ffffff',
    ghost: colors.primary,
  }[variant];

  const borderColor = variant === 'secondary' ? colors.border : 'transparent';

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
        style,
      ]}
    >
      <Text style={[styles.label, { color: fg }]}>{title}</Text>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  button: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontSize: 15, fontWeight: '600' },
});
