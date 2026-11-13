import { describe, expect, it } from 'vitest';
import { sampleInstances, SampleError } from './codex-samples';

describe('sampleInstances', () => {
  it.each([
    [
      'an object keeps only required properties',
      {
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'string' } },
        required: ['a'],
      },
      [{ a: 'x' }],
    ],
    [
      // A Rust Option that serde writes as null when unset: the generated schema leaves it out of
      // `required`, but Codex always sends it.
      'an object keeps a property that may be null, as if required',
      {
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: { anyOf: [{ $ref: '#/definitions/B' }, { type: 'null' }] },
          c: { type: ['integer', 'null'] },
        },
        required: ['a'],
        definitions: { B: { enum: ['b1', 'b2'] } },
      },
      [
        { a: 'x', b: 'b1', c: 0 },
        { a: 'x', b: 'b2', c: 0 },
        { a: 'x', b: null, c: 0 },
        { a: 'x', b: 'b1', c: null },
      ],
    ],
    ['a nullable string offers null', { type: ['string', 'null'] }, ['x', null]],
    [
      'an enum offers each value',
      { type: 'string', enum: ['completed', 'failed'] },
      ['completed', 'failed'],
    ],
    [
      'oneOf offers each branch',
      {
        oneOf: [
          { type: 'object', properties: { type: { enum: ['chatgpt'] } }, required: ['type'] },
          { type: 'object', properties: { type: { enum: ['gcp'] } }, required: ['type'] },
        ],
      },
      [{ type: 'chatgpt' }, { type: 'gcp' }],
    ],
    [
      'a $ref resolves in definitions',
      { definitions: { N: { type: 'integer' } }, $ref: '#/definitions/N' },
      [0],
    ],
    [
      'an array gets one item, whose branches vary',
      { type: 'array', items: { type: ['boolean', 'null'] } },
      [[false], [null]],
    ],
    [
      'allOf merges its parts',
      {
        allOf: [
          { type: 'object', properties: { a: { const: 1 } }, required: ['a'] },
          { type: 'object', properties: { b: { const: 2 } }, required: ['b'] },
        ],
      },
      [{ a: 1, b: 2 }],
    ],
    [
      'a nested choice varies while the others stay first',
      {
        type: 'object',
        required: ['s', 't'],
        properties: { s: { enum: ['a', 'b'] }, t: { type: ['string', 'null'] } },
      },
      [
        { s: 'a', t: 'x' },
        { s: 'b', t: 'x' },
        { s: 'a', t: null },
      ],
    ],
  ])('%s', (_name, schema, want) => {
    expect(sampleInstances(schema)).toEqual(want);
  });

  it.each([
    ['not', { not: { type: 'string' } }],
    ['an outside $ref', { $ref: 'other.json#/X' }],
  ])('throws SampleError on %s', (_name, schema) => {
    expect(() => sampleInstances(schema)).toThrow(SampleError);
  });
});
