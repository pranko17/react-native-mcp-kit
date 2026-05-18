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

export const registerWaitUntilTool = (mcp: McpServer, ctx: ServerContext): void => {
  mcp.registerTool(
    'wait_until',
    {
      annotations: {
        openWorldHint: true,
        title: 'Wait Until',
      },
      description: `Poll a tool until its result satisfies a predicate, or timeout.

Replaces "screenshot in a loop + sleep" with a declarative check. Typical use:
  • wait for navigation to land on a screen
  • wait for a spinner / toast to disappear
  • wait for a fiber_tree.query to return matches (or stop returning them)
  • wait for network.get_requests({ status: "pending" }).length to hit 0

PREDICATE
  Leaf form: { op, path?, value? }
    op: equals | notEquals | contains | notContains | exists | notExists | gt | gte | lt | lte
    path drills through objects + array indices; arrays also expose .length.
  Compound forms compose and nest:
    { all: [predicate, ...] }   — AND
    { any: [predicate, ...] }   — OR
    { not: predicate }          — negation
  Example: { all: [{op:"equals", path:"name", value:"CART"}, {op:"gt", path:"items.length", value:0}] }

RETURNS
  { ok: true, attempts, elapsedMs, matched? } on success — matched is the path-
    resolved value for leaf predicates, omitted for compound.
  { ok: false, reason, attempts, elapsedMs, lastResult, lastError? } on timeout.`,
      inputSchema: {
        args: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .optional()
          .describe('Arguments for the polled tool — object or JSON string.'),
        clientId: z.string().optional().describe('Target client ID, same semantics as `call`.'),
        intervalMs: z
          .number()
          .optional()
          .describe('Delay between poll attempts. Default 300, min 50, max 5000.'),
        predicate: z
          .looseObject({})
          .describe(
            'Leaf { op, path?, value? } or compound { all|any: [...] } / { not: predicate }. See tool description for ops and composition.'
          ),
        timeoutMs: z
          .number()
          .optional()
          .describe('Total wait budget. Default 10000, min 500, max 60000.'),
        tool: z
          .string()
          .describe(`Tool name to poll (e.g. "navigation${MODULE_SEPARATOR}get_current_route").`),
      },
    },
    async ({ args, clientId, intervalMs, predicate, timeoutMs, tool }) => {
      const parsedArgs = parseCallArgs(args);
      if (!parsedArgs.ok) return jsonError(parsedArgs.error);
      const pred = predicate as Predicate;
      const isLeaf = isLeafPredicate(pred);
      const leafPath = isLeaf ? (pred as LeafPredicate).path : undefined;
      const timeout = Math.max(500, Math.min(60_000, timeoutMs ?? 10_000));
      const interval = Math.max(50, Math.min(5_000, intervalMs ?? 300));
      const started = Date.now();
      let attempts = 0;
      let lastResult: unknown;
      let lastError: string | undefined;

      while (Date.now() - started < timeout) {
        attempts += 1;
        const dispatch = await ctx.dispatchTool(tool, parsedArgs.args, clientId);
        if (dispatch.ok) {
          lastResult = dispatch.result;
          if (evalPredicate(lastResult, pred)) {
            const payload: Record<string, unknown> = {
              attempts,
              elapsedMs: Date.now() - started,
              ok: true,
            };
            if (isLeaf) {
              payload.matched = resolvePath(lastResult, leafPath);
            }
            return {
              content: [{ text: JSON.stringify(payload, null, 2), type: 'text' as const }],
            };
          }
        } else {
          lastError = dispatch.error;
        }
        const remaining = timeout - (Date.now() - started);
        if (remaining <= 0) break;
        await new Promise((r) => {
          return setTimeout(r, Math.min(interval, remaining));
        });
      }

      return {
        content: [
          {
            text: JSON.stringify(
              {
                attempts,
                elapsedMs: Date.now() - started,
                lastError,
                lastResult,
                ok: false,
                reason: lastError
                  ? `Last dispatch failed: ${lastError}`
                  : `Predicate did not hold within ${timeout}ms`,
              },
              null,
              2
            ),
            type: 'text' as const,
          },
        ],
      };
    }
  );
};
