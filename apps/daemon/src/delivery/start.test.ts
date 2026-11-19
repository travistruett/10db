import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BranchName,
  ConflictError,
  InvalidError,
  mintId,
  type BatchDto,
  type BatchId,
  type TaskDto,
} from '@10db/contracts';
import {
  clearWorktreePath,
  getAppSetting,
  getBatch,
  insertBatch,
  insertWorkstream,
  listBatches,
  listBoardColumns,
  listWorkstreams,
  moveTask,
  patchProject,
  seedProject,
  transitionBatch,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { GITHUB_ORIGIN } from '../../test/fixtures';
import { GitTrustFailure } from '../git';
import { batchBranchName, createBatchStarter } from './index';

let h: DeliveryHarness;
/** A harness whose ship trigger is off: these tests move batches by hand, and it would race them. */
const boot = () => createDeliveryHarness({}, { trigger: false });
beforeEach(() => {
  h = boot();
});
afterEach(() => {
  h.close();
});

/** Closes this test's harness and boots a fresh one, for a row that needs its own repository. */
function fresh(): void {
  h.close();
  h = boot();
}

/** Starts the tasks as one batch and waits for the background cut. */
async function started(title: string, ...tasks: TaskDto[]) {
  const batch = h.only(
    h.starter.startBatch(h.project.id, { title, taskIds: tasks.map((t) => t.id) }),
  );
  await h.jobs.idle();
  return getBatch(h.store.db, batch.id);
}

/** The ids of the tasks the batch's workstreams run. */
const tasksIn = (batch: BatchDto) =>
  listWorkstreams(h.store.db, { batchId: batch.id }).map((w) => w.taskId);

const NAMES = [
  { title: 'Add greetings', slug: 'add-greetings' },
  { title: 'Ünïcode & spaces!', slug: 'unicode-spaces' },
  { title: '  --Leading dashes', slug: 'leading-dashes' },
  { title: '$(rm -rf /)', slug: 'rm-rf' },
  { title: '***', slug: 'batch' },
  // A cut lands on the last whole word that fits the cap, never inside a word.
  {
    title: 'Reword spec claim release to match decisions',
    slug: 'reword-spec-claim-release-to-match',
  },
  { title: `${'a'.repeat(30)} ${'b'.repeat(30)}`, slug: 'a'.repeat(30) },
  {
    title: `${'a'.repeat(30)} ${'b'.repeat(9)} ${'c'.repeat(5)}`,
    slug: `${'a'.repeat(30)}-${'b'.repeat(9)}`,
  },
  { title: `${'x'.repeat(39)} yz`, slug: 'x'.repeat(39) },
  { title: `${'x'.repeat(40)} yz`, slug: 'x'.repeat(40) },
  // A first word longer than the cap has no boundary to end on, so it is cut to the cap.
  { title: 'x'.repeat(50), slug: 'x'.repeat(40) },
  { title: `${'x'.repeat(45)} yz`, slug: 'x'.repeat(40) },
];

describe('batchBranchName', () => {
  it('names a batch 10db/<slug>-<id>, a valid branch, cut at the last whole word that fits', () => {
    for (const { title, slug } of NAMES) {
      const id = mintId('Batch');
      const name = batchBranchName(title, id);
      expect.soft(name, title).toBe(`10db/${slug}-${id.slice(-8)}`);
      expect.soft(BranchName.safeParse(name).success, title).toBe(true);
    }
  });
});

/** The states of a project in which a cut is refused, and the words the refusal card's title holds. */
const REFUSED_CUTS: { name: string; arrange: (h: DeliveryHarness) => void; title: string }[] = [
  {
    name: 'a lane runs in the project',
    arrange: (x) => {
      const other = x.addTask('Running', { areas: ['ui'] });
      const ws = x.state.write((c) =>
        insertWorkstream(c, other.id, {
          first: { model: 'claude-sonnet-5-5', effort: 'medium' },
        }),
      );
      x.settle(ws.id, 'RUNNING');
    },
    title: 'work is still running',
  },
  {
    name: 'the checkout is dirty',
    arrange: (x) => {
      writeFileSync(join(x.repo, 'scratch.txt'), 'uncommitted\n');
    },
    title: 'the checkout has uncommitted changes',
  },
  {
    name: 'the repository asks for a filter, as Git LFS does',
    arrange: (x) => {
      writeFileSync(join(x.repo, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
      x.git$('add', '.gitattributes');
      x.git$('commit', '-q', '-m', 'lfs');
    },
    title: 'uses git filters',
  },
  {
    name: 'there is no origin',
    arrange: (x) => {
      x.git$('remote', 'remove', 'origin');
    },
    title: 'has no remote named origin',
  },
  {
    name: 'the base branch is not on origin',
    arrange: (x) => {
      x.state.write((c) => patchProject(c, x.project.id, { baseBranch: 'develop' }));
    },
    title: 'git fetch origin develop failed',
  },
  {
    name: 'gh is not installed',
    arrange: (x) => {
      x.gh.auth = 'not_installed';
    },
    title: 'gh is not installed',
  },
  {
    name: 'gh is signed out',
    arrange: (x) => {
      x.gh.auth = 'signed_out';
    },
    title: 'gh is signed out',
  },
  {
    name: 'origin is not on github.com',
    arrange: (x) => {
      x.git$('remote', 'set-url', 'origin', 'https://gitlab.com/acme/widgets.git');
    },
    title: 'is not a github.com repository',
  },
];

describe('cutting a branch', () => {
  it('cuts the branch from the fetched base and opens the batch; a later start, a start with its batchId and a fix task of the failed batch join it, and any other batchId is refused', async () => {
    const alpha = h.addTask('Alpha');
    const beta = h.addTask('Beta', { areas: ['ui'] });
    const gamma = h.addTask('Gamma', { areas: ['ui'] });
    const delta = h.addTask('Delta', { areas: ['ui'] });
    // With no batch open, a batchId names no unfinished batch.
    expect(() =>
      h.starter.startBatch(h.project.id, {
        title: 'Fix',
        taskIds: [delta.id],
        batchId: mintId('Batch'),
      }),
    ).toThrow(ConflictError);
    // A teammate's commit lands on origin/main after this clone last fetched, so only a fetch sees it.
    const upstream = h.teammatePush('main', 'src/api/upstream.txt');

    const request = h.only(
      h.starter.startBatch(h.project.id, {
        title: 'Greetings',
        taskIds: [alpha.id, beta.id],
      }),
    );
    expect(request.state).toBe('CUTTING');
    await h.jobs.idle();

    const batch = getBatch(h.store.db, request.id);
    expect(batch).toMatchObject({
      state: 'OPEN',
      branch: batchBranchName('Greetings', batch.id),
      baseBranch: 'main',
      baseSha: upstream,
      repo: 'acme/widgets',
    });
    expect(h.git$('branch', '--show-current')).toBe(batch.branch);
    expect(h.git$('rev-parse', 'HEAD')).toBe(upstream);
    expect(
      listWorkstreams(h.store.db, { batchId: batch.id }).map((w) => [w.taskId, w.state]),
    ).toEqual([
      [alpha.id, 'QUEUED'],
      [beta.id, 'QUEUED'],
    ]);
    expect(h.ticks.count).toBe(1);
    expect(h.cards()).toEqual([]);

    // A task started while the batch is open joins it.
    expect(h.starter.startTask(gamma.id).id).toBe(batch.id);
    await h.jobs.idle();
    expect(tasksIn(batch)).toContain(gamma.id);
    expect(h.ticks.count).toBe(2);

    // A batchId that is not the unfinished batch is refused; the one that is joins it.
    expect(() =>
      h.starter.startBatch(h.project.id, {
        title: 'Fix',
        taskIds: [delta.id],
        batchId: mintId('Batch'),
      }),
    ).toThrow(ConflictError);
    const open = getBatch(h.store.db, batch.id);
    expect(
      h.starter.startBatch(h.project.id, { title: 'Fix', taskIds: [delta.id], batchId: batch.id }),
    ).toEqual([open]);
    await h.jobs.idle();
    expect(tasksIn(batch)).toContain(delta.id);

    // A failed batch reopens with a fix task.
    h.state.write((c) =>
      transitionBatch(c, batch.id, { to: 'FAILED', patch: { failure: 'gate_failed' } }),
    );
    const fix = h.addTask('Fix the gate', { areas: ['ui'] });
    expect(h.starter.startTask(fix.id).id).toBe(batch.id);
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id)).toMatchObject({ state: 'OPEN', failure: null });
    expect(tasksIn(batch)).toContain(fix.id);
  });

  it('refuses a cut when a lane runs, the checkout is dirty, git filters are on, origin is missing or not on github.com, the base is not on origin, or gh is missing or signed out: a card, no batch row, HEAD unmoved', async () => {
    for (const [i, { name, arrange, title }] of REFUSED_CUTS.entries()) {
      if (i > 0) fresh();
      const task = h.addTask('Alpha');
      arrange(h);
      const head = h.git$('rev-parse', 'HEAD');
      const branch = h.git$('branch', '--show-current');
      h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: [task.id] });
      await h.jobs.idle();
      expect.soft(listBatches(h.store.db), name).toEqual([]);
      expect
        .soft(
          h.cards().map((c) => c.title),
          name,
        )
        .toEqual([expect.stringContaining(title)]);
      expect
        .soft(
          h.cards().map((c) => c.detail),
          name,
        )
        .toMatchObject([{ taskIds: [task.id] }]);
      expect.soft(h.git$('rev-parse', 'HEAD'), name).toBe(head);
      expect.soft(h.git$('branch', '--show-current'), name).toBe(branch);
      // The workstream the start inserted with the row is cancelled with it, so the task can start again.
      expect
        .soft(
          listWorkstreams(h.store.db, {}).filter((w) => w.taskId === task.id),
          name,
        )
        .toMatchObject([{ state: 'CANCELLED', batchId: null }]);
    }
  });

  it('raises the origin card when origin is added after the checkout was pinned, and starts once it is trusted', async () => {
    h.git$('remote', 'remove', 'origin');
    // The first daemon git call pins the checkout, with no origin.
    await h.git.head(h.repo);
    h.git$('remote', 'add', 'origin', GITHUB_ORIGIN);
    const task = h.addTask('Alpha');
    h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: [task.id] });
    await h.jobs.idle();
    expect(listBatches(h.store.db)).toEqual([]);
    const refusal = h.only(h.gitRefusals);
    if (refusal.detail.kind !== GitTrustFailure.Origin)
      throw new Error(`expected an origin refusal, got ${refusal.detail.kind}`);
    expect(refusal.detail).toMatchObject({ direction: 'push', pinned: null, found: GITHUB_ORIGIN });
    await h.git.retrust(h.repo, refusal.detail.candidate);
    h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: [task.id] });
    await h.jobs.idle();
    expect(listBatches(h.store.db)).toHaveLength(1);
  });

  it('gives two simultaneous starts one batch and one branch', async () => {
    const alpha = h.addTask('Alpha');
    const beta = h.addTask('Beta', { areas: ['ui'] });
    const results = await Promise.allSettled(
      [alpha, beta].map(async (t) => {
        await Promise.resolve();
        return h.starter.startTask(t.id);
      }),
    );
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = results.find((r) => r.status === 'rejected');
    expect(refused?.status === 'rejected' ? refused.reason : null).toBeInstanceOf(ConflictError);
    await h.jobs.idle();
    expect(listBatches(h.store.db)).toHaveLength(1);
    expect(h.git$('branch', '--list', '10db/*').split('\n').filter(Boolean)).toHaveLength(1);
  });
});

