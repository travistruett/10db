import { mintId, type StepRole, type Verdict, type WorkstreamStep } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { advanceSteps, moveAfter, restartStep, sendBackSteps } from './step-flow';

const NOW = '2026-10-17T12:00:00.000Z';
const ENTRY = { now: NOW, sessions: 2 };
const step = (role: StepRole, verdict: Verdict | null | 'none' = 'none'): WorkstreamStep => ({
  role,
  personaId: null,
  personaName: role,
  tools: role === 'implement' ? 'edit' : 'read_only',
  score: role === 'implement' ? 'coding' : 'intelligence',
  profileId: null,
  model: 'sonnet',
  effort: 'medium',
  need: 40,
  reason: 'test',
  overBudget: false,
  pinned: false,
  status: 'running',
  attempts: 0,
  startedAt: null,
  sessionFloor: 0,
  earlier: [],
  result:
    verdict === 'none'
      ? null
      : { summary: 'notes', verdict, sessionId: mintId('Session'), at: NOW },
});

describe('moveAfter', () => {
  it.each([
    {
      name: 'an implement step with a step after it advances',
      steps: [step('implement'), step('review')],
      at: 0,
      move: { kind: 'advance', to: 1 },
    },
    {
      name: 'the last implement step is done',
      steps: [step('implement')],
      at: 0,
      move: { kind: 'done' },
    },
    {
      name: 'a plan with a result advances',
      steps: [step('plan', null), step('implement')],
      at: 0,
      move: { kind: 'advance', to: 1 },
    },
    {
      name: 'an approval on the last step is done',
      steps: [step('implement'), step('review', 'approve')],
      at: 1,
      move: { kind: 'done' },
    },
    {
      name: 'a review rejection goes back to the implement step',
      steps: [step('implement'), step('review', 'reject'), step('qa')],
      at: 1,
      move: { kind: 'send_back', to: 0 },
    },
    {
      name: 'a QA rejection goes back to the nearest implement step',
      steps: [
        step('plan', null),
        step('implement'),
        step('review', 'approve'),
        step('qa', 'reject'),
      ],
      at: 3,
      move: { kind: 'send_back', to: 1 },
    },
    {
      name: 'a plan-review rejection goes back to the plan',
      steps: [step('plan', null), step('plan_review', 'reject'), step('implement')],
      at: 1,
      move: { kind: 'send_back', to: 0 },
    },
    {
      name: 'a review with no result has none',
      steps: [step('implement'), step('review')],
      at: 1,
      move: { kind: 'no_result' },
    },
    {
      name: 'a workstream with no stored steps is done',
      steps: [],
      at: 0,
      move: { kind: 'done' },
    },
  ] as const)('$name', ({ steps, at, move }) => {
    expect(moveAfter(steps, at)).toEqual(move);
  });
});

describe('advanceSteps, sendBackSteps and restartStep', () => {
  it('marks the step done and starts the next with no result, stamped with its entry', () => {
    const steps = [step('implement'), { ...step('review', 'approve'), status: 'pending' as const }];
    expect(
      advanceSteps(steps, 0, 1, ENTRY).map((s) => [
        s.status,
        s.result,
        s.startedAt,
        s.sessionFloor,
      ]),
    ).toEqual([
      ['done', null, null, 0],
      ['running', null, NOW, 2],
    ]);
  });

  it('keeps the rejecting step’s notes and restarts the target, counting the retry', () => {
    const first = step('implement');
    const steps = [first, step('review', 'reject')];
    const target: WorkstreamStep = { ...first, model: 'opus' };
    const moved = sendBackSteps(steps, 1, 0, target, ENTRY);
    expect(moved[0]).toMatchObject({
      model: 'opus',
      status: 'running',
      attempts: 1,
      result: null,
      startedAt: NOW,
      sessionFloor: 2,
    });
    expect(moved[1]).toMatchObject({ status: 'pending', result: { verdict: 'reject' } });
  });

  it('keeps a read-only target’s previous result when it is sent back', () => {
    const plan = step('plan', null);
    const moved = sendBackSteps([plan, step('plan_review', 'reject')], 1, 0, plan, ENTRY);
    expect(moved[0]).toMatchObject({ status: 'running', result: { summary: 'notes' } });
  });

  it('restarts a failed step clean for a retry, keeping its session floor', () => {
    const steps = [
      step('implement'),
      { ...step('review', 'reject'), status: 'failed' as const, attempts: 3, sessionFloor: 5 },
    ];
    expect(restartStep(steps, 1, NOW)[1]).toMatchObject({
      status: 'running',
      attempts: 0,
      result: null,
      startedAt: NOW,
      sessionFloor: 5,
    });
  });

  it('keeps a rejection when its step is entered again, so no round is lost', () => {
    const first = step('implement');
    const rejected = step('review', 'reject');
    const sentBack = sendBackSteps([first, rejected], 1, 0, first, ENTRY);
    // The rejecting step holds its notes for the rework, and files them away once it runs again.
    expect(sentBack[1]?.earlier).toEqual([]);
    const again = advanceSteps(sentBack, 0, 1, ENTRY);
    expect(again[1]).toMatchObject({ result: null, earlier: [rejected.result] });
  });

  it('files a new round after the ones already kept', () => {
    const older = step('review', 'reject');
    const kept = older.result ? [older.result] : [];
    const newer = { ...step('review', 'reject'), earlier: kept };
    const rerun = advanceSteps([step('implement'), newer], 0, 1, ENTRY);
    expect(rerun[1]?.earlier).toEqual([...kept, newer.result]);
  });

  it('keeps a failed step’s rejection when a retry restarts it', () => {
    const rejected = { ...step('review', 'reject'), status: 'failed' as const };
    expect(restartStep([step('implement'), rejected], 1, NOW)[1]).toMatchObject({
      result: null,
      earlier: [rejected.result],
    });
  });

  it('files a read-only target’s kept result nowhere, since it is still the result', () => {
    const plan = step('plan', null);
    const moved = sendBackSteps([plan, step('plan_review', 'reject')], 1, 0, plan, ENTRY);
    expect(moved[0]?.earlier).toEqual([]);
  });
});
