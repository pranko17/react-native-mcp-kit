import { z, type ZodType } from 'zod';

import { canonicalize } from './helpers';

// Same forms as the legacy `call` meta-tool accepted — literal, `/regex/flags`,
// or a mixed array — so broadcast semantics carry over to direct registration
// unchanged (parseClientIds handles the parsing at dispatch time).
const CLIENT_ID_DESCRIPTION =
  'Target client ID ("ios-1"); a `/regex/` literal or an array broadcasts to every match. Auto-picks when exactly one client is connected. Full forms: server instructions § clientId.';

const CLIENT_ID_FIELD = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .describe(CLIENT_ID_DESCRIPTION);

// Derived from CLIENT_ID_FIELD so the two forms can't drift apart. `$schema`
// is stripped — the node is embedded into another schema's `properties`.
const CLIENT_ID_JSON_SCHEMA = ((): Record<string, unknown> => {
  const json = z.toJSONSchema(CLIENT_ID_FIELD, { io: 'input' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
})();

const jsonSchemaToZod = (json: Record<string, unknown>): ZodType => {
  const withClientId = {
    ...json,
    // Root stays loose regardless of how the author declared it — handlers
    // accept undeclared args, and `clientId` must never be rejected.
    additionalProperties: {},
    properties: {
      ...((json.properties as Record<string, unknown> | undefined) ?? {}),
      clientId: CLIENT_ID_JSON_SCHEMA,
    },
  };
  try {
    return z.fromJSONSchema(withClientId as never);
  } catch (err) {
    process.stderr.write(
      `[mcp-kit] Failed to build validator from JSON Schema (${(err as Error).message}) — registering with a permissive schema.\n`
    );
    return z.looseObject({ clientId: CLIENT_ID_FIELD });
  }
};

/**
 * Converts a tool's `inputSchema` into a Zod object schema suitable for
 * `McpServer.registerTool`. Always injects an optional `clientId` so
 * multi-client routing has a uniform escape hatch. Two forms:
 *   - a Zod schema (host tools authored in Zod) — serialized and re-parsed so
 *     both forms flow through one JSON-Schema path;
 *   - a JSON Schema object node — the wire form every client produces by
 *     serializing its Zod schemas with `z.toJSONSchema`.
 *
 * Root object is forced loose, deliberately: module handlers accept args
 * beyond their declared schema (the schema is advisory — handlers validate
 * themselves), so undeclared keys must never be stripped or rejected before
 * dispatch.
 */
export const convertInputSchema = (schema: Record<string, unknown> | ZodType | undefined) => {
  if (!schema) {
    return z.looseObject({ clientId: CLIENT_ID_FIELD });
  }
  if ('_zod' in schema) {
    return jsonSchemaToZod(
      z.toJSONSchema(schema as ZodType, { io: 'input', unrepresentable: 'any' }) as Record<
        string,
        unknown
      >
    );
  }
  return jsonSchemaToZod(schema);
};

/**
 * Recursively drops every `examples` key — examples are documentation, not
 * contract, and should not break cross-client dedup if two builds happen to
 * reorder them.
 */
const stripExamples = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stripExamples);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'examples') continue;
      out[k] = stripExamples(v);
    }
    return out;
  }
  return value;
};

/**
 * Stable canonical hash of a tool descriptor for dedup across clients.
 */
export const hashInputSchema = (
  description: string,
  schema: Record<string, unknown> | undefined
): string => {
  return canonicalize({ description, schema: schema ? stripExamples(schema) : {} });
};
