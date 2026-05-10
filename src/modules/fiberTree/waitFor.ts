/**
 * `query.waitFor` polling loop — repeatedly runs the underlying query
 * until either the user-supplied predicate holds (and, optionally, has
 * held continuously for `stable` ms), or the timeout elapses.
 *
 * Lives in its own file because the loop is mechanical noise next to
 * the rest of the `query` handler. The actual one-shot query runs in
 * `runOnce`, which the caller passes in along with the `waitFor` arg
 * object — the loop is purely about scheduling and predicate matching.
 *
 * The shape of `runOnce` matches the inner query handler — returns
 * `{ matches, total, truncated? }` plus whatever else lands in the
 * response. We spread that into the final return so the agent gets the
 * usual response fields alongside the wait metadata.
 */

import {
  WAIT_INTERVAL_DEFAULT,
  WAIT_INTERVAL_MIN,
  WAIT_TIMEOUT_DEFAULT,
  WAIT_TIMEOUT_MAX,
} from './constants';

type WaitUntil = 'appear' | 'disappear';

/**
 * Raw `waitFor` object as it arrives from the agent's args. Validated
 * here, not at parse time, so the rest of `query` runs as a one-shot
 * when the arg is missing or malformed.
 */
export interface WaitForArgs {
  interval?: number;
  stable?: number;
  timeout?: number;
  until?: unknown;
}

interface QueryResult {
  matches: Record<string, unknown>[];
  total: number;
  truncated?: true;
}

interface WaitMeta {
  attempts: number;
  elapsedMs: number;
  timedOut: boolean;
  until: WaitUntil;
  waited: true;
  stableFor?: number;
}

/**
 * Drive the polling loop. Returns the last `QueryResult` merged with
 * wait metadata (`{ waited: true, until, attempts, elapsedMs, timedOut,
 * stableFor? }`) once the predicate holds (with stability satisfied)
 * or the timeout fires. `{ error }` shape when `until` is missing /
 * invalid.
 */
export const runWaitForLoop = async (
  waitForRaw: WaitForArgs,
  runOnce: () => Promise<QueryResult>
): Promise<{ error: string } | (QueryResult & WaitMeta)> => {
  const until = waitForRaw.until;
  if (until !== 'appear' && until !== 'disappear') {
    return { error: 'waitFor.until must be "appear" or "disappear"' };
  }
  const waitUntil: WaitUntil = until;
  const timeout = Math.min(
    WAIT_TIMEOUT_MAX,
    Math.max(0, waitForRaw.timeout ?? WAIT_TIMEOUT_DEFAULT)
  );
  const interval = Math.max(WAIT_INTERVAL_MIN, waitForRaw.interval ?? WAIT_INTERVAL_DEFAULT);
  const stable = Math.max(0, waitForRaw.stable ?? 0);
  const predicate = (total: number): boolean => {
    return waitUntil === 'appear' ? total >= 1 : total === 0;
  };

  const startedAt = Date.now();
  const deadline = startedAt + timeout;
  let attempts = 0;
  let stableSince: number | null = null;
  let lastResult = await runOnce();
  attempts++;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const now = Date.now();
    const elapsedMs = now - startedAt;
    const met = predicate(lastResult.total);

    if (met) {
      if (stable === 0) {
        return {
          ...lastResult,
          attempts,
          elapsedMs,
          timedOut: false,
          until: waitUntil,
          waited: true,
        };
      }
      if (stableSince === null) stableSince = now;
      if (now - stableSince >= stable) {
        return {
          ...lastResult,
          attempts,
          elapsedMs,
          stableFor: now - stableSince,
          timedOut: false,
          until: waitUntil,
          waited: true,
        };
      }
    } else {
      stableSince = null;
    }

    if (now >= deadline) {
      return {
        ...lastResult,
        attempts,
        elapsedMs,
        timedOut: true,
        until: waitUntil,
        waited: true,
      };
    }

    const remaining = deadline - now;
    const sleepMs = Math.min(interval, Math.max(0, remaining));
    await new Promise<void>((resolve) => {
      return setTimeout(resolve, sleepMs);
    });
    lastResult = await runOnce();
    attempts++;
  }
};
