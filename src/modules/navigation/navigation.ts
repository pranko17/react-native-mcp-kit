import { type McpModule } from '@/client/models/types';
import { findScreenFiberByRouteKey, getComponentName, getFiberRoot } from '@/modules/fiberTree';
import {
  applyProjection,
  makeProjectionSchema,
  projectAsValue,
  type ProjectionArgs,
} from '@/shared/projectValue';

import { type NavigationHistoryEntry, type NavigationRef, type NavigationState } from './types';

const MAX_HISTORY = 100;

// `get_state` returns the full nested navigator tree — can be deeply nested.
// Default depth 2 — top-level expanded, route children collapse to markers.
const STATE_DEFAULT_DEPTH = 2;

// `get_history` returns { entries: [...], total }. Default depth 4 — outer
// expanded, entries array expanded, each entry expanded (route/state/timestamp
// visible), nested state collapses to a marker. Drill via path.
const HISTORY_DEFAULT_DEPTH = 4;

// `get_current_route` / `get_current_route_state` return a route dict with
// optional nested state. Default depth 3 — name/params/screen visible,
// nested state markers; drill if you need deeper.
const ROUTE_DEFAULT_DEPTH = 3;

const STATE_SCHEMA = makeProjectionSchema(STATE_DEFAULT_DEPTH);
const HISTORY_SCHEMA = makeProjectionSchema(HISTORY_DEFAULT_DEPTH);
const ROUTE_SCHEMA = makeProjectionSchema(ROUTE_DEFAULT_DEPTH);

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
  the screen — the rendering site, ready for fiber_tree follow-ups.

PROJECTION
  get_state / get_history / get_current_route / get_current_route_state
  accept the standard \`path\` / \`depth\` / \`maxBytes\` projection args.
  get_state defaults to depth ${STATE_DEFAULT_DEPTH} (top expanded, route children collapsed),
  get_history to depth ${HISTORY_DEFAULT_DEPTH} (entries' route/state/timestamp visible, nested
  state collapsed), routes to depth ${ROUTE_DEFAULT_DEPTH}. Drill via path:
    navigation__get_state({ path: 'routes[0].state' })
    navigation__get_history({ path: 'entries[-1:][0].state' })`,
    name: 'navigation',
    tools: {
      get_current_route: {
        description:
          'Focused route name, params, and a `screen` field for the rendering component.',
        handler: (args) => {
          const route = withScreenInfo(navigation.getCurrentRoute() as { key?: unknown } | null);
          return applyProjection(
            route,
            args as ProjectionArgs,
            projectAsValue,
            ROUTE_DEFAULT_DEPTH
          );
        },
        inputSchema: ROUTE_SCHEMA,
      },
      get_current_route_state: {
        description:
          'Full state of the focused route — params, key, nested navigator state, and a `screen` field with rendering component info.',
        handler: (args) => {
          const rootState = navigation.getRootState() as NavigationState | undefined;
          if (!rootState) return { error: 'No navigation state available' };
          const focused = withScreenInfo(findFocusedRoute(rootState) as { key?: unknown } | null);
          return applyProjection(
            focused,
            args as ProjectionArgs,
            projectAsValue,
            ROUTE_DEFAULT_DEPTH
          );
        },
        inputSchema: ROUTE_SCHEMA,
      },
      get_history: {
        description:
          'Screen transition log (up to 100 entries, oldest first) with timestamps. Each entry carries `route`, full root `state`, `timestamp`. State collapses to a marker by default — drill via path or bump depth.',
        handler: (args) => {
          const result = { entries: history, total: history.length };
          return applyProjection(
            result,
            args as ProjectionArgs,
            projectAsValue,
            HISTORY_DEFAULT_DEPTH
          );
        },
        inputSchema: HISTORY_SCHEMA,
      },
      get_state: {
        description: 'Full navigation state tree.',
        handler: (args) => {
          const state = navigation.getRootState();
          return applyProjection(
            state,
            args as ProjectionArgs,
            projectAsValue,
            STATE_DEFAULT_DEPTH
          );
        },
        inputSchema: STATE_SCHEMA,
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
