import { z } from 'zod';

import { canonicalize } from './canonicalize';

/**
 * Mini-schema shape used by every module's `inputSchema` today — flat dict
 * where each value carries `{ type, description?, examples? }`. Not full JSON
 * Schema; modules validate handler args themselves so every field is
 * effectively optional.
 */
interface FieldSpec {
  description?: string;
  examples?: unknown[];
  type?: 'array' | 'boolean' | 'number' | 'object' | 'string';
}

const baseFor = (type: FieldSpec['type']): z.ZodTypeAny => {
  switch (type) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'array':
      return z.array(z.unknown());
    case 'object':
      return z.record(z.string(), z.unknown());
    default:
      return z.unknown();
  }
};

const buildDescription = (spec: FieldSpec): string | undefined => {
  if (!spec.description && !spec.examples?.length) return undefined;
  if (!spec.examples?.length) return spec.description;
  // Zod has no first-class examples — fold them into the description so the
  // catalog still surfaces them to the agent.
  const ex = spec.examples
    .map((e) => {
      return JSON.stringify(e);
    })
    .join(', ');
  return spec.description ? `${spec.description} Examples: ${ex}` : `Examples: ${ex}`;
};

const CLIENT_ID_FIELD = z
  .string()
  .optional()
  .describe(
    'Target client ID (e.g. "ios-1"). Required when more than one RN client is connected; auto-picked otherwise.'
  );

/**
 * Converts a module's wire-format `inputSchema` (flat `Record<string, FieldSpec>`)
 * into a Zod raw shape suitable for `McpServer.registerTool`. Always injects an
 * optional `clientId` so multi-client routing has a uniform escape hatch.
 *
 * Pass `injectClientId: false` for host tools that already know their target
 * (or where `clientId` is irrelevant — purely host-local commands).
 */
export const convertInputSchema = (
  schema: Record<string, unknown> | undefined,
  options: { injectClientId?: boolean } = {}
): Record<string, z.ZodTypeAny> => {
  const { injectClientId = true } = options;
  const shape: Record<string, z.ZodTypeAny> = {};
  if (schema) {
    for (const [key, raw] of Object.entries(schema)) {
      const spec = (raw ?? {}) as FieldSpec;
      let zType = baseFor(spec.type);
      const desc = buildDescription(spec);
      if (desc) zType = zType.describe(desc);
      shape[key] = zType.optional();
    }
  }
  if (injectClientId) {
    shape.clientId = CLIENT_ID_FIELD;
  }
  return shape;
};

/**
 * Stable canonical hash of a tool descriptor for dedup across clients. Strips
 * `examples` from each field — examples are documentation, not contract, and
 * should not break dedup if two builds happen to reorder them.
 */
export const hashInputSchema = (
  description: string,
  schema: Record<string, unknown> | undefined
): string => {
  const stripped: Record<string, unknown> = {};
  if (schema) {
    for (const [k, v] of Object.entries(schema)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const copy = { ...(v as Record<string, unknown>) };
        delete copy.examples;
        stripped[k] = copy;
      } else {
        stripped[k] = v;
      }
    }
  }
  return canonicalize({ description, schema: stripped });
};
