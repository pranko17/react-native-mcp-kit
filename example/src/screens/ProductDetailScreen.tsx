import React from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { type RouteProp, useRoute } from '@react-navigation/native';

import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Row } from '../components/Row';
import { Screen } from '../components/Screen';
import { useTheme } from '../hooks/useTheme';
import { useProduct } from '../query/useProducts';
import { useAppDispatch } from '../store';
import { addItem } from '../store/slices/cartSlice';
import { type ShopStackParamList } from '../navigation/types';
import { radius, spacing } from '../theme';

type DetailRoute = RouteProp<ShopStackParamList, 'ProductDetail'>;

export const ProductDetailScreen = (): React.JSX.Element => {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const route = useRoute<DetailRoute>();
  const { id } = route.params;

  const { data, isLoading, isError, error, refetch } = useProduct(id);

  if (isLoading) {
    return (
      <Screen scroll={false} testID="detail-screen">
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
          <Text style={{ color: colors.subtext }}>{t('common.loading')}</Text>
        </View>
      </Screen>
    );
  }

  if (isError || !data) {
    return (
      <Screen testID="detail-screen">
        <Card>
          <Text style={[styles.error, { color: colors.danger }]}>{t('common.error')}</Text>
          <Text style={{ color: colors.subtext }}>{String(error)}</Text>
          <Button title={t('common.retry')} onPress={() => void refetch()} testID="detail-retry" />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen testID="detail-screen">
      <Image source={{ uri: data.thumbnail }} style={styles.hero} />
      <Card>
        <Text style={[styles.title, { color: colors.text }]}>{data.title}</Text>
        <Text style={[styles.price, { color: colors.primary }]}>${data.price.toFixed(2)}</Text>
        <Row label={t('detail.brand')} value={data.brand ?? '—'} />
        <Row label={t('detail.category')} value={data.category} />
        <Row label={t('detail.rating')} value={`⭐ ${data.rating.toFixed(1)}`} />
        <Row label={t('detail.stock')} value={String(data.stock)} />
        <Text style={[styles.desc, { color: colors.subtext }]}>{data.description}</Text>
      </Card>
      <Button
        title={t('detail.addToCart')}
        testID="detail-add-to-cart"
        onPress={() => dispatch(addItem({ id: data.id, title: data.title, price: data.price }))}
      />
    </Screen>
  );
};

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  hero: { width: '100%', height: 220, borderRadius: radius.md, backgroundColor: '#00000010' },
  title: { fontSize: 20, fontWeight: '800' },
  price: { fontSize: 22, fontWeight: '800' },
  desc: { fontSize: 14, lineHeight: 20, marginTop: spacing.sm },
  error: { fontSize: 16, fontWeight: '700' },
});
