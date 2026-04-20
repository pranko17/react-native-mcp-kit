import { type HostToolHandler } from '@/server/host/types';
import { MODULE_SEPARATOR } from '@/shared/protocol';

interface QueryMatch {
  bounds?: { centerX: number; centerY: number } | null;
  mcpId?: string;
  name?: string;
  testID?: string;
}

interface QueryResult {
  matches?: QueryMatch[];
  total?: number;
}

const TAP_FIBER_TIMEOUT_MS = 10_000;

export const tapFiberTool = (): HostToolHandler => {
  return {
    description: `Locate a fiber via fiber_tree__query and tap its center through host__tap — one round-trip instead of two.

Requires exactly one resolved match after the chain. Pass \`index\` when the chain legitimately yields multiple and you want the Nth (0-based). When ambiguous without \`index\`, returns a candidate list with bounds so you can narrow \`steps\` or pick an index.

Returns { tapped: true, mcpId?, name, testID?, bounds, device } on success.
On ambiguity: { error: "N matches...", candidates: [...], total }.
On no match: { error: "no match for given steps", total: 0 }.
On unmounted: { error: "fiber has no measurable host view", mcpId?, name }.`,
    handler: async (args, ctx) => {
      const steps = args.steps as unknown;
      if (!Array.isArray(steps) || steps.length === 0) {
        return { error: 'tap_fiber requires a non-empty `steps` array.' };
      }
      const clientId = (args.clientId as string | undefined) ?? ctx.requestedClientId;
      const index = args.index as number | undefined;

      const queryResult = await ctx.dispatch(
        `fiber_tree${MODULE_SEPARATOR}query`,
        { limit: 10, select: ['bounds', 'mcpId', 'name', 'testID'], steps },
        clientId
      );
      if (!queryResult.ok) {
        return { error: `fiber_tree__query failed: ${queryResult.error}` };
      }
      const result = queryResult.result as QueryResult;
      const matches = result.matches ?? [];
      if (matches.length === 0) {
        return { error: 'no match for given steps', total: result.total ?? 0 };
      }
      if (matches.length > 1 && typeof index !== 'number') {
        return {
          candidates: matches.map((m) => {
            return {
              bounds: m.bounds ?? null,
              mcpId: m.mcpId,
              name: m.name,
              testID: m.testID,
            };
          }),
          error: `${matches.length} matches — pass \`index\` or narrow \`steps\`.`,
          total: result.total ?? matches.length,
        };
      }
      const pick = matches[typeof index === 'number' ? index : 0];
      if (!pick) {
        return { error: `index ${index} out of range (have ${matches.length}).` };
      }
      if (!pick.bounds) {
        return {
          error: 'fiber has no measurable host view — likely unmounted / virtualized.',
          mcpId: pick.mcpId,
          name: pick.name,
        };
      }

      const tapResult = await ctx.dispatch(
        `host${MODULE_SEPARATOR}tap`,
        { x: pick.bounds.centerX, y: pick.bounds.centerY },
        clientId
      );
      if (!tapResult.ok) {
        return { error: `host__tap failed: ${tapResult.error}` };
      }

      return {
        bounds: pick.bounds,
        device: (tapResult.result as { device?: unknown }).device,
        mcpId: pick.mcpId,
        name: pick.name,
        tapped: true,
        testID: pick.testID,
      };
    },
    inputSchema: {
      clientId: {
        description: 'Target client ID (optional when one client is connected).',
        type: 'string',
      },
      index: {
        description: 'Pick the Nth match when the chain returns multiple (0-based).',
        type: 'number',
      },
      steps: {
        description: 'Same shape as fiber_tree__query steps — ordered criteria + optional scope.',
        examples: [[{ testID: 'searchBar' }], [{ name: 'HomeScreen' }, { testID: 'addToCartBtn' }]],
        type: 'array',
      },
    },
    timeout: TAP_FIBER_TIMEOUT_MS,
  };
};
