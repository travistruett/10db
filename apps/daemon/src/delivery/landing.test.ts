import { BatchDto, ConflictError, NOTICE_BODY_MAX, type TaskDto } from '@10db/contracts';
import { getBatch, listBatches, listWorkstreams } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { GhError } from '../github';
import { autoMergeOffKey, autoMergeRefusedKey } from './cards';
import { raise } from './context';

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
  it.each([
    {
      name: 'a task set to hold',
      project: {},
      landing: { kind: 'hold' } as const,
    },
    {
      name: 'a task that starts from a project that holds',
      project: { landing: 'hold' } as const,
      landing: undefined,
    },
  ])('never merges by itself: $name', async ({ project, landing }) => {
    h = createDeliveryHarness(project);
    const batch = await start('Greetings', h.addTask('Alpha', landing ? { landing } : {}));
    expect(batch).toMatchObject({ baseBranch: 'main', autoMerge: false });
    const shipped = await ship(batch);
    expect(shipped.state).toBe('SHIPPED');
    expect(h.gh.prCreates()).toMatchObject([{ base: 'main' }]);
    expect(autoMergeCalls()).toEqual([]);
    expect(h.gh.calls.some((c) => c.method === 'repoAllowsAutoMerge')).toBe(false);
    expect(h.cards()).toEqual([]);
  });

  it('lets a task merge although its project holds', async () => {
    h = createDeliveryHarness({ landing: 'hold' });
    const batch = await start('Greetings', h.addTask('Alpha', { landing: { kind: 'base' } }));
    const shipped = await ship(batch);
    expect(h.gh.autoMerged).toEqual([shipped.prUrl]);
  });
});

describe('a pull request that lands in another branch', () => {
  it('is built from that branch, targets it and merges by itself', async () => {
    h = createDeliveryHarness();
    const feature = h.teammatePush('feature/x', 'src/api/feature.txt');
    const task = h.addTask('Alpha', { landing: { kind: 'branch', branch: 'feature/x' } });
    const batch = await start('Greetings', task);
    expect(batch).toMatchObject({ baseBranch: 'feature/x', autoMerge: true, baseSha: feature });
    expect(h.git$('rev-parse', 'HEAD')).toBe(feature);
    const shipped = await ship(batch);
    expect(shipped.state).toBe('SHIPPED');
    expect(h.gh.prCreates()).toMatchObject([{ base: 'feature/x', head: batch.branch }]);
    expect(h.gh.autoMerged).toEqual([shipped.prUrl]);
  });

  it('refuses a branch origin does not have, in plain words, before anything starts', async () => {
    h = createDeliveryHarness();
    const before = h.git$('rev-parse', 'HEAD');
    const task = h.addTask('Alpha', { landing: { kind: 'branch', branch: 'feature/nope' } });
    h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: [task.id] });
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
      { taskId: task.id, state: 'CANCELLED', batchId: null },
    ]);
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

  it('says nothing about it for a pull request held anyway', async () => {
    h = createDeliveryHarness({ landing: 'hold' });
    h.gh.autoMergeAllowed = false;
    await ship(await start('One', h.addTask('Alpha')));
    expect(h.cards()).toEqual([]);
  });
});

