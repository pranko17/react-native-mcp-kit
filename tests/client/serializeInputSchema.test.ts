import { afterEach, describe, expect, it, vi } from 'vitest';
import { z, type ZodType } from 'zod';

import { serializeInputSchema } from '@/client/utils/serializeInputSchema';

describe('serializeInputSchema', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns undefined for a missing schema', () => {
    expect(serializeInputSchema(undefined)).toBeUndefined();
  });

  it('serializes a Zod object into JSON Schema with required, descriptions and enums', () => {
    const wire = serializeInputSchema(
      z.looseObject({
        direction: z.enum(['up', 'down']).describe('Swipe direction'),
        speed: z.number().optional(),
      })
    ) as {
      properties: Record<string, Record<string, unknown>>;
      type: string;
      required?: string[];
    };
    expect(wire.type).toBe('object');
    expect(wire.required).toEqual(['direction']);
    expect(wire.properties.direction!.enum).toEqual(['up', 'down']);
    expect(wire.properties.direction!.description).toBe('Swipe direction');
    expect(wire.properties.speed!.type).toBe('number');
  });

  it('serializes the input side of transforms without throwing (unrepresentable: any)', () => {
    const wire = serializeInputSchema(
      z.looseObject({
        note: z.string().transform((s) => {
          return s.length;
        }),
      })
    ) as { properties: Record<string, Record<string, unknown>> };
    expect(wire.properties.note!.type).toBe('string');
  });

  it('drops non-Zod values with a console.warn and registers schema-less', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      return undefined;
    });
    const result = serializeInputSchema({ type: 'object' } as unknown as ZodType);
    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[mcp-kit] inputSchema must be a Zod schema (e.g. z.looseObject({...})) — ignoring the provided value.'
    );
  });
});
