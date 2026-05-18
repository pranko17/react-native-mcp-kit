import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { jsonError, parseCallArgs, type ServerContext } from '@/server/helpers';
import {
  evalPredicate,
  isLeafPredicate,
  type LeafPredicate,
  type Predicate,
  resolvePath,
} from '@/server/predicate';
import { MODULE_SEPARATOR } from '@/shared/protocol';

export const registerAssertTool = (mcp: McpServer, ctx: ServerContext): void => {
  mcp.registerTool(
    'assert',
    {
      annotations: {
        openWorldHint: true,
        title: 'Assert',
      },
      description: `Single-shot assertion over a tool's result. Same predicate vocabulary (including { all / any / not }) as wait_until, but one attempt and a standardized diff on failure.

Returns { pass: true, actual? } on success — actual is the path-resolved value for leaf predicates, omitted for compound.
Returns { pass: false, actual, expected?, op?, path?, message?, result } on predicate failure.
Returns { pass: false, error, message? } when the tool dispatch itself threw.

Useful after wait_until as a checkpoint — the pair reads "do action → wait → assert" which produces a clean audit trail in session logs.`,
      inputSchema: {
        args: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .optional()
          .describe('Arguments for the asserted tool — object or JSON string.'),
        clientId: z.string().optional().describe('Target client ID, same semantics as `call`.'),
        message: z
          .string()
          .optional()
          .describe(
            'Optional human-readable description of the check; echoed in the failure payload.'
          ),
        predicate: z
          .looseObject({})
          .describe(
            'Leaf { op, path?, value? } or compound { all|any: [...] } / { not: predicate }. See wait_until for full semantics.'
          ),
        tool: z
          .string()
          .describe(`Tool name to call once (e.g. "fiber_tree${MODULE_SEPARATOR}query").`),
      },
    },
    async ({ args, clientId, message, predicate, tool }) => {
      const parsedArgs = parseCallArgs(args);
      if (!parsedArgs.ok) return jsonError(parsedArgs.error);
      const dispatch = await ctx.dispatchTool(tool, parsedArgs.args, clientId);
      if (!dispatch.ok) {
        return {
          content: [
            {
              text: JSON.stringify({ error: dispatch.error, message, pass: false }, null, 2),
              type: 'text' as const,
            },
          ],
        };
      }
      const pred = predicate as Predicate;
      const isLeaf = isLeafPredicate(pred);
      const leafPath = isLeaf ? (pred as LeafPredicate).path : undefined;
      const leafValue = isLeaf ? (pred as LeafPredicate).value : undefined;
      const leafOp = isLeaf ? (pred as LeafPredicate).op : undefined;
      const pass = evalPredicate(dispatch.result, pred);
      const payload: Record<string, unknown> = { pass };
      if (isLeaf) payload.actual = resolvePath(dispatch.result, leafPath);
      if (!pass) {
        if (isLeaf) {
          payload.expected = leafValue;
          payload.op = leafOp;
          if (leafPath) payload.path = leafPath;
        }
        if (message) payload.message = message;
        payload.result = dispatch.result;
      }
      return {
        content: [{ text: JSON.stringify(payload, null, 2), type: 'text' as const }],
      };
    }
  );
};
