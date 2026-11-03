import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import {
  findingDto,
  goalProposal,
  looseTaskProposal,
  shapeViewDto,
} from '../../test/shape-fixtures';
import { ceremonyLine, convertWarnings, rowReview } from './review-lines';

// Shape spec §7: what the sidebar and the Convert modal say about ceremony, findings and the rehearsal.

const goal = goalProposal('density', ['cards', 'bars']);
const loose = looseTaskProposal('abandon');
const shapeId = mintId('Shape');

const view = (over: Parameters<typeof shapeViewDto>[0] = {}) =>
  shapeViewDto({
    proposals: [goal, loose],
    rehearsals: [
      { proposalId: goal.id, key: 'cards', hash: 'h1', rehearsed: true },
      { proposalId: goal.id, key: 'bars', hash: 'h2', rehearsed: false },
      { proposalId: loose.id, key: 'abandon', hash: 'h3', rehearsed: true },
    ],
    ...over,
  });

describe('rowReview', () => {
  it('reads each task of a goal as rehearsed or not, in the goal’s order', () => {
    expect(rowReview(view(), goal).tasks.map((t) => [t.key, t.state])).toEqual([
      ['cards', 'rehearsed'],
      ['bars', 'not_rehearsed'],
    ]);
  });

  it('reads an unrehearsed task as rehearsing while a rehearsal turn runs, and never marks a read one so', () => {
    const running = view({
      turn: { running: true, queued: 0, proposing: false, rehearsing: true },
    });
    expect(rowReview(running, goal).tasks.map((t) => t.state)).toEqual(['rehearsed', 'rehearsing']);
  });

  it('puts an open question under its task, and leaves resolved and dismissed ones out', () => {
    const open = findingDto(shapeId, {
      effortKey: 'density',
      taskKey: 'bars',
      reviewer: 'rehearsal',
      kind: 'question',
      severity: null,
      text: 'Which scrollbar?',
    });
    const done = findingDto(shapeId, {
      effortKey: 'density',
      taskKey: 'bars',
      reviewer: 'rehearsal',
      kind: 'question',
      severity: null,
      state: 'resolved',
      how: 'answered by your edit',
    });
    const review = rowReview(view({ findings: [open, done] }), goal);
    expect(review.tasks.find((t) => t.key === 'bars')?.questions).toEqual([open]);
    expect(review.tasks.find((t) => t.key === 'cards')?.questions).toEqual([]);
    expect(review.settled).toBe(1);
  });

  it('keeps an effort’s open findings apart from the questions', () => {
    const finding = findingDto(shapeId, { effortKey: 'abandon' });
    const other = findingDto(shapeId, { effortKey: 'density' });
    expect(rowReview(view({ findings: [finding, other] }), loose).findings).toEqual([finding]);
  });

  it('finds the row’s ceremony by its proposal', () => {
    const ceremony = {
      proposalId: loose.id,
      key: 'abandon',
      ceremony: 'spec' as const,
      reasons: ['loose_l' as const],
      skippedByYou: false,
      specWritten: false,
      spec: null,
    };
    expect(rowReview(view({ ceremony: [ceremony] }), loose).ceremony).toEqual(ceremony);
    expect(rowReview(view(), loose).ceremony).toBeUndefined();
  });
});

describe('ceremonyLine', () => {
  const base = {
    proposalId: loose.id,
    key: 'abandon',
    ceremony: 'spec' as const,
    reasons: [] as ('loose_l' | 'goal_xl' | 'many_tasks' | 'one_way_path')[],
    skippedByYou: false,
    specWritten: false,
    spec: null,
  };

  it.each([
    ['direct and nothing forces it', { ...base, ceremony: 'direct' as const }, null],
    ['a spec Claude chose', base, 'Spec · not written yet'],
    [
      'a spec an L task forces',
      { ...base, reasons: ['loose_l' as const] },
      'Spec required: an L task · not written yet',
    ],
    [
      'two reasons',
      { ...base, reasons: ['goal_xl' as const, 'many_tasks' as const], specWritten: true },
      'Spec required: a goal over 8 hours, more than 5 tasks · written',
    ],
    [
      'a one-way path',
      { ...base, reasons: ['one_way_path' as const] },
      'Spec required: it touches a one-way path · not written yet',
    ],
    [
      'a skipped spec',
      { ...base, ceremony: 'direct' as const, reasons: ['loose_l' as const], skippedByYou: true },
      'Spec skipped by you',
    ],
  ])('says %s', (_name, ceremony, line) => {
    expect(ceremonyLine(ceremony)).toBe(line);
  });
});

describe('convertWarnings', () => {
  it('is empty when nothing is open', () => {
    expect(convertWarnings(view(), [goal, loose], false)).toEqual([]);
  });

  it('warns, without blocking, about open questions, open findings and a review in flight', () => {
    const question = findingDto(shapeId, {
      effortKey: 'density',
      taskKey: 'bars',
      reviewer: 'rehearsal',
      kind: 'question',
      severity: null,
    });
    const finding = findingDto(shapeId, { effortKey: 'abandon' });
    expect(convertWarnings(view({ findings: [question, finding] }), [goal, loose], false)).toEqual([
      '1 rehearsal question is open',
      '1 review finding is open',
    ]);
    expect(
      convertWarnings(
        view({
          findings: [question, finding, { ...question, id: mintId('ShapeFinding') }],
        }),
        [goal, loose],
        false,
      ),
    ).toEqual(['2 rehearsal questions are open', '1 review finding is open']);
  });

  it('counts only what belongs to the proposals being converted', () => {
    const question = findingDto(shapeId, {
      effortKey: 'density',
      taskKey: 'bars',
      reviewer: 'rehearsal',
      kind: 'question',
      severity: null,
    });
    expect(convertWarnings(view({ findings: [question] }), [loose], false)).toEqual([]);
  });

  it('warns that a spec is forced and not written', () => {
    const ceremony = [
      {
        proposalId: loose.id,
        key: 'abandon',
        ceremony: 'spec' as const,
        reasons: ['loose_l' as const],
        skippedByYou: false,
        specWritten: false,
        spec: null,
      },
    ];
    expect(convertWarnings(view({ ceremony }), [loose], false)).toEqual([
      'abandon needs a spec and has none',
    ]);
  });

  it('says a rehearsal is running while one is', () => {
    expect(convertWarnings(view(), [goal], true)).toEqual(['The rehearsal is still running']);
  });
});
