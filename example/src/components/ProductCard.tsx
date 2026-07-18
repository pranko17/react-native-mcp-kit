import React, { useCallback, useMemo, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { type Product } from '../query/api';
import { useTheme } from '../hooks/useTheme';
import { radius, spacing } from '../theme';
import { Button } from './Button';

interface ProductCardProps {
  product: Product;
  onAdd: (product: Product) => void;
  onOpen: (product: Product) => void;
}

// Rich, capitalized component with named hooks (`expanded`, `formattedPrice`,
// `handleAdd`, `toggle`) and a stable `testID` — a good target for
// `fiber_tree__query` by name / testID / mcpId and for `select:["hooks"]`.
export const ProductCard = ({ product, onAdd, onOpen }: ProductCardProps): React.JSX.Element => {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const formattedPrice = useMemo(() => `$${product.price.toFixed(2)}`, [product.price]);
  const handleAdd = useCallback(() => onAdd(product), [onAdd, product]);
  const toggle = useCallback(() => setExpanded((value) => !value), []);

  return (
    <View
      testID={`product-card-${product.id}`}
      style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
    >
      <Pressable style={styles.head} onPress={() => onOpen(product)} accessibilityRole="button">
        <Image source={{ uri: product.thumbnail }} style={styles.thumb} />
        <View style={styles.info}>
          <Text numberOfLines={2} style={[styles.title, { color: colors.text }]}>
            {product.title}
          </Text>
          <Text style={[styles.price, { color: colors.primary }]}>{formattedPrice}</Text>
          <Text style={[styles.meta, { color: colors.subtext }]}>
            ⭐ {product.rating.toFixed(1)} · {product.category}
          </Text>
        </View>
      </Pressable>

      <Pressable onPress={toggle} accessibilityRole="button">
        <Text numberOfLines={expanded ? undefined : 1} style={[styles.desc, { color: colors.subtext }]}>
          {product.description}
        </Text>
      </Pressable>

      <Button
        title={t('shop.addToCart')}
        variant="primary"
        onPress={handleAdd}
        testID={`add-to-cart-${product.id}`}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
    gap: spacing.sm,
  },
  head: { flexDirection: 'row', gap: spacing.md },
  thumb: { width: 72, height: 72, borderRadius: radius.sm, backgroundColor: '#00000010' },
  info: { flex: 1, gap: 2 },
  title: { fontSize: 15, fontWeight: '700' },
  price: { fontSize: 16, fontWeight: '800' },
  meta: { fontSize: 12 },
  desc: { fontSize: 13, lineHeight: 18 },
});
