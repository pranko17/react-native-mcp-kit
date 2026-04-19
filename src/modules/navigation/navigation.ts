import { type McpModule } from '@/client/models/types';
import { findScreenFiberByRouteKey, getComponentName, getFiberRoot } from '@/modules/fiberTree';

import { type NavigationHistoryEntry, type NavigationRef, type NavigationState } from './types';

const MAX_HISTORY = 100;

const findFocusedRoute = (state: NavigationState): unknown => {
  const route = state.routes[state.index];
  if (!route) return null;
  if (route.state) {
    return {
      ...route,
      focusedChild: findFocusedRoute(route.state),
    };
  }
  return route;
};

const getCurrentRouteFromState = (
  state: NavigationState
): { key: string; name: string; params?: unknown } | null => {
  const route = state.routes[state.index];
  if (!route) return null;
  if (route.state) {
    return getCurrentRouteFromState(route.state);
  }
  return { key: route.key, name: route.name, params: route.params };
};

// Decorated view of the currently-focused screen — component name, and the
// mcpId / filePath / line of the first instrumented element rendered inside it.
// React Navigation injects `route` and `navigation` as props on the screen's
// root component (both for the `component={...}` API and the hook API), so we
// find the screen fiber by matching on route.key, then walk its descendants
// for the first data-mcp-id to surface a rendering-site reference.
interface ScreenInfo {
  componentName: string;
  filePath?: string;
  line?: number;
  mcpId?: string;
}

interface MinimalFiber {
  child?: MinimalFiber | null;
  memoizedProps?: Record<string, unknown> | null;
  sibling?: MinimalFiber | null;
}

const firstMcpIdDescendant = (fiber: MinimalFiber | null | undefined): string | undefined => {
  if (!fiber) return undefined;
  const id = fiber.memoizedProps?.['data-mcp-id'];
  if (typeof id === 'string' && id.length > 0) return id;
  let child = fiber.child;
  while (child) {
    const found = firstMcpIdDescendant(child);
    if (found) return found;
    child = child.sibling;
  }
  return undefined;
};

const parseMcpId = (mcpId: string | undefined): { filePath?: string; line?: number } => {
  if (!mcpId) return {};
  const parts = mcpId.split(':');
  if (parts.length < 3) return {};
  const last = parts[parts.length - 1]!;
  if (!/^\d+$/.test(last)) return {};
  const line = parseInt(last, 10);
  const filePath = parts.slice(1, -1).join(':');
  return { filePath: filePath || undefined, line };
};

const getScreenInfoForRouteKey = (routeKey: string | undefined): ScreenInfo | undefined => {
  if (!routeKey) return undefined;
  const root = getFiberRoot();
  if (!root) return undefined;
  const fiber = findScreenFiberByRouteKey(root, routeKey);
  if (!fiber) return undefined;

  const mcpId = firstMcpIdDescendant(fiber);
  const info: ScreenInfo = { componentName: getComponentName(fiber) };
  if (mcpId) info.mcpId = mcpId;
  const parsed = parseMcpId(mcpId);
  if (parsed.filePath) info.filePath = parsed.filePath;
  if (parsed.line !== undefined) info.line = parsed.line;
  return info;
};

