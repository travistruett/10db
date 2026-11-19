import { BatchDto, ConflictError, NOTICE_BODY_MAX, type TaskDto } from '@10db/contracts';
import { getBatch, insertWorkstream, listBatches, listWorkstreams } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { GhError } from '../github';

let h: DeliveryHarness;
afterEach(() => {
  h.close();
});

/** Starts the tasks as one batch and waits for its cut. */
async function start(title: string, ...tasks: TaskDto[]): Promise<BatchDto> {
  const batch = h.only(
    h.starter.startBatch(h.project.id, { title, taskIds: tasks.map((t) => t.id) }),
  );
  await h.jobs.idle();
  return getBatch(h.store.db, batch.id);
}

/** Commits a file, finishes every workstream of the batch and waits for it to ship. */
async function ship(batch: BatchDto): Promise<BatchDto> {
  h.commit(`src/api/${batch.id}.txt`);
  for (const ws of listWorkstreams(h.store.db, { batchId: batch.id })) h.settle(ws.id, 'DONE');
  await h.jobs.idle();
  return getBatch(h.store.db, batch.id);
}

const autoMergeCalls = () => h.gh.calls.filter((c) => c.method === 'prAutoMerge');
const merges = () => h.gh.calls.filter((c) => c.method === 'prMerge');

/** A task landing in `feature/x` that work is under way on: it has a queued workstream. */
function underWay(title: string): TaskDto {
  const task = h.addTask(title, { landing: { kind: 'branch', branch: 'feature/x' } });
  h.state.write((c) => {
    insertWorkstream(c, task.id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } });
  });
  return task;
}

describe('a pull request that lands in the base branch', () => {
  it('is opened against it and merges by itself once checks pass', async () => {
    h = createDeliveryHarness();
    const batch = await start('Greetings', h.addTask('Alpha'));
    expect(batch).toMatchObject({ baseBranch: 'main', autoMerge: true });
    const shipped = await ship(batch);
    expect(shipped.state).toBe('SHIPPED');
    expect(h.gh.prCreates()).toMatchObject([{ base: 'main', head: batch.branch }]);
    expect(h.gh.autoMerged).toEqual([shipped.prUrl]);
  });

  it('turns auto-merge on for a pull request an earlier run opened, but not one already merged', async () => {
    h = createDeliveryHarness();
    const batch = await start('Greetings', h.addTask('Alpha'));
    const url = h.gh.openPr(batch.branch ?? '');
    const shipped = await ship(batch);
    expect(h.gh.prCreates()).toEqual([]);
    expect(shipped.prUrl).toBe(url);
    expect(h.gh.autoMerged).toEqual([url]);

    h.close();
    h = createDeliveryHarness();
    const second = await start('Second', h.addTask('Beta'));
    h.gh.openPr(second.branch ?? '', 'MERGED');
    await ship(second);
    expect(h.gh.autoMerged).toEqual([]);
  });
});

describe('a pull request held for the builder', () => {
  /** What every held pull request shows: opened against main, never set to merge, no card. */
  function expectHeld(batch: BatchDto, shipped: BatchDto): void {
    expect(batch).toMatchObject({ baseBranch: 'main', autoMerge: false });
    expect(shipped.state).toBe('SHIPPED');
    expect(h.gh.prCreates()).toMatchObject([{ base: 'main' }]);
    expect(autoMergeCalls()).toEqual([]);
    expect(h.gh.calls.some((c) => c.method === 'repoAllowsAutoMerge')).toBe(false);
    expect(h.cards()).toEqual([]);
  }

  it('never merges by itself: a task set to hold', async () => {
    h = createDeliveryHarness();
    const batch = await start('Greetings', h.addTask('Alpha', { landing: { kind: 'hold' } }));
    expectHeld(batch, await ship(batch));
  });

  it('never merges by itself a task that starts from a project that holds, not even when the base has no required checks, and lets a task merge although its project holds', async () => {
    h = createDeliveryHarness({ landing: 'hold' });
    h.gh.noRequiredChecks = true;
    const batch = await start('Greetings', h.addTask('Alpha'));
    expectHeld(batch, await ship(batch));
    expect(merges()).toEqual([]);

    h.gh.noRequiredChecks = false;
    const merging = await ship(
      await start('Fix', h.addTask('Beta', { landing: { kind: 'base' } })),
    );
    expect(h.gh.autoMerged).toEqual([merging.prUrl]);
  });
});

