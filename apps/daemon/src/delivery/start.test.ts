import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BranchName, ConflictError, InvalidError, mintId, type TaskDto } from '@10db/contracts';
import {
  getBatch,
  insertWorkstream,
  listBatches,
  listInbox,
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
import { batchBranchName } from './index';

let h: DeliveryHarness;
beforeEach(() => {
  // These tests move batches by hand; the ship trigger would race them.
  h = createDeliveryHarness({}, { trigger: false });
});
afterEach(() => {
  h.close();
});

/** Starts the tasks as one batch and waits for the background cut. */
async function started(title: string, ...tasks: TaskDto[]) {
  const batch = h.only(
    h.starter.startBatch(h.project.id, { title, taskIds: tasks.map((t) => t.id) }),
  );
  await h.jobs.idle();
  return getBatch(h.store.db, batch.id);
}

describe('batchBranchName', () => {
  it.each([
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
  ])('names "$title" 10db/$slug-<id>', ({ title, slug }) => {
    const id = mintId('Batch');
    const name = batchBranchName(title, id);
    expect(name).toBe(`10db/${slug}-${id.slice(-8)}`);
    expect(BranchName.safeParse(name).success).toBe(true);
  });
});

describe('cutting a branch', () => {
  it('cuts the branch from the fetched base, opens the batch and queues its workstreams', async () => {
    const alpha = h.addTask('Alpha');
    const beta = h.addTask('Beta', { areas: ['ui'] });
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
  });

  it.each<{ name: string; arrange: (h: DeliveryHarness) => void; title: string }>([
    {
      name: 'a lane runs in the project',
      arrange: (x) => {
        const other = x.addTask('Running', { areas: ['ui'] });
        const ws = x.state.write((c) => insertWorkstream(c, other.id));
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
        writeFileSync(
          join(x.repo, '.gitattributes'),
          '*.bin filter=lfs diff=lfs merge=lfs -text\n',
        );
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
  ])('refuses when $name: a card, no batch row, HEAD unmoved', async ({ arrange, title }) => {
    const task = h.addTask('Alpha');
    arrange(h);
    const head = h.git$('rev-parse', 'HEAD');
    const branch = h.git$('branch', '--show-current');
    h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: [task.id] });
    await h.jobs.idle();
    expect(listBatches(h.store.db)).toEqual([]);
    expect(h.cards().map((c) => c.title)).toEqual([expect.stringContaining(title)]);
    expect(h.only(h.cards()).detail).toMatchObject({ taskIds: [task.id] });
    expect(h.git$('rev-parse', 'HEAD')).toBe(head);
    expect(h.git$('branch', '--show-current')).toBe(branch);
    expect(listWorkstreams(h.store.db, {}).filter((w) => w.taskId === task.id)).toEqual([]);
  });

  it('names the files in the way, in plain words, when the checkout has uncommitted changes', async () => {
    const task = h.addTask('Alpha');
    writeFileSync(join(h.repo, 'scratch.txt'), 'uncommitted\n');
    h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: [task.id] });
    await h.jobs.idle();
    const card = h.only(h.cards());
    expect(card.body).toContain('switches your checkout to a new branch to start');
    expect(card.body).toContain('These files have changes that are in the way:\n- scratch.txt');
    expect(card.body).toContain(h.repo);
  });

  it('keeps one card when the same start is refused again, and a new one once it is dismissed', async () => {
    const task = h.addTask('Alpha');
    writeFileSync(join(h.repo, 'a.txt'), 'uncommitted\n');
    writeFileSync(join(h.repo, 'b.txt'), 'uncommitted\n');
    const refuse = async () => {
      h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: [task.id] });
      await h.jobs.idle();
    };
    await refuse();
    const first = h.only(h.cards());
    expect(first.body).toContain('- a.txt\n- b.txt');
    h.git$('add', 'a.txt');
    h.git$('commit', '-m', 'a');
    await refuse();
    const again = h.only(h.cards());
    expect(again.id).toBe(first.id);
    expect(again.body).toContain('- b.txt');
    expect(again.body).not.toContain('a.txt');
    h.inbox.answer(first.id, { choice: 'dismiss' });
    await refuse();
    expect(h.only(h.cards()).id).not.toBe(first.id);
  });

  it('keeps starts of other tasks apart', async () => {
    const alpha = h.addTask('Alpha');
    const beta = h.addTask('Beta');
    writeFileSync(join(h.repo, 'scratch.txt'), 'uncommitted\n');
    for (const task of [alpha, beta]) {
      h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: [task.id] });
      await h.jobs.idle();
    }
    expect(h.cards()).toHaveLength(2);
  });

  it('closes the refusal card by itself, saying why, once the same task starts', async () => {
    const task = h.addTask('Alpha');
    writeFileSync(join(h.repo, 'scratch.txt'), 'uncommitted\n');
    h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: [task.id] });
    await h.jobs.idle();
    const card = h.only(h.cards());
    unlinkSync(join(h.repo, 'scratch.txt'));
    h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: [task.id] });
    await h.jobs.idle();
    expect(h.cards()).toEqual([]);
    const [closed] = listInbox(h.store.db, { states: ['RESOLVED'] });
    expect(closed).toMatchObject({
      id: card.id,
      state: 'RESOLVED',
      detail: { resolution: { by: '10db', reason: 'Alpha started' } },
    });
  });

  it('keeps a refusal card open while another task it named has not started', async () => {
    const alpha = h.addTask('Alpha');
    const beta = h.addTask('Beta', { areas: ['ui'] });
    writeFileSync(join(h.repo, 'scratch.txt'), 'uncommitted\n');
    h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: [alpha.id, beta.id] });
    await h.jobs.idle();
    const card = h.only(h.cards());
    unlinkSync(join(h.repo, 'scratch.txt'));
    h.starter.startBatch(h.project.id, { title: 'Alpha', taskIds: [alpha.id] });
    await h.jobs.idle();
    expect(h.cards().map((c) => c.id)).toEqual([card.id]);
  });

  it('leaves the refusal cards of other tasks open', async () => {
    const alpha = h.addTask('Alpha');
    const beta = h.addTask('Beta', { areas: ['ui'] });
    writeFileSync(join(h.repo, 'scratch.txt'), 'uncommitted\n');
    for (const task of [alpha, beta]) {
      h.starter.startBatch(h.project.id, { title: task.title, taskIds: [task.id] });
      await h.jobs.idle();
    }
    unlinkSync(join(h.repo, 'scratch.txt'));
    h.starter.startBatch(h.project.id, { title: 'Alpha', taskIds: [alpha.id] });
    await h.jobs.idle();
    expect(h.only(h.cards()).title).toContain('uncommitted');
    expect(listInbox(h.store.db, { states: ['RESOLVED'] })).toHaveLength(1);
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

describe('joining a batch', () => {
  it('adds a task started while the batch is open', async () => {
    const batch = await started('Greetings', h.addTask('Alpha'));
    const beta = h.addTask('Beta', { areas: ['ui'] });
    expect(h.starter.startTask(beta.id).id).toBe(batch.id);
    await h.jobs.idle();
    expect(listWorkstreams(h.store.db, { batchId: batch.id }).map((w) => w.taskId)).toContain(
      beta.id,
    );
    expect(h.ticks.count).toBe(2);
  });

  it('adds nothing and raises a card when the checkout left the batch branch', async () => {
    const batch = await started('Greetings', h.addTask('Alpha'));
    h.git$('switch', '-q', 'main');
    const beta = h.addTask('Beta', { areas: ['ui'] });
    h.starter.startTask(beta.id);
    await h.jobs.idle();
    expect(listWorkstreams(h.store.db, { batchId: batch.id }).map((w) => w.taskId)).not.toContain(
      beta.id,
    );
    const card = h.only(h.cards());
    expect(card.title).toContain(`checkout is on main, the batch branch is ${batch.branch ?? ''}`);
    expect(card.body).toContain(
      `Start the task again once the checkout is on ${batch.branch ?? ''}`,
    );
    expect(card.detail).toMatchObject({ batchId: batch.id, taskIds: [beta.id] });
    expect(getBatch(h.store.db, batch.id).state).toBe('OPEN');
  });

  it('says so, naming the tasks, when 10db stops before a join finishes', async () => {
    const batch = await started('Greetings', h.addTask('Alpha'));
    const beta = h.addTask('Beta', { areas: ['ui'] });
    h.starter.startTask(beta.id);
    await h.jobs.stop();
    expect(listWorkstreams(h.store.db, { batchId: batch.id }).map((w) => w.taskId)).not.toContain(
      beta.id,
    );
    const card = h.only(h.cards());
    expect(card.title).toBe('Not added to batch "Greetings": 10db stopped first');
    expect(card.detail).toMatchObject({ batchId: batch.id, taskIds: [beta.id] });
  });

  it('reopens a failed batch with a fix task', async () => {
    const batch = await started('Greetings', h.addTask('Alpha'));
    h.state.write((c) =>
      transitionBatch(c, batch.id, { to: 'FAILED', patch: { failure: 'gate_failed' } }),
    );
    const fix = h.addTask('Fix the gate', { areas: ['ui'] });
    expect(h.starter.startTask(fix.id).id).toBe(batch.id);
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id)).toMatchObject({ state: 'OPEN', failure: null });
    expect(listWorkstreams(h.store.db, { batchId: batch.id }).map((w) => w.taskId)).toContain(
      fix.id,
    );
  });

  it('refuses a batchId that is not the unfinished batch, and joins the one that is', async () => {
    const beta = h.addTask('Beta', { areas: ['ui'] });
    expect(() =>
      h.starter.startBatch(h.project.id, {
        title: 'Fix',
        taskIds: [beta.id],
        batchId: mintId('Batch'),
      }),
    ).toThrow(ConflictError);
    const batch = await started('Greetings', h.addTask('Alpha'));
    expect(() =>
      h.starter.startBatch(h.project.id, {
        title: 'Fix',
        taskIds: [beta.id],
        batchId: mintId('Batch'),
      }),
    ).toThrow(ConflictError);
    expect(
      h.starter.startBatch(h.project.id, { title: 'Fix', taskIds: [beta.id], batchId: batch.id }),
    ).toEqual([batch]);
    await h.jobs.idle();
    expect(listWorkstreams(h.store.db, { batchId: batch.id }).map((w) => w.taskId)).toContain(
      beta.id,
    );
  });

  it.each(['CUTTING', 'SHIPPING'] as const)(
    'refuses a start while the batch is %s',
    async (state) => {
      const alpha = h.addTask('Alpha');
      if (state === 'CUTTING') {
        h.starter.startTask(alpha.id);
      } else {
        const batch = await started('Greetings', alpha);
        h.state.write((c) => transitionBatch(c, batch.id, { to: 'SHIPPING' }));
      }
      const beta = h.addTask('Beta', { areas: ['ui'] });
      expect(() => h.starter.startTask(beta.id)).toThrow(ConflictError);
      expect(() => h.starter.startTask(beta.id)).toThrow(state.toLowerCase());
      await h.jobs.idle();
    },
  );
});

