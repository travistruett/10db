import { describe, expect, it } from 'vitest';
import {
  BATCH_TRANSITIONS,
  canBatchTransition,
  latestPerTask,
  shipReadiness,
  UNFINISHED_BATCH_STATES,
} from './batch-workflow';
import {
  BatchDto,
  BatchStartInput,
  BatchStartResult,
  ProjectViewDto,
  TaskStartResult,
} from './batches';
import {
  DEFAULT_WORKTREE_SEED,
  ProjectInput,
  TaskInput,
  TaskPatch,
  WorktreeSeedName,
} from './entities';
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

  describe('a title, which becomes the pull request title', () => {
    const titles = [
      { name: 'quotes, $() and accents', title: 'Say "hi" — $(whoami) café ✓', ok: true },
      { name: 'a newline', title: 'Add\ngreetings', ok: false },
      { name: 'a carriage return', title: 'Add\rgreetings', ok: false },
      { name: 'a tab', title: 'Add\tgreetings', ok: false },
      { name: 'a NUL', title: 'Add\u0000greetings', ok: false },
      { name: 'DEL', title: 'Add\u007fgreetings', ok: false },
      { name: 'a C1 control (NEL)', title: 'Add\u0085greetings', ok: false },
    ];
    it.each(titles)('BatchStartInput with $name', ({ title, ok }) => {
      expect(BatchStartInput.safeParse({ title, taskIds: [task] }).success).toBe(ok);
    });
    it.each(titles)('TaskInput with $name', ({ title, ok }) => {
      const input = { title, acceptanceCriteria: ['x'], areas: ['api'] };
      expect(TaskInput.safeParse(input).success).toBe(ok);
    });
    it.each(titles)('TaskPatch with $name', ({ title, ok }) => {
      expect(TaskPatch.safeParse({ title }).success).toBe(ok);
    });
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
      worktreePath: null,
      createdAt: '2026-10-21T12:00:00.000Z',
      updatedAt: '2026-10-21T12:00:00.000Z',
    });
    const parsed = TaskStartResult.parse(batch);
    expect('taskId' in parsed).toBe(false);
    expect(parsed).toEqual(batch);
  });
});

describe('WorktreeSeedName', () => {
  it.each([
    { name: 'a plain directory name', value: 'node_modules', ok: true },
    { name: "cargo's target", value: 'target', ok: true },
    { name: 'a dotted name', value: '.venv', ok: true },
    { name: 'a path', value: 'apps/x', ok: false },
    { name: 'the current directory', value: '.', ok: false },
    { name: 'the parent directory', value: '..', ok: false },
    { name: "git's own directory", value: '.git', ok: false },
    { name: 'empty', value: '', ok: false },
    { name: 'a NUL', value: 'a\0b', ok: false },
    { name: 'over 255 characters', value: 'x'.repeat(256), ok: false },
  ])('$name', ({ value, ok }) => {
    expect(WorktreeSeedName.safeParse(value).success).toBe(ok);
  });
});

describe('worktree mode contracts', () => {
  const project = {
    name: 'App',
    repoPath: '/tmp/app',
    gateCommand: 'make gate',
    areas: [{ name: 'api', globs: ['src/**'] }],
  };

  it('ProjectInput refuses worktree mode with local delivery', () => {
    const result = ProjectInput.safeParse({ ...project, workspaceMode: 'worktree' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['workspaceMode']);
  });

  it('ProjectInput takes worktree mode with pull request delivery', () => {
    const result = ProjectInput.safeParse({
      ...project,
      workspaceMode: 'worktree',
      delivery: 'pull_request',
      prTitlePrefix: 'feat(app)',
    });
    expect(result.success).toBe(true);
  });

  it('ProjectInput defaults to shared and seeds node_modules', () => {
    const parsed = ProjectInput.parse(project);
    expect(parsed.workspaceMode).toBe('shared');
    expect(parsed.worktreeSeed).toEqual([...DEFAULT_WORKTREE_SEED]);
    expect(parsed.worktreeSeed).toEqual(['node_modules']);
  });

  it('ProjectInput caps the seed at 32 names', () => {
    const seed = Array.from({ length: 33 }, (_, i) => `d${String(i)}`);
    expect(ProjectInput.safeParse({ ...project, worktreeSeed: seed }).success).toBe(false);
  });

  it('BatchStartInput takes a batchId', () => {
    const batchId = mintId('Batch');
    const parsed = BatchStartInput.parse({ title: 'Fix', taskIds: [mintId('Task')], batchId });
    expect(parsed.batchId).toBe(batchId);
    expect(BatchStartInput.parse({ title: 'Fix', taskIds: [mintId('Task')] }).batchId).toBe(
      undefined,
    );
  });

  const batch = {
    id: mintId('Batch'),
    projectId: mintId('Project'),
    title: 'Greetings',
    state: 'OPEN',
    branch: 'b',
    baseBranch: 'main',
    baseSha: 'a'.repeat(40),
    repo: null,
    prUrl: null,
    gateExitCode: null,
    gateLogPath: null,
    failure: null,
    worktreePath: '/tmp/wt/x',
    createdAt: '2026-10-21T12:00:00.000Z',
    updatedAt: '2026-10-21T12:00:00.000Z',
  };

  it('BatchDto carries a nullable worktree path', () => {
    expect(BatchDto.parse(batch).worktreePath).toBe('/tmp/wt/x');
    expect(BatchDto.parse({ ...batch, worktreePath: null }).worktreePath).toBe(null);
  });

  it('BatchStartResult is an array of batches', () => {
    expect(BatchStartResult.parse([batch, batch])).toHaveLength(2);
    expect(BatchStartResult.safeParse(batch).success).toBe(false);
  });

  it('ProjectViewDto without openBatches reads as none', () => {
    const dto = {
      id: mintId('Project'),
      name: 'App',
      repoPath: '/tmp/app',
      gateCommand: 'make gate',
      areas: [],
      hazards: [],
      maxLanes: 2,
      provider: 'claude',
      accountId: mintId('Account'),
      movedFromAccountId: null,
      moveBackAt: null,
      fallbackAccountId: null,
      usageHandoffAt: 0.9,
      handoffPct: 40,
      nudgePct: 50,
      humanWaitMinutes: 10,
      flowId: null,
      budgetCeiling: null,
      delivery: 'local',
      baseBranch: 'main',
      prTitlePrefix: null,
      allowedCommands: [],
      sandboxLoopback: false,
      workspaceMode: 'shared',
      worktreeSeed: ['node_modules'],
      createdAt: '2026-10-21T12:00:00.000Z',
      updatedAt: '2026-10-21T12:00:00.000Z',
    };
    expect(ProjectViewDto.parse(dto).openBatches).toEqual([]);
  });
});