describe('a pull request that lands in another branch', () => {
  it('refuses a branch origin does not have, in plain words, before anything starts; is built from a branch origin has, targets it, merges by itself, and says so on the batch when no other open work lands there', async () => {
    h = createDeliveryHarness();
    const feature = h.teammatePush('feature/x', 'src/api/feature.txt');

    const before = h.git$('rev-parse', 'HEAD');
    const nope = h.addTask('Beta', { landing: { kind: 'branch', branch: 'feature/nope' } });
    h.starter.startBatch(h.project.id, { title: 'Nope', taskIds: [nope.id] });
    await h.jobs.idle();
    const card = h.only(h.cards());
    expect(card.title).toBe('Not started: origin has no branch named feature/nope');
    expect(card.body).toContain('feature/nope');
    expect(card.body).toContain('Create it on origin');
    expect(listBatches(h.store.db, { projectId: h.project.id })).toEqual([]);
    expect(h.git$('rev-parse', 'HEAD')).toBe(before);
    expect(h.git$('branch', '--show-current')).toBe('main');
    // The workstream the start inserted with the row is cancelled with it, so nothing runs.
    expect(listWorkstreams(h.store.db, {})).toMatchObject([
      { taskId: nope.id, state: 'CANCELLED', batchId: null },
    ]);

    const task = h.addTask('Alpha', { landing: { kind: 'branch', branch: 'feature/x' } });
    const batch = await start('Greetings', task);
    expect(batch).toMatchObject({
      state: 'OPEN',
      baseBranch: 'feature/x',
      autoMerge: true,
      baseSha: feature,
    });
    expect(h.git$('rev-parse', 'HEAD')).toBe(feature);
    // Level with the base, but no other open work lands there.
    expect(batch.notices).toMatchObject([
      {
        key: 'landing-unused',
        tone: 'warning',
        line: expect.stringContaining('feature/x') as unknown,
        body: expect.stringContaining('feature/x') as unknown,
      },
    ]);
    // No card beyond the refusal's.
    expect(h.only(h.cards()).id).toBe(card.id);

    const shipped = await ship(batch);
    expect(shipped.state).toBe('SHIPPED');
    expect(h.gh.prCreates()).toMatchObject([{ base: 'feature/x', head: batch.branch }]);
    expect(h.gh.autoMerged).toEqual([shipped.prUrl]);
  });

  it('says so on the batch, naming the branch, when it lacks commits the base has, and still starts', async () => {
    h = createDeliveryHarness();
    h.teammatePush('feature/x', 'src/api/feature.txt');
    h.teammatePush('main', 'src/api/fix.txt');
    // Work is under way on another task there, so only the behind notice is earned.
    underWay('Beta');
    const task = h.addTask('Alpha', { landing: { kind: 'branch', branch: 'feature/x' } });
    const batch = await start('Greetings', task);
    expect(batch.state).toBe('OPEN');
    expect(batch.notices).toMatchObject([
      {
        key: 'landing-behind',
        tone: 'warning',
        line: expect.stringContaining('feature/x') as unknown,
        body: expect.stringContaining('main') as unknown,
      },
    ]);
    expect(h.cards()).toEqual([]);
  });
});

describe('when the repository does not allow auto-merge', () => {
  it("says so on the batch's tasks, with no card, and leaves the pull request for the builder", async () => {
    h = createDeliveryHarness();
    h.gh.autoMergeAllowed = false;
    const first = await ship(await start('One', h.addTask('Alpha')));
    expect(first.state).toBe('SHIPPED');
    expect(first.prUrl).not.toBeNull();
    expect(autoMergeCalls()).toEqual([]);
    expect(h.cards()).toEqual([]);
    const notice = h.only(first.notices);
    expect(notice.line).toContain("acme/widgets doesn't allow auto-merge");
    expect(notice.body).toContain(first.prUrl ?? '');
    expect(notice.body).toContain('Allow auto-merge');

    // A second pull request in the same project says the same on its own tasks, and still no card.
    const second = await ship(await start('Two', h.addTask('Beta')));
    expect(h.only(second.notices).body).toContain(second.prUrl ?? '');
    expect(h.cards()).toEqual([]);
    expect(autoMergeCalls()).toEqual([]);
  });
});

describe('when GitHub refuses to turn auto-merge on', () => {
  it("still ships, tells the batch's tasks the pull request waits for the builder, and keeps the link and a board that loads when gh says far more than a notice holds", async () => {
    h = createDeliveryHarness();
    h.gh.failNext.set(
      'prAutoMerge',
      new GhError('failed', 'gh pr merge failed (exit 1): Pull request is in draft status'),
    );
    const shipped = await ship(await start('One', h.addTask('Alpha')));
    expect(shipped.state).toBe('SHIPPED');
    expect(h.cards()).toEqual([]);
    const notice = h.only(shipped.notices);
    expect(notice.line).toContain('not set to merge by itself');
    expect(notice.body).toContain(shipped.prUrl ?? '');
    expect(notice.body).toContain('draft status');

    const graphql = `GraphQL: ${'Base branch was modified. Review and try the merge again. '.repeat(400)}`;
    h.gh.failNext.set(
      'prAutoMerge',
      new GhError('failed', `gh pr merge failed (exit 1): ${graphql}`),
    );
    const long = await ship(await start('Two', h.addTask('Beta')));
    expect(() => BatchDto.parse(long)).not.toThrow();
    const cut = h.only(long.notices);
    expect(cut.body.length).toBeLessThanOrEqual(NOTICE_BODY_MAX);
    expect(cut.body).toContain('Base branch was modified');
    expect(cut.body).toContain('…');
    expect(cut.body).toContain(long.prUrl ?? 'no pull request');
    expect(merges()).toEqual([]);
  });
});

