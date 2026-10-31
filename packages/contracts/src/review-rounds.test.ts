import { describe, expect, it } from 'vitest';
import { mintId } from './ids';
import { findingBody, parseFindings, rejectionsSentBack, reviewRounds } from './review-rounds';
import { FOLLOW_UPS_HEADING, type WorkstreamStep } from './steps';

describe('parseFindings', () => {
  it('stops at the follow-up list 10db appends, which names tasks and is no finding', () => {
    const summary = `1. BLOCKING a.ts:1 still broken.\n\n${FOLLOW_UPS_HEADING}\n- tsk_x Fix b.ts:9 messages`;
    expect(parseFindings(summary)).toEqual([
      { severity: 'BLOCKING', location: 'a.ts:1', text: 'BLOCKING a.ts:1 still broken.' },
    ]);
  });

  it.each([
    {
      name: 'a blocking finding with a file and line',
      summary:
        '1. BLOCKING apps/daemon/src/runner/runner.ts:673: the card hides the findings.\n   Trigger: the retry limit.\n   Expected: show them.',
      expected: [
        {
          severity: 'BLOCKING',
          location: 'apps/daemon/src/runner/runner.ts:673',
          text: 'BLOCKING apps/daemon/src/runner/runner.ts:673: the card hides the findings.',
        },
      ],
    },
    {
      name: 'a bracketed lowercase severity and a line range in backticks',
      summary: '1) [blocking] `src/a.ts:10-14` loses the note\n2) [nit] src/b.tsx:3 spacing',
      expected: [
        {
          severity: 'BLOCKING',
          location: 'src/a.ts:10-14',
          text: '[blocking] `src/a.ts:10-14` loses the note',
        },
        { severity: 'NIT', location: 'src/b.tsx:3', text: '[nit] src/b.tsx:3 spacing' },
      ],
    },
    {
      name: 'a finding with no severity or location',
      summary: '1. The empty state has no test.',
      expected: [{ severity: null, location: null, text: 'The empty state has no test.' }],
    },
    {
      name: 'a location found on a later line of the finding',
      summary: '1. NOTE the retry drops the note.\n   See src/team/steps.ts:120 for where.',
      expected: [
        {
          severity: 'NOTE',
          location: 'src/team/steps.ts:120',
          text: 'NOTE the retry drops the note.',
        },
      ],
    },
    {
      name: 'text before the first number (not a finding)',
      summary: 'Rejecting.\n\n1. BLOCKING a.ts:1 broken',
      expected: [{ severity: 'BLOCKING', location: 'a.ts:1', text: 'BLOCKING a.ts:1 broken' }],
    },
    {
      name: 'notes with no numbering (one finding)',
      summary: 'The change misses the empty state.\nAdd a test.',
      expected: [{ severity: null, location: null, text: 'The change misses the empty state.' }],
    },
    {
      name: 'a host and port (not a location)',
      summary: '1. calls localhost:8080 twice',
      expected: [{ severity: null, location: null, text: 'calls localhost:8080 twice' }],
    },
  ])('reads $name', ({ summary, expected }) => {
    expect(parseFindings(summary)).toEqual(expected);
  });

  it('cuts a long first line', () => {
    const [finding] = parseFindings(`1. ${'x'.repeat(500)}`);
    expect(finding?.text.length).toBeLessThanOrEqual(240);
    expect(finding?.text.endsWith('…')).toBe(true);
  });
});

describe('findingBody', () => {
  it.each([
    {
      name: 'a severity word and a location before the sentence',
      finding: {
        severity: 'BLOCKING',
        location: 'apps/daemon/src/runner/runner.ts:673',
        text: 'BLOCKING apps/daemon/src/runner/runner.ts:673: the card hides the findings.',
      },
      body: 'the card hides the findings.',
    },
    {
      name: 'a bracketed severity and a quoted range',
      finding: {
        severity: 'BLOCKING',
        location: 'src/a.ts:10-14',
        text: '[blocking] `src/a.ts:10-14` loses the note',
      },
      body: 'loses the note',
    },
    {
      name: 'neither',
      finding: { severity: null, location: null, text: 'The empty state has no test.' },
      body: 'The empty state has no test.',
    },
    {
      name: 'a severity word that is also inside another word',
      finding: {
        severity: 'NOTE',
        location: 'src/a.ts:1',
        text: 'Denote the order NOTE src/a.ts:1',
      },
      body: 'Denote the order',
    },
    {
      name: 'a lowercase severity word, which is no severity',
      finding: { severity: 'BLOCKING', location: null, text: 'BLOCKING: blocking calls stall' },
      body: 'blocking calls stall',
    },
    {
      name: 'nothing left once both are taken out',
      finding: { severity: 'NOTE', location: 'a.ts:1', text: 'NOTE a.ts:1' },
      body: 'NOTE a.ts:1',
    },
  ])('leaves the sentence of $name', ({ finding, body }) => {
    expect(findingBody(finding)).toBe(body);
  });
});

