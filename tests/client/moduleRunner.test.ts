import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { type McpModule } from '@/client/models/types';
import { ModuleRunner } from '@/client/utils/moduleRunner';
import { type ToolRequest } from '@/shared/protocol';

const request = (
  module: string,
  method: string,
  args: Record<string, unknown> = {}
): ToolRequest => {
  return { args, id: 'req-1', method, module, type: 'tool_request' };
};

const makeNavigationModule = (): McpModule => {
  return {
    description: 'Screen navigation',
    name: 'navigation',
    tools: {
      go_back: {
        description: 'Go back',
        handler: () => {
          return { went: 'back' };
        },
      },
      navigate: {
        description: 'Navigate to a screen',
        handler: (args) => {
          return { screen: args.screen };
        },
        inputSchema: z.looseObject({ screen: z.string().describe('Route name') }),
        timeout: 5000,
      },
    },
  };
};

describe('ModuleRunner', () => {
  it('serializes registered modules into wire descriptors', () => {
    const runner = new ModuleRunner();
    runner.registerModules([makeNavigationModule()]);

    const descriptors = runner.getModuleDescriptors();
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]!.name).toBe('navigation');
    expect(descriptors[0]!.description).toBe('Screen navigation');

    const navigate = descriptors[0]!.tools.find((t) => {
      return t.name === 'navigate';
    })!;
    expect(navigate.description).toBe('Navigate to a screen');
    expect(navigate.timeout).toBe(5000);
    const schema = navigate.inputSchema as {
      properties: Record<string, { description?: string }>;
      required?: string[];
    };
    expect(schema.properties.screen?.description).toBe('Route name');
    expect(schema.required).toEqual(['screen']);

    // Schema-less tool serializes without an inputSchema.
    const goBack = descriptors[0]!.tools.find((t) => {
      return t.name === 'go_back';
    })!;
    expect(goBack.inputSchema).toBeUndefined();
  });

  it('routes a request to the module tool handler with its args', async () => {
    const runner = new ModuleRunner();
    runner.registerModules([makeNavigationModule()]);

    const result = await runner.handleRequest(
      request('navigation', 'navigate', { screen: 'CART' })
    );
    expect(result).toEqual({ screen: 'CART' });
  });

  it('routes dynamic tools by method name before module lookup', async () => {
    const runner = new ModuleRunner();
    runner.registerDynamicTool('logout', {
      description: 'Force logout',
      handler: () => {
        return { loggedOut: true };
      },
    });

    // Dynamic tools are stored by name only — the module part is not consulted.
    const result = await runner.handleRequest(request('__dynamic', 'logout'));
    expect(result).toEqual({ loggedOut: true });
  });

  it('throws for an unknown module and an unknown tool', async () => {
    const runner = new ModuleRunner();
    runner.registerModules([makeNavigationModule()]);

    await expect(runner.handleRequest(request('missing', 'navigate'))).rejects.toThrow(
      'Module "missing" not found'
    );
    await expect(runner.handleRequest(request('navigation', 'missing'))).rejects.toThrow(
      'Tool "missing" not found in module "navigation"'
    );
  });

  it('propagates a handler throw with its message', async () => {
    const runner = new ModuleRunner();
    runner.registerModules([
      {
        name: 'broken',
        tools: {
          explode: {
            description: 'Always throws',
            handler: () => {
              throw new Error('kaboom');
            },
          },
        },
      },
    ]);

    await expect(runner.handleRequest(request('broken', 'explode'))).rejects.toThrow('kaboom');
  });

  it('unregisters modules and dynamic tools', async () => {
    const runner = new ModuleRunner();
    runner.registerModules([makeNavigationModule()]);
    runner.registerDynamicTool('logout', {
      description: 'Force logout',
      handler: () => {
        return null;
      },
    });

    runner.unregisterModules(['navigation']);
    expect(runner.getModuleDescriptors()).toHaveLength(0);
    await expect(runner.handleRequest(request('navigation', 'navigate'))).rejects.toThrow(
      'Module "navigation" not found'
    );

    runner.unregisterDynamicTool('logout');
    // With the dynamic tool gone the lookup falls through to module routing.
    await expect(runner.handleRequest(request('__dynamic', 'logout'))).rejects.toThrow(
      'Module "__dynamic" not found'
    );
  });
});