export const navigationModule = (navigation: NavigationRef): McpModule => {
  console.log('Navigation module initialized');
  const history: NavigationHistoryEntry[] = [];

  const recordEntry = (rootState: NavigationState) => {
    const route = getCurrentRouteFromState(rootState);
    if (!route) return;

    const last = history[history.length - 1];
    if (last && last.route.key === route.key) return;

    history.push({
      route,
      state: rootState,
      timestamp: new Date().toISOString(),
    });

    if (history.length > MAX_HISTORY) {
      history.shift();
    }
  };

  const setup = () => {
    const rootState = navigation.getRootState() as NavigationState | undefined;
    if (rootState) recordEntry(rootState);

    navigation.addListener('state', () => {
      const state = navigation.getRootState() as NavigationState | undefined;
      if (state) recordEntry(state);
    });
  };

  const waitForReady = () => {
    if (navigation.isReady?.() ?? true) {
      setup();
      return;
    }
    setTimeout(waitForReady, 100);
  };

  waitForReady();

  // Decorate a route dict from React Navigation with a `screen` field describing
  // the React component rendering it — gives agents a direct path to inspect
  // or drive that screen via fiber_tree without a separate lookup step.
  const withScreenInfo = <T extends { key?: unknown } | null | undefined>(
    route: T
  ): T extends null | undefined ? T : T & { screen?: ScreenInfo } => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!route) return route as any;
    const key = typeof route.key === 'string' ? route.key : undefined;
    const screen = getScreenInfoForRouteKey(key);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (screen ? { ...route, screen } : route) as any;
  };

  return {
    description: `React Navigation control + 100-entry transition history.

SCREEN ENRICHMENT
  get_current_route and get_current_route_state include a \`screen\` field
  pointing at the React component rendering the focused route:
    screen: { componentName, mcpId?, filePath?, line? }
  componentName is the developer's component (RN Navigation wrappers are
  skipped). mcpId / filePath / line come from the first data-mcp-id inside
  the screen — the rendering site, ready for fiber_tree follow-ups.`,
    name: 'navigation',
    tools: {
      get_current_route: {
        description:
          'Focused route name, params, and a `screen` field for the rendering component.',
        handler: () => {
          return withScreenInfo(navigation.getCurrentRoute() as { key?: unknown } | null);
        },
      },
      get_current_route_state: {
        description:
          'Full state of the focused route — params, key, nested navigator state, and a `screen` field with rendering component info.',
        handler: () => {
          const rootState = navigation.getRootState() as NavigationState | undefined;
          if (!rootState) return { error: 'No navigation state available' };
          return withScreenInfo(findFocusedRoute(rootState) as { key?: unknown } | null);
        },
      },
      get_history: {
        description:
          'Screen transition log (up to 100 entries) with timestamps. Pass full:true for per-entry navigation state.',
        handler: (args) => {
          const offset = (args.offset as number) ?? 0;
          const limit = (args.limit as number) ?? 50;
          const full = (args.full as boolean) ?? false;

          const slice = history.slice(offset, offset + limit);

          if (full) {
            return { entries: slice, offset, total: history.length };
          }

          return {
            entries: slice.map((entry) => {
              return {
                key: entry.route.key,
                name: entry.route.name,
                params: entry.route.params,
                timestamp: entry.timestamp,
              };
            }),
            offset,
            total: history.length,
          };
        },
        inputSchema: {
          full: {
            description: 'Include full navigation state per entry (default: false).',
            type: 'boolean',
          },
          limit: { description: 'Max entries to return (default: 50).', type: 'number' },
          offset: { description: 'Start index (default: 0).', type: 'number' },
        },
      },
      get_state: {
        description: 'Full navigation state tree.',
        handler: () => {
          return navigation.getRootState();
        },
      },
      go_back: {
        description: 'Go back to the previous screen.',
        handler: () => {
          if (navigation.canGoBack()) {
            navigation.goBack();
            return { success: true };
          }
          return { reason: 'Cannot go back', success: false };
        },
      },
      navigate: {
        description: 'Navigate to a screen — reuses it if already in the stack.',
        handler: (args) => {
          navigation.navigate(args.screen as string, args.params as Record<string, unknown>);
          return {
            currentRoute: withScreenInfo(navigation.getCurrentRoute() as { key?: unknown } | null),
            success: true,
          };
        },
        inputSchema: {
          params: { description: 'Optional route params.', type: 'object' },
          screen: { description: 'Screen name to navigate to.', type: 'string' },
        },
      },
      pop: {
        description: 'Pop one or more screens off the stack.',
        handler: (args) => {
          const count = (args.count as number) || 1;
          navigation.dispatch({ payload: { count }, type: 'POP' });
          return {
            currentRoute: withScreenInfo(navigation.getCurrentRoute() as { key?: unknown } | null),
            success: true,
          };
        },
        inputSchema: {
          count: { description: 'Screens to pop (default: 1).', type: 'number' },
        },
      },
      pop_to: {
        description: 'Pop back to a specific screen.',
        handler: (args) => {
          navigation.dispatch({
            payload: { name: args.screen as string, params: args.params },
            type: 'POP_TO',
          });
          return {
            currentRoute: withScreenInfo(navigation.getCurrentRoute() as { key?: unknown } | null),
            success: true,
          };
        },
        inputSchema: {
          params: { description: 'Optional route params.', type: 'object' },
          screen: { description: 'Screen name to pop back to.', type: 'string' },
        },
      },
      pop_to_top: {
        description: 'Pop to the first screen in the stack.',
        handler: () => {
          navigation.dispatch({ type: 'POP_TO_TOP' });
          return {
            currentRoute: withScreenInfo(navigation.getCurrentRoute() as { key?: unknown } | null),
            success: true,
          };
        },
      },
      push: {
        description: 'Push a new screen — always adds a new stack entry, even for duplicates.',
        handler: (args) => {
          navigation.dispatch({
            payload: { name: args.screen as string, params: args.params },
            type: 'PUSH',
          });
          return {
            currentRoute: withScreenInfo(navigation.getCurrentRoute() as { key?: unknown } | null),
            success: true,
          };
        },
        inputSchema: {
          params: { description: 'Optional route params.', type: 'object' },
          screen: { description: 'Screen name to push.', type: 'string' },
        },
      },
      replace: {
        description: 'Replace the current screen with a new one.',
        handler: (args) => {
          navigation.dispatch({
            payload: { name: args.screen as string, params: args.params },
            type: 'REPLACE',
          });
          return {
            currentRoute: withScreenInfo(navigation.getCurrentRoute() as { key?: unknown } | null),
            success: true,
          };
        },
        inputSchema: {
          params: { description: 'Optional route params.', type: 'object' },
          screen: { description: 'Screen name to replace with.', type: 'string' },
        },
      },
      reset: {
        description: 'Reset the current navigator state to a specified routes list.',
        handler: (args) => {
          const routes = args.routes as Array<{ name: string; params?: Record<string, unknown> }>;
          const index = (args.index as number) ?? routes.length - 1;
          navigation.dispatch({
            payload: {
              index,
              routes: routes.map((r) => {
                return { name: r.name, params: r.params };
              }),
            },
            type: 'RESET',
          });
          return {
            currentRoute: withScreenInfo(navigation.getCurrentRoute() as { key?: unknown } | null),
            success: true,
          };
        },
        inputSchema: {
          index: { description: 'Active route index (default: last).', type: 'number' },
          routes: {
            description: 'Routes list.',
            examples: [[{ name: 'Home' }, { name: 'Profile', params: { id: 42 } }]],
            type: 'array',
          },
        },
      },
    },
  };
};
