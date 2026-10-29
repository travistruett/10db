import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { mintId, type BatchDto, type WorkstreamDto } from '@10db/contracts';
import { getBatch, getWorkstreamRow, listWorkstreams, patchWorkstream } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { isolatedGitEnv } from '../../test/fixtures';
import { createBaseUpdates, ensureWorktreeWhole, workstreamChanges } from './index';

let h: DeliveryHarness;
afterEach(() => {
  h.close();
});

const signal = new AbortController().signal;

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();
}

function pathOf(batch: BatchDto): string {
  if (batch.worktreePath === null) throw new Error(`batch ${batch.title} has no worktree path`);
  return batch.worktreePath;
}

/** Starts one task and waits for its batch to open; its workstream starts at the batch's base. */
async function opened(): Promise<{ batch: BatchDto; ws: WorkstreamDto }> {
  const started = h.starter.startTask(h.addTask('Alpha').id);
  await h.jobs.idle();
  const batch = getBatch(h.store.db, started.id);
  expect(batch.state).toBe('OPEN');
  const ws = h.only(listWorkstreams(h.store.db, { batchId: batch.id }));
  // Where the runner's first session records it.
  h.state.write((c) => {
    patchWorkstream(c, ws.id, null, { baseHead: batch.baseSha ?? '' });
  });
  return { batch, ws };
}