describe("a start's record of its batches", () => {
  /**
   * A starter whose state notes, after every write, each watched batch that has left CUTTING (opened
   * or deleted) while its start_siblings record is still set. A crash right after that write would
   * leave the record for good.
   */
  function starterWatchingSiblings() {
    const leaked: BatchId[] = [];
    const watched: BatchId[] = [];
    const state: typeof h.state = {
      db: h.state.db,
      now: () => h.state.now(),
      write: (fn) => {
        const value = h.state.write(fn);
        for (const id of watched) {
          const row = listBatches(h.store.db).find((b) => b.id === id);
          if (row?.state !== 'CUTTING' && getAppSetting(h.store.db, `start_siblings.${id}`))
            leaked.push(id);
        }
        return value;
      },
    };
    return {
      starter: createBatchStarter({ ...h.ctx, state }),
      watch: (batches: readonly BatchDto[]) => watched.push(...batches.map((b) => b.id)),
      leaked,
    };
  }

  /** The start's batches: the shared one, and a copy of the task that runs apart. */
  function startWithCopy(
    starter: ReturnType<typeof createBatchStarter>,
    shared: TaskDto,
  ): { sharedBatch: BatchDto; all: BatchDto[] } {
    const copy = h.addTask('Beta', { areas: ['ui'], workspaceMode: 'worktree' });
    const all = starter.startBatch(h.project.id, {
      title: 'Together',
      taskIds: [shared.id, copy.id],
    });
    expect(all).toHaveLength(2);
    // Both are written CUTTING, with the record that names the other.
    for (const { id } of all)
      expect(getAppSetting(h.store.db, `start_siblings.${id}`)).toHaveLength(2);
    const sharedBatch = all.find((b) => b.worktreePath === null);
    if (!sharedBatch) throw new Error('the start made no shared batch');
    return { sharedBatch, all };
  }

  it("drops the record in the write that opens the shared cut's batch, or that deletes it when the cut is refused", async () => {
    const opening = starterWatchingSiblings();
    const opened = startWithCopy(opening.starter, h.addTask('Alpha'));
    opening.watch(opened.all);
    await h.jobs.idle();
    expect(getBatch(h.store.db, opened.sharedBatch.id).state).toBe('OPEN');
    expect(opening.leaked).toEqual([]);

    fresh();
    const refusing = starterWatchingSiblings();
    // The landing branch is nowhere on origin, so the shared cut is refused.
    const landing = { landing: { kind: 'branch', branch: 'feature/missing' } } as const;
    const refused = startWithCopy(refusing.starter, h.addTask('Alpha', landing));
    refusing.watch(refused.all);
    await h.jobs.idle();
    expect(listBatches(h.store.db).map((b) => b.id)).not.toContain(refused.sharedBatch.id);
    expect(refusing.leaked).toEqual([]);
  });
});

