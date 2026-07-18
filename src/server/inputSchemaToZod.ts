import { z } from 'zod';

import { canonicalize } from './helpers';

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

const baseFor = (type: FieldSpec['type']): z.ZodType => {
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

// Same forms as the legacy `call` meta-tool accepted — literal, `/regex/flags`,
// or a mixed array — so broadcast semantics carry over to direct registration
// unchanged (parseClientIds handles the parsing at dispatch time).
const CLIENT_ID_FIELD = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .describe(
    'Target client ID(s). Plain string ("ios-1") selects one client. `/body/flags` literal ("/^ios/") matches connected IDs by regex and broadcasts to every match. Array ([ "ios-1", "/^android/" ]) accepts literals and regex strings mixed. Optional when exactly one client is connected — it auto-picks.'
  );

/**
 * Converts a module's wire-format `inputSchema` (flat `Record<string, FieldSpec>`)
 * into a Zod object schema suitable for `McpServer.registerTool`. Always injects
 * an optional `clientId` so multi-client routing has a uniform escape hatch.
 *
 * Loose object, deliberately: module handlers accept args beyond their declared
 * schema (the wire schema is advisory — handlers validate themselves). A default
 * zod object would silently strip undeclared keys before dispatch.
 */
export const convertInputSchema = (schema: Record<string, unknown> | undefined) => {
  const shape: Record<string, z.ZodType> = {};
  if (schema) {
    for (const [key, raw] of Object.entries(schema)) {
      const spec = (raw ?? {}) as FieldSpec;
      let zType = baseFor(spec.type);
      const desc = buildDescription(spec);
      if (desc) zType = zType.describe(desc);
      shape[key] = zType.optional();
    }
  }
  shape.clientId = CLIENT_ID_FIELD;
  return z.looseObject(shape);
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