describe('when the base branch has no required checks', () => {
  it('squash-merges the pull request right after it opens, with no card, never reading the required checks when the gate ran', async () => {
    h = createDeliveryHarness();
    h.gh.noRequiredChecks = true;
    const shipped = await ship(await start('One', h.addTask('Alpha')));
    expect(shipped.state).toBe('SHIPPED');
    expect(h.gh.merged).toEqual([shipped.prUrl]);
    expect(h.cards()).toEqual([]);
    expect(h.gh.calls.some((c) => c.method === 'prRequiredChecks')).toBe(false);
    // What the pull request watch reads next, which puts the task in Done.
    const read = await h.gh.prView({ repo: 'acme/widgets', ref: shipped.prUrl ?? '' });
    expect(read?.state).toBe('MERGED');
  });

  it("tells the batch's tasks why, with the link, when the immediate merge fails", async () => {
    h = createDeliveryHarness();
    h.gh.noRequiredChecks = true;
    h.gh.failNext.set(
      'prMerge',
      new GhError('failed', 'gh pr merge failed (exit 1): Pull request has a merge conflict'),
    );
    const shipped = await ship(await start('One', h.addTask('Alpha')));
    expect(shipped.state).toBe('SHIPPED');
    expect(h.gh.merged).toEqual([]);
    expect(h.cards()).toEqual([]);
    const notice = h.only(shipped.notices);
    expect(notice.line).toContain('GitHub refused to merge it');
    expect(notice.body).toContain('merge conflict');
    expect(notice.body).toContain(shipped.prUrl ?? '');
  });

  it('squash-merges at once when GitHub says the branch has no protection rules, with no card', async () => {
    h = createDeliveryHarness();
    h.gh.failNext.set(
      'prAutoMerge',
      new GhError(
        'failed',
        'gh pr merge failed (exit 1): GraphQL: Pull request Protected branch rules not configured for this branch (enablePullRequestAutoMerge)',
      ),
    );
    const shipped = await ship(await start('One', h.addTask('Alpha')));
    expect(shipped.state).toBe('SHIPPED');
    expect(h.gh.merged).toEqual([shipped.prUrl]);
    expect(h.cards()).toEqual([]);
    expect(shipped.notices).toEqual([]);
  });
});

describe('when only the pre-check ran and GitHub says the pull request has nothing to wait for', () => {
  const PR = (n: number) => `https://github.com/acme/widgets/pull/${String(n)}`;
  const notMergedCard = () =>
    h.cards().filter((c) => c.title.startsWith('not merged: main has no required checks'));

  it("does not merge a pull request whose base has no required checks, and tells the batch's tasks with a notice linking it, not a card; merges at once when the required checks already passed on this head", async () => {
    h = createDeliveryHarness({ precheckCommand: 'true' });
    h.gh.noRequiredChecks = true;
    const shipped = await ship(await start('One', h.addTask('Alpha')));
    expect(shipped.state).toBe('SHIPPED');
    expect(shipped.prUrl).toBe(PR(1));
    expect(h.gh.merged).toEqual([]);
    expect(h.cards()).toEqual([]);
    const notice = h.only(shipped.notices);
    expect(notice.key).toBe('pull-request-merge');
    expect(notice.tone).toBe('warning');
    expect(notice.line).toBe(
      'Pull request waits for you to merge it: main has no required checks and only the pre-check ran',
    );
    expect(notice.body).toContain(shipped.prUrl ?? 'no pull request');

    h.gh.setRequiredChecks(PR(2), { state: 'passing', failing: [], pending: [], cancelled: [] });
    const passed = await ship(await start('Two', h.addTask('Beta')));
    expect(passed.prUrl).toBe(PR(2));
    expect(h.gh.merged).toEqual([passed.prUrl]);
    expect(h.cards()).toEqual([]);
  });

  it('neither merges nor raises a card when the required checks are pending, cancelled or failing, or gh cannot read them', async () => {
    h = createDeliveryHarness({ precheckCommand: 'true' });
    h.gh.noRequiredChecks = true;
    const rows = [
      { name: 'pending', task: 'Alpha', state: 'pending' },
      { name: 'cancelled', task: 'Beta', state: 'cancelled' },
      { name: 'failing', task: 'Gamma', state: 'failing' },
      { name: 'unreadable', task: 'Delta', state: null },
    ] as const;
    for (const [i, row] of rows.entries()) {
      if (row.state) {
        h.gh.setRequiredChecks(PR(i + 1), {
          state: row.state,
          failing: [],
          pending: [],
          cancelled: [],
        });
      } else {
        h.gh.failNext.set(
          'prRequiredChecks',
          new GhError('failed', 'gh pr checks failed (exit 1)'),
        );
      }
      const shipped = await ship(await start(row.name, h.addTask(row.task)));
      expect.soft(shipped.prUrl, row.name).toBe(PR(i + 1));
      expect.soft(shipped.state, row.name).toBe('SHIPPED');
      expect.soft(h.gh.merged, row.name).toEqual([]);
      expect.soft(notMergedCard(), row.name).toEqual([]);
      expect.soft(h.cards(), row.name).toEqual([]);
    }
  });
});