describe('when GitHub refuses to turn auto-merge on', () => {
  it("still ships, and tells the batch's tasks the pull request waits for the builder", async () => {
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
    expect(h.gh.calls.some((c) => c.method === 'prMerge')).toBe(false);
  });

  it('closes the auto-merge cards an earlier build raised once a pull request is set to merge by itself', async () => {
    h = createDeliveryHarness();
    const batch = await start('One', h.addTask('Alpha'));
    raise(h.inbox, h.project.id, {
      title: "This repository doesn't allow auto-merge",
      body: 'x',
      foldKey: autoMergeOffKey(h.project.id),
    });
    raise(h.inbox, h.project.id, {
      title: 'Pull request opened but not set to merge by itself',
      body: 'x',
      foldKey: autoMergeRefusedKey(batch.id),
    });
    expect(h.cards()).toHaveLength(2);
    await ship(batch);
    expect(h.gh.autoMerged).toHaveLength(1);
    expect(h.cards()).toEqual([]);
  });

  it('closes the refusal card an earlier build raised when the refusal shows as a notice', async () => {
    h = createDeliveryHarness();
    const batch = await start('One', h.addTask('Alpha'));
    raise(h.inbox, h.project.id, {
      title: 'Pull request opened but not set to merge by itself',
      body: 'x',
      foldKey: autoMergeRefusedKey(batch.id),
    });
    h.gh.failNext.set('prAutoMerge', new GhError('failed', 'gh pr merge failed (exit 1): draft'));
    const shipped = await ship(batch);
    expect(shipped.notices).toHaveLength(1);
    expect(h.cards()).toEqual([]);
  });

  it('keeps the link and a board that loads when gh says far more than a notice holds', async () => {
    h = createDeliveryHarness();
    const graphql = `GraphQL: ${'Base branch was modified. Review and try the merge again. '.repeat(400)}`;
    h.gh.failNext.set(
      'prAutoMerge',
      new GhError('failed', `gh pr merge failed (exit 1): ${graphql}`),
    );
    const shipped = await ship(await start('One', h.addTask('Alpha')));
    expect(() => BatchDto.parse(shipped)).not.toThrow();
    const notice = h.only(shipped.notices);
    expect(notice.body.length).toBeLessThanOrEqual(NOTICE_BODY_MAX);
    expect(notice.body).toContain('Base branch was modified');
    expect(notice.body).toContain('…');
    expect(notice.body).toContain(shipped.prUrl ?? 'no pull request');
  });
});

describe('when the base branch has no required checks', () => {
  it('squash-merges the pull request right after it opens, with no card', async () => {
    h = createDeliveryHarness();
    h.gh.noRequiredChecks = true;
    const shipped = await ship(await start('One', h.addTask('Alpha')));
    expect(shipped.state).toBe('SHIPPED');
    expect(h.gh.merged).toEqual([shipped.prUrl]);
    expect(h.cards()).toEqual([]);
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

  it('never merges a pull request held for the builder', async () => {
    h = createDeliveryHarness({ landing: 'hold' });
    h.gh.noRequiredChecks = true;
    await ship(await start('One', h.addTask('Alpha')));
    expect(h.gh.calls.some((c) => c.method === 'prMerge')).toBe(false);
  });
});

describe('when only the pre-check ran and GitHub says the pull request has nothing to wait for', () => {
  const notMergedCard = () =>
    h.cards().filter((c) => c.title.startsWith('not merged: main has no required checks'));

  it('does not merge a pull request whose base has no required checks, and raises a card linking it', async () => {
    h = createDeliveryHarness({ precheckCommand: 'true' });
    h.gh.noRequiredChecks = true;
    const shipped = await ship(await start('One', h.addTask('Alpha')));
    expect(shipped.state).toBe('SHIPPED');
    expect(h.gh.merged).toEqual([]);
    const card = h.only(h.cards());
    expect(card.title).toBe('not merged: main has no required checks and only the pre-check ran');
    expect(card.body).toContain(shipped.prUrl ?? 'no pull request');
  });

  it('merges at once when the required checks already passed on this head', async () => {
    h = createDeliveryHarness({ precheckCommand: 'true' });
    h.gh.noRequiredChecks = true;
    h.gh.setRequiredChecks('https://github.com/acme/widgets/pull/1', {
      state: 'passing',
      failing: [],
      pending: [],
    });
    const shipped = await ship(await start('One', h.addTask('Alpha')));
    expect(shipped.prUrl).toBe('https://github.com/acme/widgets/pull/1');
    expect(h.gh.merged).toEqual([shipped.prUrl]);
    expect(h.cards()).toEqual([]);
  });

  it.each(['pending', 'failing'] as const)(
    'neither merges nor raises a card when the required checks are %s',
    async (state) => {
      h = createDeliveryHarness({ precheckCommand: 'true' });
      h.gh.noRequiredChecks = true;
      h.gh.setRequiredChecks('https://github.com/acme/widgets/pull/1', {
        state,
        failing: [],
        pending: [],
      });
      const shipped = await ship(await start('One', h.addTask('Alpha')));
      expect(shipped.state).toBe('SHIPPED');
      expect(h.gh.merged).toEqual([]);
      expect(notMergedCard()).toEqual([]);
      expect(h.cards()).toEqual([]);
    },
  );

  it('neither merges nor raises a card when gh cannot read the required checks', async () => {
    h = createDeliveryHarness({ precheckCommand: 'true' });
    h.gh.noRequiredChecks = true;
    h.gh.failNext.set('prRequiredChecks', new GhError('failed', 'gh pr checks failed (exit 1)'));
    const shipped = await ship(await start('One', h.addTask('Alpha')));
    expect(shipped.state).toBe('SHIPPED');
    expect(h.gh.merged).toEqual([]);
    expect(h.cards()).toEqual([]);
  });

  it('never reads the required checks when the gate ran, and merges as before', async () => {
    h = createDeliveryHarness();
    h.gh.noRequiredChecks = true;
    const shipped = await ship(await start('One', h.addTask('Alpha')));
    expect(h.gh.merged).toEqual([shipped.prUrl]);
    expect(h.gh.calls.some((c) => c.method === 'prRequiredChecks')).toBe(false);
  });
});

describe('tasks that land differently', () => {
  it('are not started as one batch', () => {
    h = createDeliveryHarness();
    const merging = h.addTask('Alpha');
    const held = h.addTask('Beta', { landing: { kind: 'hold' } });
    expect(() =>
      h.starter.startBatch(h.project.id, { title: 'Both', taskIds: [merging.id, held.id] }),
    ).toThrow(ConflictError);
    expect(() =>
      h.starter.startBatch(h.project.id, { title: 'Both', taskIds: [merging.id, held.id] }),
    ).toThrow(/Alpha.*Beta|Beta.*Alpha/);
    expect(listBatches(h.store.db, { projectId: h.project.id })).toEqual([]);
  });

  it('are not added to a batch that lands another way', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const batch = await start('Greetings', h.addTask('Alpha'));
    const held = h.addTask('Fix', { landing: { kind: 'hold' } });
    expect(() =>
      h.starter.startBatch(h.project.id, { title: 'Fix', taskIds: [held.id], batchId: batch.id }),
    ).toThrow(/Greetings.*merges into main/);
  });

  it('may join a batch that lands the same way', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const batch = await start('Greetings', h.addTask('Alpha'));
    const fix = h.addTask('Fix', { landing: { kind: 'branch', branch: 'main' } });
    h.starter.startBatch(h.project.id, { title: 'Fix', taskIds: [fix.id], batchId: batch.id });
    await h.jobs.idle();
    expect(listWorkstreams(h.store.db, { batchId: batch.id })).toHaveLength(2);
  });
});

