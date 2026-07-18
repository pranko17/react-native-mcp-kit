import { z } from 'zod';

import { type McpModule } from '@/client/models/types';
import {
  applyProjection,
  makeProjectionSchema,
  projectAsValue,
  type ProjectionArgs,
} from '@/shared/projection/projectValue';

import { type ReduxAction, type StoreLike } from './types';

// `get_state` returns the whole Redux state tree — an object keyed by slice.
// Default depth 2 — top level expanded, each slice walked one level (slice
// names + their immediate fields visible, nested containers collapse to
// markers). Drill into a slice via path; depth 1 lists slice names only.
const STATE_DEFAULT_DEPTH = 2;

const STATE_SCHEMA = makeProjectionSchema(STATE_DEFAULT_DEPTH);

const parseAction = (raw: unknown): ReduxAction | null => {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as { type?: unknown }).type === 'string'
    ) {
      return parsed as ReduxAction;
    }
    return null;
  } catch {
    return null;
  }
};

export const reduxModule = (store: StoreLike): McpModule => {
  return {
    description: `Redux store inspection + dispatch.

\`get_state\` returns the whole state tree (default depth ${STATE_DEFAULT_DEPTH} — slices walked one
level) — drill into a slice via \`path: 'auth.user.email'\`, or pass \`depth: 1\`
to list slice names only. Accepts path / depth / maxBytes.

\`dispatch\` takes a JSON action string with a string \`type\` (see the tool).`,
    name: 'redux',
    tools: {
      dispatch: {
        description: 'Dispatch an action to the store.',
        handler: (args) => {
          const action = parseAction(args.action);
          if (!action) {
            return {
              error:
                'dispatch.action must be a JSON object string with a string `type`, e.g. \'{"type":"cart/addItem","payload":{"id":42}}\'.',
            };
          }
          store.dispatch(action);
          return { action, success: true };
        },
        inputSchema: z.looseObject({
          action: z
            .string()
            .min(1)
            .describe('Action as a JSON object string. Must include a string `type`.')
            .meta({
              examples: ['{"type":"cart/clear"}', '{"type":"auth/setToken","payload":"abc123"}'],
            }),
        }),
      },
      get_state: {
        description: 'The full Redux state tree, keyed by slice.',
        handler: (args) => {
          return applyProjection(
            store.getState(),
            args as ProjectionArgs,
            projectAsValue,
            STATE_DEFAULT_DEPTH
          );
        },
        inputSchema: z.looseObject(STATE_SCHEMA),
      },
    },
  };
};
