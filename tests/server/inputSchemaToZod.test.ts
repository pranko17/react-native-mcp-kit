import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { convertInputSchema, hashInputSchema } from '@/server/inputSchemaToZod';

const toCatalog = (schema: ReturnType<typeof convertInputSchema>) => {
  return z.toJSONSchema(schema, { io: 'input' }) as {
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
};

describe('convertInputSchema', () => {
  it('injects an optional described clientId into an empty schema', () => {
    const catalog = toCatalog(convertInputSchema(undefined));
    expect(catalog.properties.clientId).toBeDefined();
    expect(catalog.properties.clientId!.description).toContain('Target client ID');
    expect(catalog.required ?? []).not.toContain('clientId');
  });

  it('accepts a Zod schema directly (host tools) and keeps enum + required', () => {
    const schema = convertInputSchema(
      z.looseObject({
        direction: z.enum(['up', 'down']).describe('Swipe direction'),
        speed: z.number().optional(),
      })
    );
    const catalog = toCatalog(schema);
    expect(catalog.properties.direction!.enum).toEqual(['up', 'down']);
    expect(catalog.required).toEqual(['direction']);
    expect(() => {
      schema.parse({});
    }).toThrow();
    expect(schema.parse({ direction: 'up' })).toMatchObject({ direction: 'up' });
  });

  it('restores a wire JSON Schema with required, nested objects and enums intact', () => {
    const schema = convertInputSchema({
      properties: {
        mode: { enum: ['a', 'b'], type: 'string' },
        region: {
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x'],
          type: 'object',
        },
        screen: { minLength: 1, type: 'string' },
      },
      required: ['screen'],
      type: 'object',
    });
    expect(() => {
      schema.parse({});
    }).toThrow();
    expect(() => {
      schema.parse({ mode: 'zzz', screen: 's' });
    }).toThrow();
    expect(() => {
      schema.parse({ region: {}, screen: 's' });
    }).toThrow();
    expect(schema.parse({ mode: 'a', region: { x: 1 }, screen: 's' })).toBeTruthy();
  });

  it('keeps the root loose: undeclared args pass through at every level', () => {
    const schema = convertInputSchema({
      additionalProperties: false,
      properties: { known: { type: 'string' } },
      type: 'object',
    });
    const parsed = schema.parse({ extra: 42, known: 'k' }) as Record<string, unknown>;
    expect(parsed.extra).toBe(42);
  });

  it('preserves descriptions on union fields (zod fromJSONSchema regression)', () => {
    const catalog = toCatalog(
      convertInputSchema({
        properties: {
          to: {
            anyOf: [{ type: 'number' }, { type: 'string' }],
            description: 'Pop target',
          },
        },
        type: 'object',
      })
    );
    expect(catalog.properties.to!.description).toBe('Pop target');
    expect(catalog.properties.clientId!.description).toContain('Target client ID');
  });

  it('falls back to a permissive schema on unresolvable JSON Schema', () => {
    const schema = convertInputSchema({
      properties: { broken: { $ref: '#/definitions/missing' } },
      type: 'object',
    });
    expect(schema.parse({ anything: 1 })).toBeTruthy();
    expect(toCatalog(schema).properties.clientId).toBeDefined();
  });
});

describe('hashInputSchema', () => {
  it('ignores examples at any depth but not contract changes', () => {
    const base = {
      properties: {
        field: {
          examples: ['a'],
          properties: { sub: { examples: [1], type: 'number' } },
          type: 'object',
        },
      },
      type: 'object',
    };
    const reordered = JSON.parse(JSON.stringify(base)) as typeof base;
    reordered.properties.field.examples = ['b', 'c'];
    reordered.properties.field.properties.sub.examples = [2];
    expect(hashInputSchema('d', base)).toBe(hashInputSchema('d', reordered));

    const contractChange = JSON.parse(JSON.stringify(base)) as typeof base;
    contractChange.properties.field.properties.sub.type = 'string' as never;
    expect(hashInputSchema('d', base)).not.toBe(hashInputSchema('d', contractChange));
    expect(hashInputSchema('d', base)).not.toBe(hashInputSchema('other', base));
  });

  it('is key-order independent', () => {
    // JSON strings so eslint's sort-keys autofix can't normalize the two
    // literals into identical insertion order and void the test.
    const a = JSON.parse(
      '{"properties":{"x":{"type":"string"},"y":{"type":"number"}},"type":"object"}'
    ) as Record<string, unknown>;
    const b = JSON.parse(
      '{"type":"object","properties":{"y":{"type":"number"},"x":{"type":"string"}}}'
    ) as Record<string, unknown>;
    expect(hashInputSchema('d', a)).toBe(hashInputSchema('d', b));
  });
});
