import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { jsonError, parseCallArgs, parseClientIds, type ServerContext } from '@/server/helpers';
import {
  evalPredicate,
  isLeafPredicate,
  type LeafPredicate,
  type Predicate,
  resolvePath,
} from '@/server/predicate';
import { MODULE_SEPARATOR } from '@/shared/protocol';

interface PollOutcome {
  attempts: number;
  elapsedMs: number;
  ok: boolean;
  lastError?: string;
  lastResult?: unknown;
  matched?: unknown;
  reason?: string;
}

const pollForClient = async (
  ctx: ServerContext,
  tool: string,
  args: Record<string, unknown>,
  clientId: string | undefined,
  pred: Predicate,
  isLeaf: boolean,
  leafPath: string | undefined,
  timeout: number,
  interval: number
): Promise<PollOutcome> => {
  const started = Date.now();
  let attempts = 0;
  let lastResult: unknown;
  let lastError: string | undefined;

  while (Date.now() - started < timeout) {
    attempts += 1;
    const dispatch = await ctx.dispatchTool(tool, args, clientId);
    if (dispatch.ok) {
      lastResult = dispatch.result;
      if (evalPredicate(lastResult, pred)) {
        const outcome: PollOutcome = {
          attempts,
          elapsedMs: Date.now() - started,
          ok: true,
        };
        if (isLeaf) outcome.matched = resolvePath(lastResult, leafPath);
        return outcome;
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
    attempts,
    elapsedMs: Date.now() - started,
    lastError,
    lastResult,
    ok: false,
    reason: lastError
      ? `Last dispatch failed: ${lastError}`
      : `Predicate did not hold within ${timeout}ms`,
  };
};

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
  Single client (clientId omitted or a string):
    { ok: true, attempts, elapsedMs, matched? } on success — matched is the path-
      resolved value for leaf predicates, omitted for compound.
    { ok: false, reason, attempts, elapsedMs, lastResult, lastError? } on timeout.

  Broadcast (clientId is an array — polls each client in parallel under the
  shared timeout): { ok, perClient: [{ clientId, ok, attempts, elapsedMs, matched? | lastResult, lastError? }, ...] }
  with overall ok = every client matched within its budget.`,
      inputSchema: {
        args: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .optional()
          .describe('Arguments for the polled tool — object or JSON string.'),
        clientId: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(
            'Target client ID(s). String polls one client; `/body/flags` literal ("/^ios/") expands to every matching connected client; array mixes literals and regex strings. Broadcast forms poll each matched client in parallel under the shared timeoutMs and report per-client outcomes. Same auto-resolution semantics as `call`.'
          ),
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

      const clients = parseClientIds(clientId, ctx.bridge);
      if (!clients.ok) return jsonError(clients.error);

      const pred = predicate as Predicate;
      const isLeaf = isLeafPredicate(pred);
      const leafPath = isLeaf ? (pred as LeafPredicate).path : undefined;
      const timeout = Math.max(500, Math.min(60_000, timeoutMs ?? 10_000));
      const interval = Math.max(50, Math.min(5_000, intervalMs ?? 300));

      if (clients.mode === 'single') {
        const outcome = await pollForClient(
          ctx,
          tool,
          parsedArgs.args,
          clients.clientId,
          pred,
          isLeaf,
          leafPath,
          timeout,
          interval
        );
        const payload: Record<string, unknown> = {
          attempts: outcome.attempts,
          elapsedMs: outcome.elapsedMs,
          ok: outcome.ok,
        };
        if (outcome.ok) {
          if (isLeaf) payload.matched = outcome.matched;
        } else {
          payload.lastResult = outcome.lastResult;
          payload.reason = outcome.reason;
          if (outcome.lastError) payload.lastError = outcome.lastError;
        }
        return {
          content: [{ text: JSON.stringify(payload, null, 2), type: 'text' as const }],
        };
      }

      const perClient = await Promise.all(
        clients.ids.map(async (id) => {
          const outcome = await pollForClient(
            ctx,
            tool,
            parsedArgs.args,
            id,
            pred,
            isLeaf,
            leafPath,
            timeout,
            interval
          );
          const entry: Record<string, unknown> = {
            attempts: outcome.attempts,
            clientId: id,
            elapsedMs: outcome.elapsedMs,
            ok: outcome.ok,
          };
          if (outcome.ok) {
            if (isLeaf) entry.matched = outcome.matched;
          } else {
            entry.lastResult = outcome.lastResult;
            entry.reason = outcome.reason;
            if (outcome.lastError) entry.lastError = outcome.lastError;
          }
          return entry;
        })
      );

      const okCount = perClient.reduce((n, entry) => {
        return n + (entry.ok === true ? 1 : 0);
      }, 0);
      const failedCount = perClient.length - okCount;
      const ok = failedCount === 0;
      return {
        content: [
          {
            text: JSON.stringify({ failedCount, ok, okCount, perClient }, null, 2),
            type: 'text' as const,
          },
        ],
      };
    }
  );
};
