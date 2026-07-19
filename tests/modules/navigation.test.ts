import { describe, expect, it, vi } from 'vitest';

import { type McpModule } from '@/client/models/types';
import { navigationModule, type NavigationRef } from '@/modules/navigation';
import { type NavigationRoute, type NavigationState } from '@/modules/navigation/types';

interface RecordedCall {
  args: unknown[];
  method: string;
}

interface FakeNavigation {
  calls: RecordedCall[];
  ref: NavigationRef;
  setState: (next: NavigationState) => void;
}

const focusedRoute = (state: NavigationState): NavigationRoute | null => {
  const route = state.routes[state.index];
  if (!route) return null;
  return route.state ? focusedRoute(route.state) : route;
};

const makeFakeNavigation = (initialState: NavigationState): FakeNavigation => {
  const calls: RecordedCall[] = [];
  const listeners: Array<() => void> = [];
  let state = initialState;
  const ref: NavigationRef = {
    addListener: (_event, callback) => {
      listeners.push(callback as () => void);
      return () => {};
    },
    canGoBack: () => {
      return state.routes.length > 1;
    },
    dispatch: (action) => {
      calls.push({ args: [action], method: 'dispatch' });
    },
    getCurrentRoute: () => {
      return focusedRoute(state);
    },
    getRootState: () => {
      return state;
    },
    goBack: () => {
      calls.push({ args: [], method: 'goBack' });
    },
    isReady: () => {
      return true;
    },
    navigate: (...args) => {
      calls.push({ args, method: 'navigate' });
    },
    resetRoot: () => {},
  };
  return {
    calls,
    ref,
    setState: (next) => {
      state = next;
      for (const listener of listeners) {
        listener();
      }
    },
  };
};

const homeState = (): NavigationState => {
  return { index: 0, routes: [{ key: 'home-1', name: 'Home' }] };
};

const stackState = (): NavigationState => {
  return {
    index: 1,
    routes: [
      { key: 'home-1', name: 'Home' },
      { key: 'details-1', name: 'Details', params: { id: 42 } },
    ],
  };
};

const nestedState = (): NavigationState => {
  return {
    index: 1,
    routes: [
      { key: 'home-1', name: 'Home' },
      {
        key: 'app-1',
        name: 'App',
        state: {
          index: 1,
          routes: [
            { key: 'feed-1', name: 'Feed' },
            { key: 'cart-1', name: 'Cart', params: { items: 2 } },
          ],
        },
      },
    ],
  };
};

const call = (mod: McpModule, tool: string, args: Record<string, unknown> = {}): unknown => {
  return mod.tools[tool]!.handler(args);
};

describe('navigationModule navigate', () => {
  it('reuse mode calls navigation.navigate and returns the current route', () => {
    const nav = makeFakeNavigation(stackState());
    const mod = navigationModule(nav.ref);
    const result = call(mod, 'navigate', { params: { id: 7 }, screen: 'Profile' });
    expect(nav.calls).toContainEqual({ args: ['Profile', { id: 7 }], method: 'navigate' });
    expect(result).toMatchObject({
      currentRoute: { key: 'details-1', name: 'Details' },
      mode: 'reuse',
      success: true,
    });
  });

  it('push mode dispatches a PUSH action', () => {
    const nav = makeFakeNavigation(stackState());
    const mod = navigationModule(nav.ref);
    call(mod, 'navigate', { mode: 'push', params: { id: 1 }, screen: 'Profile' });
    expect(nav.calls).toContainEqual({
      args: [{ payload: { name: 'Profile', params: { id: 1 } }, type: 'PUSH' }],
      method: 'dispatch',
    });
  });

  it('replace mode dispatches a REPLACE action', () => {
    const nav = makeFakeNavigation(stackState());
    const mod = navigationModule(nav.ref);
    call(mod, 'navigate', { mode: 'replace', screen: 'Profile' });
    expect(nav.calls).toContainEqual({
      args: [{ payload: { name: 'Profile', params: undefined }, type: 'REPLACE' }],
      method: 'dispatch',
    });
  });

  it('rejects an unknown mode without touching the ref', () => {
    const nav = makeFakeNavigation(stackState());
    const mod = navigationModule(nav.ref);
    const result = call(mod, 'navigate', { mode: 'sideways', screen: 'Profile' }) as {
      error?: string;
    };
    expect(result.error).toContain('navigate.mode must be');
    expect(nav.calls).toEqual([]);
  });
});

describe('navigationModule pop', () => {
  it('pops one screen when `to` is omitted', () => {
    const nav = makeFakeNavigation(stackState());
    const mod = navigationModule(nav.ref);
    const result = call(mod, 'pop');
    expect(nav.calls).toContainEqual({
      args: [{ payload: { count: 1 }, type: 'POP' }],
      method: 'dispatch',
    });
    expect(result).toMatchObject({ success: true });
  });

  it('pops N screens for a numeric `to`', () => {
    const nav = makeFakeNavigation(stackState());
    const mod = navigationModule(nav.ref);
    call(mod, 'pop', { to: 3 });
    expect(nav.calls).toContainEqual({
      args: [{ payload: { count: 3 }, type: 'POP' }],
      method: 'dispatch',
    });
  });

  it('pops back to a named screen with params', () => {
    const nav = makeFakeNavigation(stackState());
    const mod = navigationModule(nav.ref);
    call(mod, 'pop', { params: { tab: 'x' }, to: 'Home' });
    expect(nav.calls).toContainEqual({
      args: [{ payload: { name: 'Home', params: { tab: 'x' } }, type: 'POP_TO' }],
      method: 'dispatch',
    });
  });

  it('pops to the first screen for `to: "top"`', () => {
    const nav = makeFakeNavigation(stackState());
    const mod = navigationModule(nav.ref);
    call(mod, 'pop', { to: 'top' });
    expect(nav.calls).toContainEqual({ args: [{ type: 'POP_TO_TOP' }], method: 'dispatch' });
  });

  it('rejects a non-number, non-string `to`', () => {
    const nav = makeFakeNavigation(stackState());
    const mod = navigationModule(nav.ref);
    const result = call(mod, 'pop', { to: true }) as { error?: string };
    expect(result.error).toContain('pop.to must be a number');
  });
});

