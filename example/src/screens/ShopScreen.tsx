import React, { useCallback } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import { type NativeStackNavigationProp } from '@react-navigation/native-stack';

import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ProductCard } from '../components/ProductCard';
import { Screen } from '../components/Screen';
import { useTheme } from '../hooks/useTheme';
import { type Product } from '../query/api';
import { useProducts } from '../query/useProducts';
import { useAppDispatch } from '../store';
import { addItem } from '../store/slices/cartSlice';
import { type ShopStackParamList } from '../navigation/types';
import { spacing } from '../theme';

type Nav = NativeStackNavigationProp<ShopStackParamList>;

export const ShopScreen = (): React.JSX.Element => {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const navigation = useNavigation<Nav>();
  const { data, isLoading, isError, error, refetch, isRefetching } = useProducts(20);

  const onAdd = useCallback(
    (product: Product) => {
      dispatch(addItem({ id: product.id, title: product.title, price: product.price }));
    },
    [dispatch]
  );

  const onOpen = useCallback(
    (product: Product) => {
      navigation.navigate('ProductDetail', { id: product.id, title: product.title });
    },
    [navigation]
  );

  if (isLoading) {
    return (
      <Screen scroll={false} testID="shop-screen">
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
          <Text style={{ color: colors.subtext }}>{t('common.loading')}</Text>
        </View>
      </Screen>
    );
  }

  if (isError) {
    return (
      <Screen testID="shop-screen">
        <Card>
          <Text style={[styles.error, { color: colors.danger }]}>{t('shop.loadError')}</Text>
          <Text style={{ color: colors.subtext }}>{String(error)}</Text>
          <Button title={t('common.retry')} onPress={() => void refetch()} testID="shop-retry" />
        </Card>
      </Screen>
    );
  }

  const products = data?.products ?? [];

  return (
    <View style={[styles.flex, { backgroundColor: colors.bg }]}>
      <FlatList
        testID="product-list"
        data={products}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => <ProductCard product={item} onAdd={onAdd} onOpen={onOpen} />}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <Text style={[styles.count, { color: colors.subtext }]}>
            {t('shop.items', { count: products.length })}
          </Text>
        }
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={() => void refetch()}
            tintColor={colors.primary}
          />
        }
      />
    </View>
  );
};

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  list: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xl * 2 },
  count: { fontSize: 13, marginBottom: spacing.xs },
  error: { fontSize: 16, fontWeight: '700' },
});