describe('dependencies', () => {
  it('refuses a task whose dependency is unfinished outside the set, with a card, and starts both together', async () => {
    const alpha = h.addTask('Alpha');
    const beta = h.addTask('Beta', { areas: ['ui'], dependsOn: [alpha.id] });
    expect(() => h.starter.startTask(beta.id)).toThrow(ConflictError);
    expect(h.only(h.cards()).body).toContain('Beta needs Alpha');
    expect(listBatches(h.store.db)).toEqual([]);
    const batch = await started('Both', alpha, beta);
    expect(batch.state).toBe('OPEN');
  });

  it("refuses a task whose dependency finished in a batch whose pull request isn't merged, until it is", async () => {
    const alpha = h.addTask('Alpha');
    const first = await started('First', alpha);
    h.settle(h.only(listWorkstreams(h.store.db, { batchId: first.id })).id, 'DONE');
    const url = h.gh.openPr(first.branch ?? '');
    h.state.write((c) => {
      transitionBatch(c, first.id, { to: 'SHIPPING' });
      transitionBatch(c, first.id, { to: 'SHIPPED', patch: { prUrl: url } });
    });
    const beta = h.addTask('Beta', { areas: ['ui'], dependsOn: [alpha.id] });

    h.starter.startTask(beta.id);
    await h.jobs.idle();
    expect(listBatches(h.store.db).map((b) => b.id)).toEqual([first.id]);
    expect(h.only(h.cards()).body).toContain(`its pull request ${url} is open, not merged`);

    h.gh.setState(url, 'MERGED');
    const second = h.starter.startTask(beta.id);
    await h.jobs.idle();
    expect(getBatch(h.store.db, second.id).state).toBe('OPEN');
  });

  it('refuses a task whose dependency finished in an abandoned batch', async () => {
    const alpha = h.addTask('Alpha');
    const first = await started('First', alpha);
    h.settle(h.only(listWorkstreams(h.store.db, { batchId: first.id })).id, 'DONE');
    h.state.write((c) => transitionBatch(c, first.id, { to: 'ABANDONED' }));
    const beta = h.addTask('Beta', { areas: ['ui'], dependsOn: [alpha.id] });
    h.starter.startTask(beta.id);
    await h.jobs.idle();
    expect(h.only(h.cards()).body).toContain('was abandoned');
  });
});