describe('joining a batch', () => {
  it('adds nothing to a batch the checkout left, with a card, and says so, naming the tasks, when 10db stops before a join finishes', async () => {
    const batch = await started('Greetings', h.addTask('Alpha'));
    h.git$('switch', '-q', 'main');
    const beta = h.addTask('Beta', { areas: ['ui'] });
    h.starter.startTask(beta.id);
    await h.jobs.idle();
    expect(tasksIn(batch)).not.toContain(beta.id);
    const card = h.only(h.cards());
    expect(card.title).toContain(`checkout is on main, the batch branch is ${batch.branch ?? ''}`);
    expect(card.body).toContain(
      `Start the task again once the checkout is on ${batch.branch ?? ''}`,
    );
    expect(card.detail).toMatchObject({ batchId: batch.id, taskIds: [beta.id] });
    expect(getBatch(h.store.db, batch.id).state).toBe('OPEN');

    // Back on the batch branch, a join that 10db stops before it finishes adds nothing either.
    h.git$('switch', '-q', batch.branch ?? '');
    const gamma = h.addTask('Gamma', { areas: ['ui'] });
    h.starter.startTask(gamma.id);
    await h.jobs.stop();
    expect(tasksIn(batch)).not.toContain(gamma.id);
    const stopped = h.only(h.cards().filter((c) => c.title.includes('10db stopped first')));
    expect(stopped.title).toBe('Not added to batch "Greetings": 10db stopped first');
    expect(stopped.detail).toMatchObject({ batchId: batch.id, taskIds: [gamma.id] });
  });

  it('refuses a batchId of a finished batch, saying it has finished: a shipped shared batch, a shipped copy whose worktree went, and a SHIPPED or CLOSED copy whose worktree was kept', async () => {
    const finished = [
      { name: 'a shipped shared batch', mode: 'shared', end: 'SHIPPED', kept: false },
      { name: 'a shipped copy', mode: 'worktree', end: 'SHIPPED', kept: false },
      {
        name: 'a SHIPPED copy whose worktree was kept',
        mode: 'worktree',
        end: 'SHIPPED',
        kept: true,
      },
      {
        name: 'a CLOSED copy whose worktree was kept',
        mode: 'worktree',
        end: 'CLOSED',
        kept: true,
      },
    ] as const;
    for (const { name, mode, end, kept } of finished) {
      const alpha = h.addTask(`Alpha ${name}`, { areas: ['api'], workspaceMode: mode });
      const first = await started('Greetings', alpha);
      h.settle(h.only(listWorkstreams(h.store.db, { batchId: first.id })).id, 'DONE');
      const url = h.gh.openPr(first.branch ?? '');
      h.state.write((c) => {
        transitionBatch(c, first.id, { to: 'SHIPPING' });
        transitionBatch(c, first.id, { to: end, patch: { prUrl: url } });
        // A finished copy's worktree is removed and its path forgotten; retiring keeps a worktree
        // that holds unseeded ignored files, so its path stays set.
        if (mode === 'worktree' && !kept) clearWorktreePath(c, first.id);
      });
      if (kept) expect.soft(getBatch(h.store.db, first.id).worktreePath, name).not.toBeNull();
      const beta = h.addTask(`Beta ${name}`, { areas: ['ui'], workspaceMode: mode });
      expect
        .soft(
          () =>
            h.starter.startBatch(h.project.id, {
              title: 'Fix',
              taskIds: [beta.id],
              batchId: first.id,
            }),
          name,
        )
        .toThrow(`Batch "${first.title}" has finished`);
    }
  });

  it('refuses a start while the batch is CUTTING or SHIPPING', async () => {
    const alpha = h.addTask('Alpha');
    const batch = h.starter.startTask(alpha.id);
    const beta = h.addTask('Beta', { areas: ['ui'] });
    expect(() => h.starter.startTask(beta.id)).toThrow(ConflictError);
    expect(() => h.starter.startTask(beta.id)).toThrow('cutting');
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id).state).toBe('OPEN');
    h.state.write((c) => transitionBatch(c, batch.id, { to: 'SHIPPING' }));
    expect(() => h.starter.startTask(beta.id)).toThrow(ConflictError);
    expect(() => h.starter.startTask(beta.id)).toThrow('shipping');
    await h.jobs.idle();
  });
});

