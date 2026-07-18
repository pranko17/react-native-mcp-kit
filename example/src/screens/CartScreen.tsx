import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Screen } from '../components/Screen';
import { useTheme } from '../hooks/useTheme';
import { useAppDispatch, useAppSelector } from '../store';
import { changeQty, clearCart, removeItem } from '../store/slices/cartSlice';
import { spacing } from '../theme';

export const CartScreen = (): React.JSX.Element => {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const items = useAppSelector((state) => state.cart.items);

  const count = items.reduce((sum, item) => sum + item.qty, 0);
  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);

  if (items.length === 0) {
    return (
      <Screen testID="cart-screen">
        <Card>
          <Text style={[styles.empty, { color: colors.subtext }]}>{t('cart.empty')}</Text>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen testID="cart-screen">
      <Text style={[styles.summary, { color: colors.subtext }]}>{t('cart.itemsCount', { count })}</Text>

      {items.map((item) => (
        <Card key={item.id} testID={`cart-item-${item.id}`}>
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>
            {item.title}
          </Text>
          <View style={styles.line}>
            <Text style={[styles.price, { color: colors.primary }]}>
              ${(item.price * item.qty).toFixed(2)}
            </Text>
            <View style={styles.qty}>
              <Button title="−" variant="secondary" onPress={() => dispatch(changeQty({ id: item.id, qty: item.qty - 1 }))} testID={`qty-dec-${item.id}`} />
              <Text style={[styles.qtyValue, { color: colors.text }]} testID={`qty-value-${item.id}`}>
                {item.qty}
              </Text>
              <Button title="+" variant="secondary" onPress={() => dispatch(changeQty({ id: item.id, qty: item.qty + 1 }))} testID={`qty-inc-${item.id}`} />
            </View>
          </View>
          <Button title={t('common.remove')} variant="ghost" onPress={() => dispatch(removeItem(item.id))} testID={`remove-${item.id}`} />
        </Card>
      ))}

      <Card testID="cart-total">
        <View style={styles.line}>
          <Text style={[styles.totalLabel, { color: colors.text }]}>{t('cart.total')}</Text>
          <Text style={[styles.totalValue, { color: colors.text }]}>${total.toFixed(2)}</Text>
        </View>
      </Card>

      <Button title={t('cart.clear')} variant="danger" onPress={() => dispatch(clearCart())} testID="clear-cart" />
    </Screen>
  );
};

const styles = StyleSheet.create({
  empty: { fontSize: 15, textAlign: 'center' },
  summary: { fontSize: 13 },
  title: { fontSize: 15, fontWeight: '600' },
  line: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  price: { fontSize: 16, fontWeight: '800' },
  qty: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  qtyValue: { fontSize: 16, fontWeight: '700', minWidth: 24, textAlign: 'center' },
  totalLabel: { fontSize: 16, fontWeight: '700' },
  totalValue: { fontSize: 20, fontWeight: '800' },
});