/** Writes and commits a file on the batch branch where its work is, as the commit tool does. */
async function commitOnBatch(batch: BatchDto, path: string, content = `${path}\n`) {
  const checkout = batch.worktreePath ?? h.repo;
  const file = join(checkout, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  const { sha } = await h.git.commit({
    repo: checkout,
    paths: [path],
    message: `Add ${path}`,
    opId: `op-${path.replaceAll('/', '-')}`,
    branch: batch.branch ?? '',
  });
  return sha;
}

/** A lockfile and seeded packages on main, so a cut installs and records what it installed. */
function withLockfile(): void {
  h.commit('.gitignore', 'node_modules/\n');
  h.commit('pnpm-lock.yaml', 'lockfileVersion: 9\n');
  h.git$('push', '-q', 'origin', 'main');
  mkdirSync(join(h.repo, 'node_modules', 'pkg'), { recursive: true });
}

/** The delivery log's lines with message `msg`. */
const logged = (msg: string) => h.logs.lines().filter((line) => line['msg'] === msg);

/** What the gate would see of a checkout: its branch, HEAD and changes. */
function state(checkout: string) {
  return {
    branch: gitIn(checkout, 'branch', '--show-current'),
    head: gitIn(checkout, 'rev-parse', 'HEAD'),
    status: gitIn(checkout, 'status', '--porcelain', '--untracked-files=all'),
  };
}

describe('bringing a worktree batch up to date with its base before a gate', () => {
  it("merges the base as origin has it now into the batch's branch, and moves the batch's base and its task's starting point", async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    const { batch, ws } = await opened();
    const own = await commitOnBatch(batch, 'src/api/alpha.txt');
    const teammate = h.teammatePush('main', 'src/ui/teammate.txt');
    const update = await createBaseUpdates(h.ctx).beforeGate(batch.id, signal);
    const path = pathOf(batch);
    const head = gitIn(path, 'rev-parse', 'HEAD');
    expect(update).toEqual({ kind: 'merged', base: teammate, head, note: null });
    expect(gitIn(path, 'log', '-1', '--format=%P %s')).toBe(
      `${own} ${teammate} Merge origin/main into ${batch.branch ?? ''}`,
    );
    expect(readFileSync(join(path, 'src/ui/teammate.txt'), 'utf8')).toBe('src/ui/teammate.txt\n');
    expect(state(path).status).toBe('');
    expect(getBatch(h.store.db, batch.id).baseSha).toBe(teammate);
    expect(getWorkstreamRow(h.store.db, ws.id).baseHead).toBe(teammate);
    expect(logged('base merged into the batch branch')).toHaveLength(1);
    expect(h.cards()).toEqual([]);
  });

  it('changes nothing when origin has nothing newer', async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    const { batch } = await opened();
    await commitOnBatch(batch, 'src/api/alpha.txt');
    const before = state(pathOf(batch));
    expect(await createBaseUpdates(h.ctx).beforeGate(batch.id, signal)).toEqual({
      kind: 'up_to_date',
      note: null,
    });
    expect(state(pathOf(batch))).toEqual(before);
    expect(getBatch(h.store.db, batch.id).baseSha).toBe(batch.baseSha);
  });

  it('runs the install again when the base changed the lockfile', async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    h.commit('.gitignore', 'node_modules/\n');
    h.commit('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    h.git$('push', '-q', 'origin', 'main');
    mkdirSync(join(h.repo, 'node_modules', 'pkg'), { recursive: true });
    const { batch } = await opened();
    const path = realpathSync(pathOf(batch));
    expect(h.pnpm.calls()).toHaveLength(1);
    await commitOnBatch(batch, 'src/api/alpha.txt');
    h.teammatePush('main', 'src/ui/teammate.txt');
    await createBaseUpdates(h.ctx).beforeGate(batch.id, signal);
    // A merge that leaves the lockfile alone needs no install.
    expect(h.pnpm.calls()).toHaveLength(1);
    h.teammatePush('main', 'pnpm-lock.yaml', 'lockfileVersion: 9\npackages: {}\n');
    const update = await createBaseUpdates(h.ctx).beforeGate(batch.id, signal);
    expect(update.kind).toBe('merged');
    expect(h.pnpm.calls()).toHaveLength(2);
    expect(h.pnpm.calls()[1]).toMatch(new RegExp(`^${path} \\| install --frozen-lockfile`));
  });

  it("says in the gate's note when the install after the merge failed", async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    h.commit('.gitignore', 'node_modules/\n');
    h.commit('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    h.git$('push', '-q', 'origin', 'main');
    mkdirSync(join(h.repo, 'node_modules', 'pkg'), { recursive: true });
    const { batch } = await opened();
    await commitOnBatch(batch, 'src/api/alpha.txt');
    h.teammatePush('main', 'pnpm-lock.yaml', 'lockfileVersion: 9\npackages: {}\n');
    h.pnpm.failWith(1, 'ERR_PNPM_FETCH_403');
    const update = await createBaseUpdates(h.ctx).beforeGate(batch.id, signal);
    expect(update).toMatchObject({ kind: 'merged' });
    expect(update.kind === 'merged' && update.note).toMatch(
      /^The install this branch's lockfile needs failed \(exit 1; log: .+\.log\), so its packages may not match it\.$/,
    );
  });

  it('installs again at the next gate when the last install failed, and not once one passed', async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    withLockfile();
    const { batch } = await opened();
    await commitOnBatch(batch, 'src/api/alpha.txt');
    h.teammatePush('main', 'pnpm-lock.yaml', 'lockfileVersion: 9\npackages: {}\n');
    h.pnpm.failWith(1, 'ERR_PNPM_FETCH_403');
    const updates = createBaseUpdates(h.ctx);
    expect((await updates.beforeGate(batch.id, signal)).kind).toBe('merged');
    expect(h.pnpm.calls()).toHaveLength(2);
    h.pnpm.succeed();
    expect(await updates.beforeGate(batch.id, signal)).toEqual({ kind: 'up_to_date', note: null });
    expect(h.pnpm.calls()).toHaveLength(3);
    await updates.beforeGate(batch.id, signal);
    expect(h.pnpm.calls()).toHaveLength(3);
  });

  it('installs at the next gate of a worktree made again for Retry', async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    withLockfile();
    const { batch } = await opened();
    await commitOnBatch(batch, 'src/api/alpha.txt');
    expect(h.pnpm.calls()).toHaveLength(1);
    // The repair's install fails, so the worktree it made holds the checkout's older packages.
    rmSync(pathOf(batch), { recursive: true, force: true });
    h.pnpm.failWith(1, 'ERR_PNPM_FETCH_403');
    expect(await ensureWorktreeWhole(h.ctx, batch, signal)).toBe('refused');
    h.pnpm.succeed();
    expect(await ensureWorktreeWhole(h.ctx, batch, signal)).toBe('replaced');
    expect(h.pnpm.calls()).toHaveLength(3);
    await createBaseUpdates(h.ctx).beforeGate(batch.id, signal);
    // The repair's own install passed and recorded its lockfile: no install at the gate.
    expect(h.pnpm.calls()).toHaveLength(3);
  });

  it('moves the start of a task that began after an earlier merge onto the newly merged base, so its changes are only its own', async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    // Two linked tasks share one batch and its worktree.
    const alpha = h.addTask('Alpha');
    const beta = h.addTask('Beta', { areas: ['ui'], dependsOn: [alpha.id] });
    const started = h.only(
      h.starter.startBatch(h.project.id, { title: 'Pair', taskIds: [alpha.id, beta.id] }),
    );
    await h.jobs.idle();
    const batch = getBatch(h.store.db, started.id);
    const member = (taskId: string) =>
      h.only(listWorkstreams(h.store.db, { batchId: batch.id }).filter((w) => w.taskId === taskId));
    const path = pathOf(batch);
    const startAt = (id: WorkstreamDto['id'], sha: string) => {
      h.state.write((c) => {
        patchWorkstream(c, id, null, { baseHead: sha });
      });
    };
    startAt(member(alpha.id).id, batch.baseSha ?? '');
    await commitOnBatch(batch, 'src/api/alpha.txt');
    h.teammatePush('main', 'src/ui/first.txt');
    const updates = createBaseUpdates(h.ctx);
    expect((await updates.beforeGate(batch.id, signal)).kind).toBe('merged');
    // Beta starts on that merge, then commits its own file; main moves on again.
    startAt(member(beta.id).id, gitIn(path, 'rev-parse', 'HEAD'));
    await commitOnBatch(batch, 'src/ui/beta.txt');
    h.teammatePush('main', 'src/ui/second.txt');
    expect((await updates.beforeGate(batch.id, signal)).kind).toBe('merged');
    const changes = await workstreamChanges({ db: h.store.db, git: h.git }, member(beta.id).id);
    expect(changes.files.map((f) => f.path)).toEqual(['src/ui/beta.txt']);
    const kept = gitIn(path, 'rev-parse', `refs/10db/starts/${member(beta.id).id}`);
    expect(getWorkstreamRow(h.store.db, member(beta.id).id).baseHead).toBe(kept);
  });

  it("never moves the batch's base back when the base branch was forced to an older commit", async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    h.teammatePush('main', 'src/ui/first.txt');
    const { batch, ws } = await opened();
    await commitOnBatch(batch, 'src/api/alpha.txt');
    h.origin$('update-ref', 'refs/heads/main', h.origin$('rev-parse', 'main~1'));
    expect((await createBaseUpdates(h.ctx).beforeGate(batch.id, signal)).kind).toBe('up_to_date');
    expect(getBatch(h.store.db, batch.id).baseSha).toBe(batch.baseSha);
    expect(getWorkstreamRow(h.store.db, ws.id).baseHead).toBe(batch.baseSha);
  });

  describe('never throws: what goes wrong is a note', () => {
    it('when the install throws', async () => {
      h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
      // A lockfile with no packages to seed, so the cut installs nothing and the gate must.
      h.commit('pnpm-lock.yaml', 'lockfileVersion: 9\n');
      h.git$('push', '-q', 'origin', 'main');
      const { batch } = await opened();
      const ctx = {
        ...h.ctx,
        dependencies: { refresh: () => Promise.reject(new Error('the install blew up')) },
      };
      const update = await createBaseUpdates(ctx).beforeGate(batch.id, signal);
      expect(update.kind).toBe('up_to_date');
      expect(update.kind === 'up_to_date' && update.note).toMatch(
        /^10db couldn't run the install this branch's lockfile needs \(the install blew up\)/,
      );
    });

    it('when the conflict card cannot be raised', async () => {
      h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
      const { batch } = await opened();
      await commitOnBatch(batch, 'README.md', '# ours\n');
      h.teammatePush('main', 'README.md', '# theirs\n');
      const inbox = {
        ...h.ctx.inbox,
        flag: () => {
          throw new Error('the inbox is closed');
        },
      };
      const update = await createBaseUpdates({ ...h.ctx, inbox }).beforeGate(batch.id, signal);
      expect(update.kind).toBe('not_merged');
      expect(update.kind === 'not_merged' && update.note).toMatch(/^origin\/main conflicts/);
    });
  });

  describe('gates the branch as it is, and says why', () => {
    it.each([
      {
        name: 'a conflict with the base',
        setup: async (batch: BatchDto) => {
          await commitOnBatch(batch, 'README.md', '# ours\n');
          h.teammatePush('main', 'README.md', '# theirs\n');
        },
        note: /^origin\/main conflicts with this branch in README\.md, so this gate ran without its newer commits/,
      },
      {
        name: 'an uncommitted change where the base changed a file',
        setup: async (batch: BatchDto) => {
          await commitOnBatch(batch, 'src/api/alpha.txt');
          h.teammatePush('main', 'README.md', '# theirs\n');
          writeFileSync(join(pathOf(batch), 'README.md'), '# a lane is still writing\n');
        },
        note: /^Uncommitted changes in README\.md are in the way of origin\/main's newer commits, so this gate ran without them/,
      },
      {
        name: 'a fetch that fails',
        setup: async (batch: BatchDto) => {
          await commitOnBatch(batch, 'src/api/alpha.txt');
          renameSync(h.origin, `${h.origin}-unreachable`);
        },
        note: /^10db couldn't fetch main from origin \(.+\), so this gate ran on the branch without any newer commits on main/,
      },
    ])('$name', async ({ setup, note }) => {
      h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
      const { batch } = await opened();
      await setup(batch);
      const before = state(pathOf(batch));
      try {
        const update = await createBaseUpdates(h.ctx).beforeGate(batch.id, signal);
        expect(update.kind).toBe('not_merged');
        expect(update.kind === 'not_merged' && update.note).toMatch(note);
      } finally {
        if (existsSync(`${h.origin}-unreachable`)) renameSync(`${h.origin}-unreachable`, h.origin);
      }
      expect(state(pathOf(batch))).toEqual(before);
      expect(getBatch(h.store.db, batch.id).baseSha).toBe(batch.baseSha);
      expect(logged('base not merged before the gate')).toHaveLength(1);
    });
  });

  it('raises one card for a conflict, however many gates meet it', async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    const { batch } = await opened();
    await commitOnBatch(batch, 'README.md', '# ours\n');
    h.teammatePush('main', 'README.md', '# theirs\n');
    const updates = createBaseUpdates(h.ctx);
    await updates.beforeGate(batch.id, signal);
    await updates.beforeGate(batch.id, signal);
    const card = h.only(h.cards());
    expect(card.title).toBe('Batch "Alpha" conflicts with main');
    expect(card.body).toContain('- README.md');
    expect(card.body).toContain(
      `git -C '${pathOf(batch)}' -c core.hooksPath=/dev/null merge 'origin/main'`,
    );
    expect(card.body).toContain('Update branch');
    expect(card.detail).toEqual({ batchId: batch.id, paths: ['README.md'] });
  });

  it("raises a card for files git doesn't track in the way, tells the fix session to leave them, and withdraws it once the base merges", async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    h.commit('.gitignore', 'build/\n');
    h.git$('push', '-q', 'origin', 'main');
    const { batch } = await opened();
    const path = pathOf(batch);
    await commitOnBatch(batch, 'src/api/alpha.txt');
    // The worktree holds an ignored build directory; main starts tracking a file of that name.
    mkdirSync(join(path, 'build'));
    writeFileSync(join(path, 'build', 'out.js'), 'built\n');
    h.teammatePush('main', 'build', 'a file now\n');
    const updates = createBaseUpdates(h.ctx);
    const blocked = await updates.beforeGate(batch.id, signal);
    expect(blocked).toEqual({
      kind: 'not_merged',
      note: "10db didn't merge origin/main because files in the worktree that git doesn't track are in the way (build/). Don't remove or move them: they may be the builder's, and the builder has a card about them. This gate ran without origin/main's newer commits.",
    });
    const card = h.only(h.cards());
    expect(card.title).toBe(
      `Batch "Alpha" can't take main: files git doesn't track are in the way`,
    );
    expect(card.body).toContain('- build/');
    expect(card.body).toContain(path);
    expect(card.detail).toEqual({ batchId: batch.id, paths: ['build/'] });
    // A second gate meets the same files: still one card.
    await updates.beforeGate(batch.id, signal);
    expect(h.cards()).toHaveLength(1);
    // The builder moves the directory away; the next gate merges and the card goes.
    rmSync(join(path, 'build'), { recursive: true });
    expect((await updates.beforeGate(batch.id, signal)).kind).toBe('merged');
    expect(h.cards()).toEqual([]);
  });

  it('runs one gate of a batch at a time, and the gates of other batches beside it', async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    const updates = createBaseUpdates(h.ctx);
    const [one, other] = [mintId('Batch'), mintId('Batch')];
    const order: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = updates.gate(one, async () => {
      order.push('first starts');
      await held;
      order.push('first ends');
    });
    const second = updates.gate(one, () => {
      order.push('second starts');
      return Promise.resolve();
    });
    await updates.gate(other, () => {
      order.push('other batch starts');
      return Promise.resolve();
    });
    expect(order).toEqual(['first starts', 'other batch starts']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first starts', 'other batch starts', 'first ends', 'second starts']);
    // A gate that fails frees the batch for the next.
    await expect(updates.gate(one, () => Promise.reject(new Error('gate broke')))).rejects.toThrow(
      'gate broke',
    );
    expect(await updates.gate(one, () => Promise.resolve('next'))).toBe('next');
  });

  it('says the branch was merged but its base not moved when recording the base fails, and still installs', async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    withLockfile();
    const { batch } = await opened();
    await commitOnBatch(batch, 'src/api/alpha.txt');
    h.teammatePush('main', 'pnpm-lock.yaml', 'lockfileVersion: 9\npackages: {}\n');
    const git = { ...h.git, isAncestor: () => Promise.reject(new Error('history unreadable')) };
    const update = await createBaseUpdates({ ...h.ctx, git }).beforeGate(batch.id, signal);
    expect(update.kind).toBe('merged');
    expect(update.kind === 'merged' && update.note).toMatch(
      /^10db merged origin\/main into this branch but couldn't move the batch's base to it \(history unreadable\)/,
    );
    expect(h.pnpm.calls()).toHaveLength(2);
    expect(getBatch(h.store.db, batch.id).baseSha).toBe(batch.baseSha);
  });

  it('withdraws the conflict card once the branch holds the base', async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    const { batch } = await opened();
    await commitOnBatch(batch, 'README.md', '# ours\n');
    h.teammatePush('main', 'README.md', '# theirs\n');
    const updates = createBaseUpdates(h.ctx);
    await updates.beforeGate(batch.id, signal);
    expect(h.cards()).toHaveLength(1);
    // The builder merges by hand in the worktree, keeping the batch's side of the conflict.
    gitIn(
      pathOf(batch),
      '-c',
      'core.hooksPath=/dev/null',
      'merge',
      '-q',
      '-X',
      'ours',
      '-m',
      'Merge main',
      'origin/main',
    );
    expect((await updates.beforeGate(batch.id, signal)).kind).toBe('up_to_date');
    expect(h.cards()).toEqual([]);
  });

  it('does nothing once shutdown has aborted it', async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    const { batch } = await opened();
    await commitOnBatch(batch, 'src/api/alpha.txt');
    h.teammatePush('main', 'src/ui/teammate.txt');
    const before = state(pathOf(batch));
    const stop = new AbortController();
    stop.abort();
    expect(await createBaseUpdates(h.ctx).beforeGate(batch.id, stop.signal)).toEqual({
      kind: 'aborted',
    });
    expect(state(pathOf(batch))).toEqual(before);
  });
});

