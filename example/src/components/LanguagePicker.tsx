import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { languageNames } from '../i18n/resources';
import { useTheme } from '../hooks/useTheme';
import { radius, spacing } from '../theme';

const CODES = ['en', 'ru', 'es'];

// Segmented control bound to i18next. Pressing a code calls `changeLanguage`,
// the same path the agent drives via `i18n__set_language`.
export const LanguagePicker = (): React.JSX.Element => {
  const { colors } = useTheme();
  const { i18n } = useTranslation();
  const current = i18n.language;

  return (
    <View style={[styles.group, { borderColor: colors.border }]} testID="language-picker">
      {CODES.map((code) => {
        const active = current === code;
        return (
          <Pressable
            key={code}
            testID={`language-${code}`}
            accessibilityRole="button"
            onPress={() => void i18n.changeLanguage(code)}
            style={[styles.item, active && { backgroundColor: colors.primary }]}
          >
            <Text style={[styles.text, { color: active ? colors.primaryText : colors.text }]}>
              {languageNames[code]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  group: {
    flexDirection: 'row',
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  item: { flex: 1, paddingVertical: spacing.sm, alignItems: 'center' },
  text: { fontSize: 14, fontWeight: '600' },
});
