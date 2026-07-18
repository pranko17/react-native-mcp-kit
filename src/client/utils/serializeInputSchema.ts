import { z, type ZodType } from 'zod';

/**
 * Wire-serializes a tool's `inputSchema` (a Zod schema) into standard JSON
 * Schema for the registration / tool_register messages. `unrepresentable:
 * 'any'` keeps transforms/refinements from throwing — their structural part
 * still serializes, the rest stays client-side.
 *
 * Anything that isn't a Zod schema (possible from untyped JS callers) is
 * dropped with a warning — the tool still registers, just schema-less.
 */
export const serializeInputSchema = (
  schema: ZodType | undefined
): Record<string, unknown> | undefined => {
  if (!schema) return undefined;
  if (!('_zod' in schema)) {
    console.warn(
      '[mcp-kit] inputSchema must be a Zod schema (e.g. z.looseObject({...})) — ignoring the provided value.'
    );
    return undefined;
  }
  return z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
};