describe("a batch in the builder's own checkout (shared mode)", () => {
  it('never merges into the checkout, and says how far behind the base the branch is', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const { batch } = await opened();
    await commitOnBatch(batch, 'src/api/alpha.txt');
    h.teammatePush('main', 'src/ui/one.txt');
    h.teammatePush('main', 'src/ui/two.txt');
    const before = state(h.repo);
    const update = await createBaseUpdates(h.ctx).beforeGate(batch.id, signal);
    expect(update).toEqual({
      kind: 'not_merged',
      note: `origin/main has 2 commits this branch doesn't. 10db merges the base only into the worktrees it makes, never into the builder's own checkout, so this gate ran without them: a failure they fix shows here until origin/main is merged into ${batch.branch ?? ''}.`,
    });
    expect(state(h.repo)).toEqual(before);
    expect(existsSync(join(h.repo, 'src/ui/one.txt'))).toBe(false);
    expect(getBatch(h.store.db, batch.id).baseSha).toBe(batch.baseSha);
  });

  it('says nothing when the branch holds the base', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const { batch } = await opened();
    await commitOnBatch(batch, 'src/api/alpha.txt');
    expect(await createBaseUpdates(h.ctx).beforeGate(batch.id, signal)).toEqual({
      kind: 'up_to_date',
      note: null,
    });
  });
});
