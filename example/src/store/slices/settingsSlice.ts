import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import { type ThemeName } from '../../theme';

export interface SettingsState {
  theme: ThemeName;
  notificationsEnabled: boolean;
  displayName: string;
}

const initialState: SettingsState = {
  theme: 'light',
  notificationsEnabled: true,
  displayName: 'Guest',
};

const settingsSlice = createSlice({
  name: 'settings',
  initialState,
  reducers: {
    toggleTheme: (state) => {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
    },
    setTheme: (state, action: PayloadAction<ThemeName>) => {
      state.theme = action.payload;
    },
    setNotifications: (state, action: PayloadAction<boolean>) => {
      state.notificationsEnabled = action.payload;
    },
    setDisplayName: (state, action: PayloadAction<string>) => {
      state.displayName = action.payload;
    },
  },
});

export const { toggleTheme, setTheme, setNotifications, setDisplayName } = settingsSlice.actions;
export default settingsSlice.reducer;
