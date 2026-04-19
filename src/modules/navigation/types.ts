export interface NavigationRoute {
  key: string;
  name: string;
  params?: unknown;
  state?: NavigationState;
}

export interface NavigationState {
  index: number;
  routes: NavigationRoute[];
}

export interface NavigationAction {
  type: string;
  payload?: Record<string, unknown>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// Structural shape the navigation module depends on. Kept intentionally loose
// (any on each call shape) so React Navigation's own `NavigationContainerRef`
// generics stay assignable without the caller needing a `as never` cast.
export interface NavigationRef {
  addListener: (event: any, callback: any) => () => void;
  canGoBack: () => boolean;
  dispatch: (action: any) => void;
  getCurrentRoute: () => unknown;
  getRootState: () => unknown;
  goBack: () => void;
  navigate: (...args: any[]) => void;
  resetRoot: (...args: any[]) => void;
  isReady?: () => boolean;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface NavigationHistoryEntry {
  route: {
    key: string;
    name: string;
    params?: unknown;
  };
  timestamp: string;
  state?: NavigationState;
}
