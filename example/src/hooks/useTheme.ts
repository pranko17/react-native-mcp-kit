import { getColors, type ThemeColors, type ThemeName } from '../theme';
import { useAppSelector } from '../store';

// Theme is sourced from the Redux `settings` slice, so toggling it via
// `redux__dispatch({ type: 'settings/toggleTheme' })` re-themes the whole app.
export const useTheme = (): { theme: ThemeName; colors: ThemeColors } => {
  const theme = useAppSelector((state) => state.settings.theme);
  return { theme, colors: getColors(theme) };
};