describe('dependencies', () => {
  it("refuses a task whose dependency is unfinished outside the set, in a batch whose pull request isn't merged, or in an abandoned batch, with a card, and starts it once that is no longer so", async () => {
    // Unfinished outside the set: refused, and started with its dependency.
    const alpha = h.addTask('Alpha');
    const beta = h.addTask('Beta', { areas: ['ui'], dependsOn: [alpha.id] });
    expect(() => h.starter.startTask(beta.id)).toThrow(ConflictError);
    expect(h.only(h.cards()).body).toContain('Beta needs Alpha');
    expect(listBatches(h.store.db)).toEqual([]);
    const first = await started('Both', alpha, beta);
    expect(first.state).toBe('OPEN');

    // Finished in a batch whose pull request is open: refused until it merges.
    for (const ws of listWorkstreams(h.store.db, { batchId: first.id })) h.settle(ws.id, 'DONE');
    const url = h.gh.openPr(first.branch ?? '');
    h.state.write((c) => {
      transitionBatch(c, first.id, { to: 'SHIPPING' });
      transitionBatch(c, first.id, { to: 'SHIPPED', patch: { prUrl: url } });
    });
    const gamma = h.addTask('Gamma', { areas: ['ui'], dependsOn: [alpha.id] });
    h.starter.startTask(gamma.id);
    await h.jobs.idle();
    expect(listBatches(h.store.db).map((b) => b.id)).toEqual([first.id]);
    expect(h.cards().map((c) => c.body)).toContainEqual(
      expect.stringContaining(`its pull request ${url} is open, not merged`),
    );
    h.gh.setState(url, 'MERGED');
    const second = h.starter.startTask(gamma.id);
    await h.jobs.idle();
    expect(getBatch(h.store.db, second.id).state).toBe('OPEN');

    // Finished in an abandoned batch: refused.
    h.settle(h.only(listWorkstreams(h.store.db, { batchId: second.id })).id, 'DONE');
    h.state.write((c) => transitionBatch(c, second.id, { to: 'ABANDONED' }));
    const delta = h.addTask('Delta', { areas: ['api'], dependsOn: [gamma.id] });
    h.starter.startTask(delta.id);
    await h.jobs.idle();
    expect(h.cards().map((c) => c.body)).toContainEqual(expect.stringContaining('was abandoned'));
  });
});

