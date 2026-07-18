export type ThemeName = 'light' | 'dark';

export interface ThemeColors {
  bg: string;
  card: string;
  border: string;
  text: string;
  subtext: string;
  primary: string;
  primaryText: string;
  danger: string;
  success: string;
  warning: string;
  accent: string;
}

const light: ThemeColors = {
  bg: '#f2f3f7',
  card: '#ffffff',
  border: '#e2e4ea',
  text: '#16181d',
  subtext: '#6b7280',
  primary: '#4f46e5',
  primaryText: '#ffffff',
  danger: '#dc2626',
  success: '#16a34a',
  warning: '#d97706',
  accent: '#0ea5e9',
};

const dark: ThemeColors = {
  bg: '#0c0d10',
  card: '#16181d',
  border: '#262a33',
  text: '#f3f4f6',
  subtext: '#9aa3b2',
  primary: '#818cf8',
  primaryText: '#0c0d10',
  danger: '#f87171',
  success: '#4ade80',
  warning: '#fbbf24',
  accent: '#38bdf8',
};

export const getColors = (theme: ThemeName): ThemeColors => {
  return theme === 'dark' ? dark : light;
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 };
