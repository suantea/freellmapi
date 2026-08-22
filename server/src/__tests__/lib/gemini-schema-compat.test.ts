import { describe, it, expect } from 'vitest';
import { sanitizeForGemini } from '../../lib/gemini-wire.js';

describe('sanitizeForGemini type unions', () => {
  it('collapses a nullable union into a type plus nullable at the top level', () => {
    // Google's Schema proto rejects a repeated `type` with
    // "Proto field is not repeating, cannot start list", so every schema built
    // by a `.nullable()` helper 400s unless the union is collapsed.
    expect(sanitizeForGemini({ type: ['number', 'null'] })).toEqual({
      type: 'number',
      nullable: true,
    });
  });

  it('collapses nullable unions nested in properties, items, and anyOf branches', () => {
    const input = {
      type: 'object',
      properties: {
        age: { type: ['integer', 'null'], description: 'Age in years' },
        address: {
          type: ['object', 'null'],
          properties: {
            street: { type: ['string', 'null'] },
          },
        },
        aliases: {
          type: 'array',
          items: { type: ['string', 'null'] },
        },
        contact: {
          anyOf: [
            { type: ['string', 'null'] },
            { type: 'object', properties: { email: { type: ['string', 'null'] } } },
          ],
        },
      },
      required: ['age'],
    };
    expect(sanitizeForGemini(input)).toEqual({
      type: 'object',
      properties: {
        age: { type: 'integer', description: 'Age in years', nullable: true },
        address: {
          type: 'object',
          nullable: true,
          properties: {
            street: { type: 'string', nullable: true },
          },
        },
        aliases: {
          type: 'array',
          items: { type: 'string', nullable: true },
        },
        contact: {
          anyOf: [
            { type: 'string', nullable: true },
            { type: 'object', properties: { email: { type: 'string', nullable: true } } },
          ],
        },
      },
      required: ['age'],
    });
  });

  it('keeps the first concrete member of a union that carries no null', () => {
    expect(sanitizeForGemini({ type: ['string', 'number'] })).toEqual({ type: 'string' });
  });

  it('drops type entirely for a null-only union', () => {
    expect(sanitizeForGemini({ type: ['null'], description: 'always empty' })).toEqual({
      description: 'always empty',
      nullable: true,
    });
  });

  it('leaves a single-string type and an explicit nullable flag untouched', () => {
    expect(sanitizeForGemini({ type: 'string', nullable: true })).toEqual({
      type: 'string',
      nullable: true,
    });
  });

  it('does not treat a property literally named "type" as a type union', () => {
    const input = {
      type: 'object',
      properties: {
        type: { type: ['string', 'null'], enum: ['a', 'b'] },
      },
    };
    expect(sanitizeForGemini(input)).toEqual({
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['a', 'b'], nullable: true },
      },
    });
  });
});

describe('sanitizeForGemini $ref handling', () => {
  it('inlines a $ref that points into $defs', () => {
    const input = {
      type: 'object',
      $defs: {
        Address: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
      properties: {
        home: { $ref: '#/$defs/Address' },
      },
    };
    expect(sanitizeForGemini(input)).toEqual({
      type: 'object',
      properties: {
        home: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    });
  });

  it('inlines a $ref into legacy definitions and sanitizes the target', () => {
    const input = {
      type: 'object',
      definitions: {
        Count: { type: ['integer', 'null'], exclusiveMinimum: 0, 'x-note': 'hi' },
      },
      properties: {
        count: { $ref: '#/definitions/Count', description: 'How many' },
      },
    };
    expect(sanitizeForGemini(input)).toEqual({
      type: 'object',
      properties: {
        count: { type: 'integer', nullable: true, description: 'How many' },
      },
    });
  });

  it('reuses a definition across sibling properties', () => {
    const input = {
      type: 'object',
      $defs: { Name: { type: 'string', minLength: 1 } },
      properties: {
        first: { $ref: '#/$defs/Name' },
        last: { $ref: '#/$defs/Name' },
      },
    };
    expect(sanitizeForGemini(input)).toEqual({
      type: 'object',
      properties: {
        first: { type: 'string', minLength: 1 },
        last: { type: 'string', minLength: 1 },
      },
    });
  });

  it('drops an orphan $ref and leaves a permissive schema behind', () => {
    const input = {
      type: 'object',
      properties: {
        missing: { $ref: '#/$defs/Nope' },
        remote: { $ref: 'https://example.com/schema.json', description: 'kept' },
      },
    };
    expect(sanitizeForGemini(input)).toEqual({
      type: 'object',
      properties: {
        missing: {},
        remote: { description: 'kept' },
      },
    });
  });

  it('stops expanding a self-referential definition', () => {
    const input = {
      type: 'object',
      $defs: {
        Node: {
          type: 'object',
          properties: {
            value: { type: 'string' },
            child: { $ref: '#/$defs/Node' },
          },
        },
      },
      properties: { root: { $ref: '#/$defs/Node' } },
    };
    expect(sanitizeForGemini(input)).toEqual({
      type: 'object',
      properties: {
        root: {
          type: 'object',
          properties: {
            value: { type: 'string' },
            child: {},
          },
        },
      },
    });
  });
});

describe('sanitizeForGemini vendor extensions and pass-through', () => {
  it('strips x-* keys at every depth while keeping x-prefixed property names', () => {
    const input = {
      type: 'object',
      'x-tool-version': 3,
      properties: {
        'x-request-id': {
          type: ['string', 'null'],
          'X-Legacy-Hint': 'stripped case-insensitively',
        },
        nested: {
          type: 'object',
          properties: { mode: { type: 'string', 'x-provider': 'local' } },
        },
      },
      required: ['x-request-id'],
    };
    expect(sanitizeForGemini(input)).toEqual({
      type: 'object',
      properties: {
        'x-request-id': { type: 'string', nullable: true },
        nested: {
          type: 'object',
          properties: { mode: { type: 'string' } },
        },
      },
      required: ['x-request-id'],
    });
  });

  it('passes an already-valid schema through unchanged', () => {
    const input = {
      type: 'object',
      description: 'Look up the weather',
      properties: {
        city: { type: 'string', description: 'City name', enum: ['Karachi', 'Lahore'] },
        days: { type: 'integer', minimum: 1, maximum: 7 },
        tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
        detail: { type: 'object', nullable: true, properties: { units: { type: 'string' } } },
      },
      required: ['city'],
    };
    // Byte-identical, not merely deep-equal: nothing may be reordered or
    // re-synthesized on a schema Gemini already accepts.
    expect(JSON.stringify(sanitizeForGemini(input))).toBe(JSON.stringify(input));
  });
});