describe('tasks that land differently', () => {
  it('are not started as one batch, nor added to a batch that lands another way; one that lands the same way may join', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const merging = h.addTask('Alpha');
    const held = h.addTask('Beta', { landing: { kind: 'hold' } });
    expect(() =>
      h.starter.startBatch(h.project.id, { title: 'Both', taskIds: [merging.id, held.id] }),
    ).toThrow(ConflictError);
    expect(() =>
      h.starter.startBatch(h.project.id, { title: 'Both', taskIds: [merging.id, held.id] }),
    ).toThrow(/Alpha.*Beta|Beta.*Alpha/);
    expect(listBatches(h.store.db, { projectId: h.project.id })).toEqual([]);

    const batch = await start('Greetings', merging);
    expect(() =>
      h.starter.startBatch(h.project.id, { title: 'Fix', taskIds: [held.id], batchId: batch.id }),
    ).toThrow(/Greetings.*merges into main/);

    const fix = h.addTask('Fix', { landing: { kind: 'branch', branch: 'main' } });
    h.starter.startBatch(h.project.id, { title: 'Fix', taskIds: [fix.id], batchId: batch.id });
    await h.jobs.idle();
    expect(listWorkstreams(h.store.db, { batchId: batch.id })).toHaveLength(2);
  });
});

describe('in worktree mode', () => {
  it('refuses tasks that share a worktree but land differently, gives each landing its own batch and pull request, cuts a branch-landing worktree from that branch and refuses one origin lacks', async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    const feature = h.teammatePush('feature/x', 'src/api/feature.txt');

    const base = h.addTask('Delta');
    const dependent = h.addTask('Epsilon', { dependsOn: [base.id], landing: { kind: 'hold' } });
    expect(() =>
      h.starter.startBatch(h.project.id, { title: 'Both', taskIds: [base.id, dependent.id] }),
    ).toThrow(/Delta.*Epsilon.*share|share.*Delta.*Epsilon/s);
    expect(listBatches(h.store.db, { projectId: h.project.id })).toEqual([]);

    const tasks = [
      h.addTask('Alpha'),
      h.addTask('Beta', { landing: { kind: 'hold' } }),
      h.addTask('Gamma', { landing: { kind: 'branch', branch: 'feature/x' } }),
    ];
    const batches = h.starter.startBatch(h.project.id, {
      title: 'All',
      taskIds: tasks.map((t) => t.id),
    });
    await h.jobs.idle();
    expect(
      batches.map((b) => {
        const now = getBatch(h.store.db, b.id);
        return [now.title, now.baseBranch, now.autoMerge, now.state];
      }),
    ).toEqual([
      ['Alpha', 'main', true, 'OPEN'],
      ['Beta', 'main', false, 'OPEN'],
      ['Gamma', 'feature/x', true, 'OPEN'],
    ]);
    const gamma = batches[2];
    if (!gamma) throw new Error('three batches expected');
    expect(getBatch(h.store.db, gamma.id).baseSha).toBe(feature);

    const missing = h.addTask('Zeta', { landing: { kind: 'branch', branch: 'feature/nope' } });
    const refused = h.only(
      h.starter.startBatch(h.project.id, { title: 'Z', taskIds: [missing.id] }),
    );
    await h.jobs.idle();
    expect(
      listBatches(h.store.db, { projectId: h.project.id })
        .map((b) => b.id)
        .sort(),
    ).toEqual(batches.map((b) => b.id).sort());
    expect(batches.map((b) => b.id)).not.toContain(refused.id);
    expect(h.only(h.cards()).title).toBe('Not started: origin has no branch named feature/nope');
  });
});
