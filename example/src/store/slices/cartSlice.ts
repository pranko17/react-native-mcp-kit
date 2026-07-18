import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface CartItem {
  id: number;
  title: string;
  price: number;
  qty: number;
}

export interface CartState {
  items: CartItem[];
}

const initialState: CartState = { items: [] };

const cartSlice = createSlice({
  name: 'cart',
  initialState,
  reducers: {
    addItem: (state, action: PayloadAction<Omit<CartItem, 'qty'> & { qty?: number }>) => {
      const existing = state.items.find((item) => item.id === action.payload.id);
      if (existing) {
        existing.qty += action.payload.qty ?? 1;
      } else {
        state.items.push({ ...action.payload, qty: action.payload.qty ?? 1 });
      }
    },
    removeItem: (state, action: PayloadAction<number>) => {
      state.items = state.items.filter((item) => item.id !== action.payload);
    },
    changeQty: (state, action: PayloadAction<{ id: number; qty: number }>) => {
      const item = state.items.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      item.qty = Math.max(0, action.payload.qty);
      if (item.qty === 0) {
        state.items = state.items.filter((entry) => entry.id !== action.payload.id);
      }
    },
    clearCart: (state) => {
      state.items = [];
    },
  },
});

export const { addItem, removeItem, changeQty, clearCart } = cartSlice.actions;
export default cartSlice.reducer;
