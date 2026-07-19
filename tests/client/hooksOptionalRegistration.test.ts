import { describe, expectTypeOf, it } from 'vitest';

import { type useMcpModule } from '@/client/hooks/useMcpModule';
import { type useMcpTool } from '@/client/hooks/useMcpTool';
import { type McpModule, type ToolHandler } from '@/client/models/types';

// Hooks can't run outside a React renderer, and importing them at runtime
// pulls `react` (a peer the lib doesn't install) — so the optional-
// registration contract is pinned purely at the type level: the type-only
// imports above erase at compile time.
type UseMcpTool = typeof useMcpTool;
type UseMcpModule = typeof useMcpModule;

describe('hooks — optional registration signatures', () => {
  it('useMcpTool accepts null / undefined factories and null-returning factories', () => {
    expectTypeOf<UseMcpTool>().toBeCallableWith('name', null, []);
    expectTypeOf<UseMcpTool>().toBeCallableWith('name', undefined, []);
    expectTypeOf<UseMcpTool>().toBeCallableWith(
      'name',
      () => {
        return null;
      },
      []
    );
    expectTypeOf<UseMcpTool>().toBeCallableWith(
      'name',
      (): ToolHandler => {
        return {
          description: 'd',
          handler: () => {
            return null;
          },
        };
      },
      []
    );
  });

  it('useMcpModule accepts null / undefined factories and null-returning factories', () => {
    expectTypeOf<UseMcpModule>().toBeCallableWith(null, []);
    expectTypeOf<UseMcpModule>().toBeCallableWith(undefined, []);
    expectTypeOf<UseMcpModule>().toBeCallableWith(() => {
      return null;
    }, []);
    expectTypeOf<UseMcpModule>().toBeCallableWith((): McpModule => {
      return { name: 'm', tools: {} };
    }, []);
  });
});
