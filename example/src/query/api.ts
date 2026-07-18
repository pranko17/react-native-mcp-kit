// Tiny API client hitting the public dummyjson.com endpoints. Every call goes
// through `fetch`, so the `network` module captures method / url / status /
// duration / headers / bodies automatically.

export interface Product {
  id: number;
  title: string;
  description: string;
  price: number;
  rating: number;
  stock: number;
  brand?: string;
  category: string;
  thumbnail: string;
}

export interface ProductsResponse {
  products: Product[];
  total: number;
  skip: number;
  limit: number;
}

export const API_BASE = 'https://dummyjson.com';

export const fetchProducts = async (limit = 20): Promise<ProductsResponse> => {
  const response = await fetch(`${API_BASE}/products?limit=${limit}&select=title,description,price,rating,stock,brand,category,thumbnail`);
  if (!response.ok) {
    throw new Error(`Failed to load products (HTTP ${response.status})`);
  }
  return response.json() as Promise<ProductsResponse>;
};

export const fetchProduct = async (id: number): Promise<Product> => {
  const response = await fetch(`${API_BASE}/products/${id}`);
  if (!response.ok) {
    throw new Error(`Failed to load product ${id} (HTTP ${response.status})`);
  }
  return response.json() as Promise<Product>;
};