describe('refusals in the request', () => {
  it('refuses a local project', () => {
    const local = seedProject(h.store, { repoPath: `${h.repo}-local` });
    expect(() =>
      h.starter.startBatch(local.id, { title: 'x', taskIds: [h.addTask('Alpha').id] }),
    ).toThrow(InvalidError);
  });

  it('refuses a task that is already running, and one from another project', async () => {
    const alpha = h.addTask('Alpha');
    await started('Greetings', alpha);
    expect(() => h.starter.startTask(alpha.id)).toThrow(/already running/);
    const elsewhere = seedProject(h.store, {
      repoPath: `${h.repo}-other`,
      delivery: 'pull_request',
      prTitlePrefix: 'fix',
    });
    expect(() =>
      h.starter.startBatch(elsewhere.id, { title: 'x', taskIds: [h.addTask('Beta').id] }),
    ).toThrow(/belongs to another project/);
  });

  it('refuses a parked task before it cuts a branch', async () => {
    const alpha = h.addTask('Alpha');
    const icebox = listBoardColumns(h.store.db, h.project.id)[0];
    if (!icebox) throw new Error('no Icebox');
    h.state.write((ctx) => moveTask(ctx, alpha.id, { to: icebox.id, after: null, before: null }));
    expect(() => h.starter.startTask(alpha.id)).toThrow(ConflictError);
    expect(() => h.starter.startTask(alpha.id)).toThrow(/parked in Icebox/);
    await h.jobs.idle();
    expect(listBatches(h.store.db)).toEqual([]);
    expect(h.git$('branch', '--list', '10db/*')).toBe('');
  });
});
