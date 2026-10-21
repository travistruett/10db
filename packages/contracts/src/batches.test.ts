import { describe, expect, it } from 'vitest';
import {
  BATCH_TRANSITIONS,
  canBatchTransition,
  latestPerTask,
  shipReadiness,
  UNFINISHED_BATCH_STATES,
} from './batch-workflow';
import { BatchDto, BatchStartInput, TaskStartResult } from './batches';
import { BranchName, PrTitlePrefix } from './git-names';
import { mintId } from './ids';
import { BatchState as B, WorkstreamState as S, type BatchState } from './states';

describe('batch state machine', () => {
  it.each<[BatchState, BatchState]>([
    [B.Cutting, B.Open],
    [B.Open, B.Shipping],
    [B.Open, B.Failed],
    [B.Open, B.Abandoned],
    [B.Shipping, B.Shipped],
    [B.Shipping, B.Closed],
    [B.Shipping, B.Failed],
    [B.Failed, B.Shipping],
    [B.Failed, B.Open],
    [B.Failed, B.Abandoned],
  ])('allows %s -> %s', (from, to) => {
    expect(canBatchTransition(from, to)).toBe(true);
  });

  it.each<[BatchState, BatchState]>([
    [B.Cutting, B.Shipping],
    [B.Cutting, B.Failed],
    [B.Cutting, B.Abandoned],
    [B.Open, B.Shipped],
    [B.Open, B.Closed],
    [B.Shipping, B.Open],
    [B.Shipping, B.Abandoned],
    [B.Failed, B.Shipped],
    [B.Shipped, B.Open],
    [B.Closed, B.Shipping],
    [B.Abandoned, B.Open],
  ])('refuses %s -> %s', (from, to) => {
    expect(canBatchTransition(from, to)).toBe(false);
  });

  it('leaves SHIPPED, CLOSED and ABANDONED for good', () => {
    for (const s of [B.Shipped, B.Closed, B.Abandoned]) expect(BATCH_TRANSITIONS[s]).toEqual([]);
  });

  it('counts CUTTING, OPEN, SHIPPING and FAILED as unfinished', () => {
    expect([...UNFINISHED_BATCH_STATES].sort()).toEqual(['CUTTING', 'FAILED', 'OPEN', 'SHIPPING']);
  });
});

describe('shipReadiness', () => {
  it.each([
    { name: 'no workstreams', states: [], expected: 'ready' },
    { name: 'all done', states: [S.Done, S.Done], expected: 'ready' },
    { name: 'done and cancelled', states: [S.Done, S.Cancelled], expected: 'ready' },
    { name: 'a failed one among done ones', states: [S.Done, S.Failed], expected: 'ship_anyway' },
    { name: 'a running one', states: [S.Done, S.Running], expected: 'blocked' },
    {
      name: 'a waiting one beside a failed one',
      states: [S.Failed, S.WaitingHuman],
      expected: 'blocked',
    },
    { name: 'a paused one', states: [S.PausedLimit], expected: 'blocked' },
    { name: 'a queued one', states: [S.Queued], expected: 'blocked' },
  ])('$name', ({ states, expected }) => {
    expect(shipReadiness(states)).toBe(expected);
  });
});

describe('latestPerTask', () => {
  it("keeps each task's last row in the order tasks first appear", () => {
    const a = mintId('Task');
    const b = mintId('Task');
    const rows = [
      { taskId: a, n: 1 },
      { taskId: b, n: 2 },
      { taskId: a, n: 3 },
    ];
    expect(latestPerTask(rows)).toEqual([
      { taskId: a, n: 3 },
      { taskId: b, n: 2 },
    ]);
  });
});

describe('names that reach git and gh', () => {
  it.each([
    { value: 'main', ok: true },
    { value: 'release/2.x', ok: true },
    { value: 'feat_x-1.2', ok: true },
    { value: '-delete', ok: false },
    { value: 'main..x', ok: false },
    { value: 'a//b', ok: false },
    { value: 'main/', ok: false },
    { value: 'main.', ok: false },
    { value: 'x.lock', ok: false },
    { value: 'a@{1}', ok: false },
    { value: 'has space', ok: false },
    { value: '$(id)', ok: false },
    { value: '', ok: false },
  ])('branch name "$value"', ({ value, ok }) => {
    expect(BranchName.safeParse(value).success).toBe(ok);
  });

  it.each([
    { value: 'feat(daemon)', ok: true },
    { value: 'fix', ok: true },
    { value: 'feat(api)!', ok: true },
    { value: 'Feat(daemon)', ok: false },
    { value: 'feat(daemon):', ok: false },
    { value: 'feat daemon', ok: false },
    { value: 'feat()', ok: false },
    { value: '', ok: false },
  ])('PR title prefix "$value"', ({ value, ok }) => {
    expect(PrTitlePrefix.safeParse(value).success).toBe(ok);
  });
});

describe('batch schemas', () => {
  const task = mintId('Task');
  it.each([
    {
      name: 'a title and two tasks',
      input: { title: 'Greetings', taskIds: [task, mintId('Task')] },
      ok: true,
    },
    { name: 'no tasks', input: { title: 'Empty', taskIds: [] }, ok: false },
    { name: 'the same task twice', input: { title: 'Twice', taskIds: [task, task] }, ok: false },
    { name: 'an empty title', input: { title: '', taskIds: [task] }, ok: false },
    {
      name: 'a title over 200 characters',
      input: { title: 'x'.repeat(201), taskIds: [task] },
      ok: false,
    },
    { name: 'a task id that is not one', input: { title: 'Bad', taskIds: ['tsk_1'] }, ok: false },
  ])('BatchStartInput: $name', ({ input, ok }) => {
    expect(BatchStartInput.safeParse(input).success).toBe(ok);
  });

  it('tells a started batch from a started workstream', () => {
    const batch = BatchDto.parse({
      id: mintId('Batch'),
      projectId: mintId('Project'),
      title: 'Greetings',
      state: 'CUTTING',
      branch: null,
      baseBranch: 'main',
      baseSha: null,
      repo: null,
      prUrl: null,
      gateExitCode: null,
      gateLogPath: null,
      failure: null,
      createdAt: '2026-10-21T12:00:00.000Z',
      updatedAt: '2026-10-21T12:00:00.000Z',
    });
    const parsed = TaskStartResult.parse(batch);
    expect('taskId' in parsed).toBe(false);
    expect(parsed).toEqual(batch);
  });
});
