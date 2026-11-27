import { describe, expect, it } from 'vitest';
import {
  KnowledgeScope,
  KnowledgeState,
  mintId,
  PrincipleKind,
  PrincipleStatus,
  type PrincipleDto,
  type Watchpoint,
} from '@10db/contracts';
import { coverageOf } from './coverage';
import { watchpointPrinciples } from './knowledge';
import { verdictKey, type LineVerdicts } from './line-verdicts';

const tracked = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'docs/readme.md', '.github/ci.yml'];

describe('coverageOf', () => {
  it('counts globs alone, and with lines only the files whose whole text matched and was read in full', () => {
    const globbed = { key: 'ts', globs: ['src/**'], lines: [] };
    expect(coverageOf(globbed, tracked, new Map())).toEqual({
      files: 3,
      examples: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    });
    expect(coverageOf({ ...globbed, globs: ['**'] }, tracked, new Map()).files).toBe(5);

    const lined = { key: 'model', globs: ['src/**'], lines: ['claude-'] };
    const verdicts: LineVerdicts = new Map([
      [verdictKey('model', 'src/a.ts'), { matched: true, cut: false }],
      [verdictKey('model', 'src/b.ts'), { matched: false, cut: false }],
      // A cut line: not read in full.
      [verdictKey('model', 'src/c.ts'), { matched: true, cut: true }],
    ]);
    expect(coverageOf(lined, tracked, verdicts)).toEqual({ files: 1, examples: ['src/a.ts'] });
    // No verdict at all: the file was too large or binary to read, so it does not count.
    expect(coverageOf(lined, tracked, new Map())).toEqual({ files: 0, examples: [] });
  });
});

const now = '2026-11-27T00:00:00.000Z';
const principle = (
  topicKey: string,
  statement: string,
  over: Partial<PrincipleDto> = {},
): PrincipleDto => ({
  id: mintId('Principle'),
  projectId: null,
  scope: KnowledgeScope.You,
  area: null,
  statement,
  rationale: null,
  kind: PrincipleKind.Policy,
  topicKey,
  status: PrincipleStatus.Confirmed,
  state: KnowledgeState.Current,
  supersedesId: null,
  supersededById: null,
  sourceId: mintId('Source'),
  sourceQuote: null,
  speaker: null,
  confirmedBy: null,
  confirmedAt: now,
  retiredAt: null,
  retiredBy: null,
  retiredReason: null,
  withdrawnAt: null,
  withdrawnBy: null,
  withdrawnReason: null,
  createdAt: now,
  updatedAt: now,
  ...over,
});

describe('watchpointPrinciples', () => {
  const ui: Pick<Watchpoint, 'key' | 'knowledge'> = { key: 'design', knowledge: ['ui'] };

  it('joins a key or its children, the most specific scope, at most five, and no belief', () => {
    const exact = principle('ui', 'Use the shared button.');
    const child = principle('ui.spacing', 'Space in eights.');
    const near = principle('uix', 'Not under ui.');
    const belief = principle('ui.mood', 'A hunch.', { kind: PrincipleKind.Belief });
    const yours = principle('ui.density', 'Compact tables.');
    const projects = principle('ui.density', 'Roomy tables here.', {
      scope: KnowledgeScope.Project,
    });
    const area = principle('ui.api', 'Only for the api area.', {
      scope: KnowledgeScope.Area,
      area: 'api',
    });
    const joined = watchpointPrinciples(
      [ui, { key: 'plain', knowledge: [] }],
      [exact, child, near, belief, yours, projects, area],
      ['web'],
    );
    expect(joined.get('design')?.map((p) => p.statement)).toEqual([
      'Use the shared button.',
      'Space in eights.',
      'Roomy tables here.',
    ]);
    expect(joined.has('plain')).toBe(false);

    const many = Array.from({ length: 8 }, (_, i) =>
      principle(`ui.k${String(i)}`, `Rule ${String(i)}`),
    );
    expect(watchpointPrinciples([ui], many, []).get('design')).toHaveLength(5);
  });
});
