import { configureStore } from '@reduxjs/toolkit';
import { useDispatch, useSelector, type TypedUseSelectorHook } from 'react-redux';

import cart from './slices/cartSlice';
import counter from './slices/counterSlice';
import settings from './slices/settingsSlice';

// A vanilla Redux Toolkit store. `{ getState, dispatch }` structurally
// satisfies the library's `StoreLike`, so it goes straight into
// `<McpProvider store={store} />` and the agent gets `redux__get_state` /
// `redux__dispatch` against every slice below.
export const store = configureStore({
  reducer: { cart, counter, settings },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export const useAppDispatch = (): AppDispatch => useDispatch<AppDispatch>();
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
