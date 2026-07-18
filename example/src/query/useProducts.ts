import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { fetchProduct, fetchProducts, type Product, type ProductsResponse } from './api';

// Named query hooks. Because the test-id babel plugin annotates `use*`
// functions, `fiber_tree__query select:["hooks"]` recovers these by name
// (e.g. `products`) instead of opaque `State[0]`.
export const productsQueryKey = (limit: number): readonly unknown[] => ['products', { limit }];
export const productQueryKey = (id: number): readonly unknown[] => ['product', id];

export const useProducts = (limit = 20): UseQueryResult<ProductsResponse> => {
  return useQuery({
    queryKey: productsQueryKey(limit),
    queryFn: () => fetchProducts(limit),
  });
};

export const useProduct = (id: number): UseQueryResult<Product> => {
  return useQuery({
    queryKey: productQueryKey(id),
    queryFn: () => fetchProduct(id),
    enabled: Number.isFinite(id),
  });
};
