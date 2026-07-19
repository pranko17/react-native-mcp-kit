import { describe, expect, it } from 'vitest';

import { type McpModule } from '@/client/models/types';
import { reduxModule, type ReduxAction, type StoreLike } from '@/modules/redux';

interface FakeStore {
  actions: ReduxAction[];
  store: StoreLike;
}

const makeFakeStore = (): FakeStore => {
  const actions: ReduxAction[] = [];
  let state: Record<string, unknown> = {
    auth: { token: 'abc', user: { email: 'a@b.c', id: 7 } },
    cart: { items: [{ id: 1 }, { id: 2 }], total: 2 },
  };
  const store: StoreLike = {
    dispatch: (action) => {
      actions.push(action);
      if (action.type === 'auth/setToken') {
        const auth = state.auth as Record<string, unknown>;
        state = { ...state, auth: { ...auth, token: action.payload } };
      }
      return action;
    },
    getState: () => {
      return state;
    },
  };
  return { actions, store };
};

const call = (mod: McpModule, tool: string, args: Record<string, unknown> = {}): unknown => {
  return mod.tools[tool]!.handler(args);
};

describe('reduxModule get_state', () => {
  it('projects at default depth 2 — slice fields inline, nested containers collapse to markers', () => {
    const mod = reduxModule(makeFakeStore().store);
    expect(call(mod, 'get_state')).toEqual({
      auth: { token: 'abc', user: { '${obj}': 2 } },
      cart: { items: { '${arr}': 2 }, total: 2 },
    });
  });

  it('lists slice names only at depth 1', () => {
    const mod = reduxModule(makeFakeStore().store);
    expect(call(mod, 'get_state', { depth: 1 })).toEqual({
      auth: { '${obj}': 2 },
      cart: { '${obj}': 2 },
    });
  });

  it('drills into a slice via path', () => {
    const mod = reduxModule(makeFakeStore().store);
    expect(call(mod, 'get_state', { path: 'auth.user.email' })).toBe('a@b.c');
  });
});

describe('reduxModule dispatch', () => {
  it('parses a JSON action string, dispatches it and reports the parsed action', () => {
    const { actions, store } = makeFakeStore();
    const mod = reduxModule(store);
    const result = call(mod, 'dispatch', {
      action: '{"type":"cart/addItem","payload":{"id":42}}',
    });
    expect(result).toEqual({
      action: { payload: { id: 42 }, type: 'cart/addItem' },
      success: true,
    });
    expect(actions).toEqual([{ payload: { id: 42 }, type: 'cart/addItem' }]);
  });

  it('exposes dispatched changes through get_state', () => {
    const { store } = makeFakeStore();
    const mod = reduxModule(store);
    call(mod, 'dispatch', { action: '{"type":"auth/setToken","payload":"xyz"}' });
    expect(call(mod, 'get_state', { path: 'auth.token' })).toBe('xyz');
  });

  it.each<[string, unknown]>([
    ['a non-string action', 42],
    ['a missing action', undefined],
    ['malformed JSON', '{"type":'],
    ['a JSON array', '[1,2]'],
    ['a JSON scalar', '"cart/clear"'],
    ['an object with a non-string type', '{"type":42}'],
    ['an object without a type', '{"payload":1}'],
  ])('returns an error for %s without dispatching', (_label, action) => {
    const { actions, store } = makeFakeStore();
    const mod = reduxModule(store);
    const result = call(mod, 'dispatch', { action }) as { error?: string };
    expect(result.error).toContain('dispatch.action must be a JSON object string');
    expect(actions).toEqual([]);
  });
});