describe('refusals in the request', () => {
  it("refuses a local project, a parked task before it cuts a branch, a task already running, a batchId of another project's batch and a task of another project", async () => {
    const local = seedProject(h.store, { repoPath: `${h.repo}-local` });
    expect(() =>
      h.starter.startBatch(local.id, { title: 'x', taskIds: [h.addTask('Local').id] }),
    ).toThrow(InvalidError);

    const parked = h.addTask('Parked');
    const icebox = listBoardColumns(h.store.db, h.project.id)[0];
    if (!icebox) throw new Error('no Icebox');
    h.state.write((ctx) => moveTask(ctx, parked.id, { to: icebox.id, after: null, before: null }));
    expect(() => h.starter.startTask(parked.id)).toThrow(ConflictError);
    expect(() => h.starter.startTask(parked.id)).toThrow(/parked in Icebox/);
    await h.jobs.idle();
    expect(listBatches(h.store.db)).toEqual([]);
    expect(h.git$('branch', '--list', '10db/*')).toBe('');

    const alpha = h.addTask('Alpha');
    await started('Greetings', alpha);
    expect(() => h.starter.startTask(alpha.id)).toThrow(/already running/);

    const elsewhere = seedProject(h.store, {
      repoPath: `${h.repo}-other`,
      delivery: 'pull_request',
      prTitlePrefix: 'fix',
    });
    const foreign = h.state.write((w) =>
      insertBatch(w, { projectId: elsewhere.id, title: 'Theirs', baseBranch: 'main' }),
    );
    const beta = h.addTask('Beta', { areas: ['ui'] });
    expect(() =>
      h.starter.startBatch(h.project.id, { title: 'Fix', taskIds: [beta.id], batchId: foreign.id }),
    ).toThrow(`Batch "Theirs" is not a batch of ${h.project.name}`);
    expect(() =>
      h.starter.startBatch(elsewhere.id, { title: 'x', taskIds: [h.addTask('Gamma').id] }),
    ).toThrow(/belongs to another project/);
  });
});
