import { describe, expect, it } from 'vitest';
import {
  CONTRACT_SCHEMAS,
  DEFAULT_ONE_WAY_PATHS,
  mintId,
  OneWayPathsDto,
  ShapeMeasuresDto,
  ShapeRehearseInput,
  ShapeToolInputs,
} from './index';

// Shape spec docs/superpowers/specs/2026-11-02-10db-brainstorm-chat-design.md §7.

describe('report_finding', () => {
  const effortKey = 'density';
  const parses = (input: unknown): boolean =>
    ShapeToolInputs.report_finding.safeParse(input).success;

  it('takes the closing flag and the reviewer the hook stamps', () => {
    expect(
      parses({
        effortKey,
        taskKey: 'cards',
        taskHash: 'abc',
        final: true,
        reviewer: 'rehearsal',
        finding: { kind: 'question', text: 'Which density?' },
      }),
    ).toBe(true);
  });

  it('refuses a reviewer that is not one of the three', () => {
    expect(parses({ effortKey, reviewer: 'general-purpose', finding: { kind: 'none' } })).toBe(
      false,
    );
  });
});

describe('the one-way paths setting', () => {
  it('is a list of globs, none empty', () => {
    expect(OneWayPathsDto.safeParse({ paths: ['db/**'] }).success).toBe(true);
    expect(OneWayPathsDto.safeParse({ paths: [''] }).success).toBe(false);
    expect(OneWayPathsDto.safeParse({ paths: [] }).success).toBe(true);
  });

  it('defaults to the goals spec’s 10db paths', () => {
    expect(DEFAULT_ONE_WAY_PATHS).toEqual([
      'packages/db/src/schema.ts',
      'packages/db/drizzle/**',
      'packages/contracts/src/**',
    ]);
  });
});

describe('rehearse', () => {
  it('takes no proposals, or at least one', () => {
    expect(ShapeRehearseInput.safeParse({}).success).toBe(true);
    expect(ShapeRehearseInput.safeParse({ proposalIds: [] }).success).toBe(false);
    expect(ShapeRehearseInput.safeParse({ proposalIds: [mintId('ShapeProposal')] }).success).toBe(
      true,
    );
  });
});

describe('the measures', () => {
  it('carry the question-card rate beside sizing', () => {
    const rate = { n: 0, within: 0 };
    const parsed = ShapeMeasuresDto.parse({
      sizing: { n: 0, within: 0, buckets: { S: rate, M: rate, L: rate, XL: rate }, overrides: 0 },
      questions: { converted: { tasks: 4, cards: 1 }, other: { tasks: 10, cards: 6 } },
      shadow: [],
    });
    expect(parsed.questions.converted.cards).toBe(1);
  });

  it('are in the contract schemas the generator writes', () => {
    expect(Object.keys(CONTRACT_SCHEMAS)).toEqual(
      expect.arrayContaining([
        'one-way-paths-dto',
        'shape-rehearse-input',
        'shape-rehearse-result',
      ]),
    );
  });
});