describe('in worktree mode', () => {
  it('gives each landing its own batch and pull request', async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    h.teammatePush('feature/x', 'src/api/feature.txt');
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
  });

  it('refuses tasks that share a worktree but land differently', () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    const base = h.addTask('Alpha');
    const dependent = h.addTask('Beta', { dependsOn: [base.id], landing: { kind: 'hold' } });
    expect(() =>
      h.starter.startBatch(h.project.id, { title: 'Both', taskIds: [base.id, dependent.id] }),
    ).toThrow(/Alpha.*Beta.*share|share.*Alpha.*Beta/s);
    expect(listBatches(h.store.db, { projectId: h.project.id })).toEqual([]);
  });

  it('cuts a branch-landing worktree from that branch and refuses one origin lacks', async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    const feature = h.teammatePush('feature/x', 'src/api/feature.txt');
    const there = h.addTask('Alpha', { landing: { kind: 'branch', branch: 'feature/x' } });
    const batch = h.only(h.starter.startBatch(h.project.id, { title: 'A', taskIds: [there.id] }));
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id)).toMatchObject({ baseSha: feature, state: 'OPEN' });

    const missing = h.addTask('Beta', { landing: { kind: 'branch', branch: 'feature/nope' } });
    const refused = h.only(
      h.starter.startBatch(h.project.id, { title: 'B', taskIds: [missing.id] }),
    );
    await h.jobs.idle();
    expect(listBatches(h.store.db, { projectId: h.project.id }).map((b) => b.id)).toEqual([
      batch.id,
    ]);
    expect(refused.id).not.toBe(batch.id);
    expect(h.only(h.cards()).title).toBe('Not started: origin has no branch named feature/nope');
  });
});