const result = (verdict: 'approve' | 'reject' | null, at: string, summary = 'notes') => ({
  summary,
  verdict,
  sessionId: mintId('Session'),
  at,
});

const step = (over: Partial<WorkstreamStep>): WorkstreamStep => ({
  role: 'review',
  personaId: null,
  personaName: 'Reviewer',
  tools: 'read_only',
  score: 'intelligence',
  profileId: null,
  model: 'opus',
  effort: 'medium',
  need: 0,
  reason: '',
  overBudget: false,
  pinned: false,
  status: 'pending',
  attempts: 0,
  startedAt: null,
  sessionFloor: 0,
  result: null,
  earlier: [],
  sentBack: 0,
  ...over,
});

describe('reviewRounds', () => {
  const steps = [
    step({ role: 'implement', tools: 'edit', personaName: 'Implementer' }),
    step({
      earlier: [
        result('reject', '2026-10-29T10:00:00.000Z', 'first'),
        result('reject', '2026-10-29T11:00:00.000Z', 'second'),
      ],
      result: result('approve', '2026-10-29T12:00:00.000Z', 'third'),
    }),
  ];

  it('lists every verdict a step gave, newest first, with the step that gave it', () => {
    const rounds = reviewRounds(steps);
    expect(rounds.map((r) => [r.result.summary, r.result.verdict, r.stepIndex, r.role])).toEqual([
      ['third', 'approve', 1, 'review'],
      ['second', 'reject', 1, 'review'],
      ['first', 'reject', 1, 'review'],
    ]);
  });

  it('leaves out a result with no verdict, such as a plan', () => {
    const plan = step({
      role: 'plan',
      personaName: 'Planner',
      result: result(null, '2026-10-29T09:00:00.000Z', 'the plan'),
    });
    expect(reviewRounds([plan, ...steps]).map((r) => r.result.summary)).not.toContain('the plan');
  });

  it('interleaves the rounds of different steps by time', () => {
    const planReview = step({
      role: 'plan_review',
      personaName: 'Plan reviewer',
      earlier: [result('reject', '2026-10-29T10:30:00.000Z', 'plan rejected')],
    });
    expect(reviewRounds([planReview, ...steps]).map((r) => r.result.summary)).toEqual([
      'third',
      'second',
      'plan rejected',
      'first',
    ]);
  });
});

describe('rejectionsSentBack', () => {
  const rejections = [
    result('reject', '2026-10-29T10:00:00.000Z'),
    result('reject', '2026-10-29T11:00:00.000Z'),
    result('reject', '2026-10-29T11:30:00.000Z'),
  ];
  it.each([
    { name: 'no rounds', steps: [step({})], count: 0 },
    {
      name: 'a rejection that sent the work back',
      steps: [step({ earlier: rejections.slice(0, 1), sentBack: 1 })],
      count: 1,
    },
    {
      name: 'the rejection that used the last attempt up, which sent nothing back',
      steps: [
        step({
          earlier: rejections,
          result: result('reject', '2026-10-29T12:00:00.000Z'),
          sentBack: 3,
        }),
      ],
      count: 3,
    },
    {
      // The review rejected 4 times and the builder retried; the rerun implement step then failed
      // its gate twice (attempt 2), and the review has not run since.
      name: 'none since a retry, whatever came before it',
      steps: [
        step({ role: 'implement', tools: 'edit', attempts: 2 }),
        step({ earlier: [...rejections, result('reject', '2026-10-29T12:00:00.000Z')] }),
      ],
      count: 0,
    },
    {
      name: 'the send-backs of every step that gives a verdict',
      steps: [
        step({ role: 'plan_review', earlier: rejections.slice(0, 1), sentBack: 1 }),
        step({ earlier: rejections.slice(1), sentBack: 1 }),
      ],
      count: 2,
    },
  ])('counts $name', ({ steps, count }) => {
    expect(rejectionsSentBack({ steps })).toBe(count);
  });
});