describe('navigationModule go_back', () => {
  it('goes back when possible', () => {
    const nav = makeFakeNavigation(stackState());
    const mod = navigationModule(nav.ref);
    expect(call(mod, 'go_back')).toEqual({ success: true });
    expect(nav.calls).toContainEqual({ args: [], method: 'goBack' });
  });

  it('reports failure when there is nothing to pop', () => {
    const nav = makeFakeNavigation(homeState());
    const mod = navigationModule(nav.ref);
    expect(call(mod, 'go_back')).toEqual({ reason: 'Cannot go back', success: false });
    expect(nav.calls).toEqual([]);
  });
});

describe('navigationModule reset', () => {
  it('dispatches RESET with the index defaulting to the last route', () => {
    const nav = makeFakeNavigation(stackState());
    const mod = navigationModule(nav.ref);
    call(mod, 'reset', { routes: [{ name: 'Home' }, { name: 'Profile', params: { id: 2 } }] });
    expect(nav.calls).toContainEqual({
      args: [
        {
          payload: {
            index: 1,
            routes: [
              { name: 'Home', params: undefined },
              { name: 'Profile', params: { id: 2 } },
            ],
          },
          type: 'RESET',
        },
      ],
      method: 'dispatch',
    });
  });

  it('honours an explicit index', () => {
    const nav = makeFakeNavigation(stackState());
    const mod = navigationModule(nav.ref);
    call(mod, 'reset', { index: 0, routes: [{ name: 'Home' }, { name: 'Profile' }] });
    const dispatched = nav.calls.find((c) => c.method === 'dispatch')!.args[0] as {
      payload: { index: number };
    };
    expect(dispatched.payload.index).toBe(0);
  });
});

describe('navigationModule get_current_route', () => {
  it('returns the deepest focused route', () => {
    const nav = makeFakeNavigation(nestedState());
    const mod = navigationModule(nav.ref);
    expect(call(mod, 'get_current_route')).toEqual({
      key: 'cart-1',
      name: 'Cart',
      params: { items: 2 },
    });
  });

  it('withState:true returns the focused branch with nested focusedChild', () => {
    const nav = makeFakeNavigation(nestedState());
    const mod = navigationModule(nav.ref);
    expect(call(mod, 'get_current_route', { withState: true })).toMatchObject({
      focusedChild: { key: 'cart-1', name: 'Cart' },
      key: 'app-1',
      name: 'App',
    });
  });
});

describe('navigationModule get_state', () => {
  it('projects at the default depth 2 — routes visible, route objects collapsed', () => {
    const nav = makeFakeNavigation(stackState());
    const mod = navigationModule(nav.ref);
    expect(call(mod, 'get_state')).toEqual({
      index: 1,
      routes: [{ '${obj}': 2 }, { '${obj}': 3 }],
    });
  });

  it('expands route names at depth 3', () => {
    const nav = makeFakeNavigation(stackState());
    const mod = navigationModule(nav.ref);
    expect(call(mod, 'get_state', { depth: 3 })).toMatchObject({
      routes: [{ name: 'Home' }, { name: 'Details' }],
    });
  });
});

describe('navigationModule get_history', () => {
  it('records the initial route on setup and transitions on state events', () => {
    const nav = makeFakeNavigation(homeState());
    const mod = navigationModule(nav.ref);
    nav.setState(stackState());
    const history = call(mod, 'get_history') as {
      entries: Array<{ route: { name: string }; timestamp: string }>;
      total: number;
    };
    expect(history.total).toBe(2);
    expect(history.entries.map((e) => e.route.name)).toEqual(['Home', 'Details']);
    expect(new Date(history.entries[0]!.timestamp).toISOString()).toBe(
      history.entries[0]!.timestamp
    );
  });

  it('deduplicates consecutive entries with the same focused route key', () => {
    const nav = makeFakeNavigation(homeState());
    const mod = navigationModule(nav.ref);
    nav.setState(stackState());
    nav.setState(stackState());
    expect(call(mod, 'get_history', { path: 'total' })).toBe(2);
  });

  it('trims the log to the last 100 entries', () => {
    const nav = makeFakeNavigation(homeState());
    const mod = navigationModule(nav.ref);
    for (let i = 0; i < 110; i += 1) {
      nav.setState({ index: 0, routes: [{ key: `r${i}`, name: `r${i}` }] });
    }
    expect(call(mod, 'get_history', { path: 'total' })).toBe(100);
    expect(call(mod, 'get_history', { path: 'entries[0].route.name' })).toBe('r10');
  });

  it('defers history capture until the ref reports ready', () => {
    vi.useFakeTimers();
    try {
      let ready = false;
      const nav = makeFakeNavigation(homeState());
      const ref: NavigationRef = {
        ...nav.ref,
        isReady: () => {
          return ready;
        },
      };
      const mod = navigationModule(ref);
      expect(call(mod, 'get_history', { path: 'total' })).toBe(0);
      ready = true;
      vi.advanceTimersByTime(100);
      expect(call(mod, 'get_history', { path: 'total' })).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
