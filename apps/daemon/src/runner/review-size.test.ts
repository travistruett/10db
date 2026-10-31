import { mintId, type RiskTag, type WorkstreamStep } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { REVIEW_SIZE_DIFF_BYTES, reviewSizeRule, reviewSizeState } from './review-size';

type StepFacts = Pick<WorkstreamStep, 'pinned' | 'result' | 'earlier'>;
const file = (path: string, added: number | null, removed: number | null) => ({
  path,
  added,
  removed,
});
const files = (n: number) => Array.from({ length: n }, (_, i) => file(`f${String(i)}.ts`, 1, 1));
const open: StepFacts = { pinned: false, result: null, earlier: [] };
const verdict: NonNullable<WorkstreamStep['result']> = {
  summary: 'x',
  verdict: 'approve',
  sessionId: mintId('Session'),
  at: '2026-10-31T00:00:00.000Z',
};

describe('reviewSizeRule', () => {
  const rows: {
    name: string;
    tags?: RiskTag[];
    files: ReturnType<typeof files>;
    step?: StepFacts;
    want: 'review' | 'ask';
  }[] = [
    { name: 'a small plain change is asked about', files: files(3), want: 'ask' },
    { name: 'security forces review', tags: ['security'], files: files(1), want: 'review' },
    { name: 'auth forces review', tags: ['auth'], files: files(1), want: 'review' },
    { name: 'migration forces review', tags: ['migration'], files: files(1), want: 'review' },
    { name: 'dependency forces review', tags: ['dependency'], files: files(1), want: 'review' },
    {
      name: 'a pinned step forces review',
      files: files(1),
      step: { ...open, pinned: true },
      want: 'review',
    },
    {
      name: 'a review that already ran forces review',
      files: files(1),
      step: { ...open, result: verdict },
      want: 'review',
    },
    {
      name: 'earlier rounds force review',
      files: files(1),
      step: { ...open, earlier: [verdict] },
      want: 'review',
    },
    { name: '15 files is still asked about', files: files(15), want: 'ask' },
    { name: '16 files forces review', files: files(16), want: 'review' },
    { name: '400 lines is still asked about', files: [file('a.ts', 200, 200)], want: 'ask' },
    { name: '401 lines forces review', files: [file('a.ts', 201, 200)], want: 'review' },
    { name: 'a binary file counts no lines', files: [file('a.png', null, null)], want: 'ask' },
  ];
  it.each(rows)('$name', ({ tags, files: changed, step, want }) => {
    expect(reviewSizeRule({ riskTags: tags ?? [] }, { files: changed }, step ?? open)).toBe(want);
  });
});

describe('reviewSizeState', () => {
  const task = {
    title: 'Add a route',
    description: 'It lists things.',
    acceptanceCriteria: ['Lists things', 'Has a test'],
    riskTags: [],
  };
  it('holds the task, files, diff and gate result', () => {
    const state = reviewSizeState(
      task,
      { files: [file('a.ts', 2, 1)], diff: '+hello' },
      'gate passed',
    );
    expect(state).toContain('Task: Add a route');
    expect(state).toContain('2. Has a test');
    expect(state).toContain('a.ts (+2 -1)');
    expect(state).toContain('+hello');
    expect(state).toContain('Gate result: gate passed');
  });
  it('cuts the diff at 24 KB', () => {
    const state = reviewSizeState(task, { files: [], diff: 'x'.repeat(100_000) }, 'ok');
    expect(state).toContain('x'.repeat(REVIEW_SIZE_DIFF_BYTES));
    expect(state).not.toContain('x'.repeat(REVIEW_SIZE_DIFF_BYTES + 1));
    expect(state).toContain('[diff cut]');
  });
  it('cuts inside a multi-byte character without leaving a broken one', () => {
    const state = reviewSizeState(task, { files: [], diff: 'é'.repeat(20_000) }, 'ok');
    expect(state).not.toContain('�');
  });
});
