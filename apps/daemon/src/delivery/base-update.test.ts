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
import { basename, dirname, join } from 'node:path';
import { mintId, type BatchDto, type WorkstreamDto } from '@10db/contracts';
import { getBatch, getWorkstreamRow, listWorkstreams, patchWorkstream } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { isolatedGitEnv } from '../../test/fixtures';
import { createBaseUpdates, ensureWorktreeWhole, workstreamChanges } from './index';
import { INSTALL_SUMMARY } from './worktree-dependencies';

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

  it("names the host the sandbox blocked the install after the merge from, in the gate's note and on a card", async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    withLockfile();
    const { batch } = await opened();
    await commitOnBatch(batch, 'src/api/alpha.txt');
    h.teammatePush('main', 'pnpm-lock.yaml', 'lockfileVersion: 9\npackages: {}\n');
    h.pnpm.blockedFrom('registry.npmjs.org');

    const update = await createBaseUpdates(h.ctx).beforeGate(batch.id, signal);

    expect(update).toMatchObject({ kind: 'merged' });
    expect(update.kind === 'merged' && update.note).toMatch(
      /^The install this branch's lockfile needs failed \(exit 1; log: .+\.log\), so its packages may not match it\. The sandbox blocked it from reaching registry\.npmjs\.org\.$/,
    );
    const host = h.only(h.cards());
    expect(host.title).toBe('Allow network access to registry.npmjs.org?');
    expect(host.body).toContain(`Install: ${INSTALL_SUMMARY}`);
    expect(host.targets).toEqual([]);
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
    const kept = gitIn(
      path,
      'rev-parse',
      `refs/10db/${basename(h.worktreeRoot)}/starts/${member(beta.id).id}`,
    );
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

    it('when the conflict notice cannot be written', async () => {
      h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
      const { batch } = await opened();
      await commitOnBatch(batch, 'README.md', '# ours\n');
      h.teammatePush('main', 'README.md', '# theirs\n');
      const closed = Object.create(h.ctx.state, {
        write: {
          value: () => {
            throw new Error('the database is closed');
          },
        },
      }) as typeof h.ctx.state;
      const update = await createBaseUpdates({ ...h.ctx, state: closed }).beforeGate(
        batch.id,
        signal,
      );
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

  it('shows a conflict on the batch and raises no card, however many gates meet it', async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    const { batch } = await opened();
    await commitOnBatch(batch, 'README.md', '# ours\n');
    h.teammatePush('main', 'README.md', '# theirs\n');
    const updates = createBaseUpdates(h.ctx);
    await updates.beforeGate(batch.id, signal);
    const first = getBatch(h.store.db, batch.id);
    await updates.beforeGate(batch.id, signal);
    await updates.beforeGate(batch.id, signal);
    expect(h.cards()).toEqual([]);
    const after = getBatch(h.store.db, batch.id);
    const notice = h.only(after.notices);
    expect(notice).toMatchObject({
      key: 'base-conflict',
      tone: 'warning',
      line: 'Conflicts with main: README.md',
    });
    expect(notice.body).toContain('- README.md');
    expect(notice.body).toContain(
      `git -C '${pathOf(batch)}' -c core.hooksPath=/dev/null merge 'origin/main'`,
    );
    expect(notice.body).toContain('Update branch');
    // The same finding again writes nothing, so no client is told a second time.
    expect(after.updatedAt).toBe(first.updatedAt);
  });

  it("shows files git doesn't track in the way on the batch, tells the fix session to leave them, and clears it once the base merges", async () => {
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
      note: "10db didn't merge origin/main because files in the worktree that git doesn't track are in the way (build/). Don't remove or move them: they may be the builder's, and the batch's tasks show them. This gate ran without origin/main's newer commits.",
    });
    expect(h.cards()).toEqual([]);
    const notice = h.only(getBatch(h.store.db, batch.id).notices);
    expect(notice).toMatchObject({
      key: 'base-kept',
      tone: 'warning',
      line: "Can't take main: files git doesn't track are in the way (build/)",
    });
    expect(notice.body).toContain('- build/');
    expect(notice.body).toContain(path);
    // A second gate meets the same files: still one notice, no card.
    await updates.beforeGate(batch.id, signal);
    expect(getBatch(h.store.db, batch.id).notices).toEqual([notice]);
    expect(h.cards()).toEqual([]);
    // The builder moves the directory away; the next gate merges and the notice goes.
    rmSync(join(path, 'build'), { recursive: true });
    expect((await updates.beforeGate(batch.id, signal)).kind).toBe('merged');
    expect(getBatch(h.store.db, batch.id).notices).toEqual([]);
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
    const first = updates.gate(one, signal, async () => {
      order.push('first starts');
      await held;
      order.push('first ends');
    });
    const second = updates.gate(one, signal, () => {
      order.push('second starts');
      return Promise.resolve();
    });
    await updates.gate(other, signal, () => {
      order.push('other batch starts');
      return Promise.resolve();
    });
    expect(order).toEqual(['first starts', 'other batch starts']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first starts', 'other batch starts', 'first ends', 'second starts']);
    // A gate that fails frees the batch for the next.
    await expect(
      updates.gate(one, signal, () => Promise.reject(new Error('gate broke'))),
    ).rejects.toThrow('gate broke');
    expect(await updates.gate(one, signal, () => Promise.resolve('next'))).toBe('next');
  });

  it("stops a gate waiting for its batch's turn as soon as its signal aborts, and keeps the turn order", async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    const updates = createBaseUpdates(h.ctx);
    const one = mintId('Batch');
    const order: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = updates.gate(one, signal, async () => {
      await held;
      order.push('running ends');
    });
    const stop = new AbortController();
    const waiting = updates.gate(one, stop.signal, () => {
      order.push('cancelled one started');
      return Promise.resolve();
    });
    const later = updates.gate(one, signal, () => {
      order.push('later starts');
      return Promise.resolve();
    });
    stop.abort();
    // Answered while the gate ahead still runs.
    expect(await waiting).toBeNull();
    expect(order).toEqual([]);
    release();
    await Promise.all([running, later]);
    expect(order).toEqual(['running ends', 'later starts']);
    // Already aborted: nothing runs.
    expect(await updates.gate(one, stop.signal, () => Promise.resolve('ran'))).toBeNull();
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

  it('clears the conflict notice once the branch holds the base', async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    const { batch } = await opened();
    await commitOnBatch(batch, 'README.md', '# ours\n');
    h.teammatePush('main', 'README.md', '# theirs\n');
    const updates = createBaseUpdates(h.ctx);
    await updates.beforeGate(batch.id, signal);
    expect(getBatch(h.store.db, batch.id).notices).toHaveLength(1);
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
    expect(getBatch(h.store.db, batch.id).notices).toEqual([]);
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

describe('a migration numbered the same as one the base added since the batch was cut', () => {
  const DRIZZLE = 'packages/db/drizzle';
  const JOURNAL = `${DRIZZLE}/meta/_journal.json`;

  /** A drizzle journal holding `tags`, numbered in order as drizzle-kit writes it. */
  function journal(...tags: string[]): string {
    const entries = tags.map((tag, idx) => ({
      idx,
      version: '6',
      when: idx,
      tag,
      breakpoints: true,
    }));
    return `${JSON.stringify({ version: '7', dialect: 'sqlite', entries }, null, 2)}\n`;
  }

  /** The batch generated 0001 on its old base; main gained its own 0001 meanwhile. */
  async function collided(): Promise<BatchDto> {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    h.commit(JOURNAL, journal('0000_init'));
    h.git$('push', '-q', 'origin', 'main');
    const { batch } = await opened();
    await commitOnBatch(batch, `${DRIZZLE}/0001_branch_change.sql`, 'ALTER TABLE a ADD b text;\n');
    await commitOnBatch(batch, JOURNAL, journal('0000_init', '0001_branch_change'));
    h.teammatePush('main', `${DRIZZLE}/0001_track_prs.sql`, 'ALTER TABLE c ADD d text;\n');
    h.teammatePush('main', JOURNAL, journal('0000_init', '0001_track_prs'));
    return batch;
  }

  it("shows on the batch, before the gate, that the branch's migration must be regenerated on top of the base", async () => {
    const batch = await collided();
    const path = pathOf(batch);
    const updates = createBaseUpdates(h.ctx);
    const update = await updates.beforeGate(batch.id, signal);
    expect(update.kind).toBe('not_merged');
    expect(update.kind === 'not_merged' && update.note).toMatch(
      /^origin\/main conflicts with this branch in packages\/db\/drizzle\/meta\/_journal\.json/,
    );
    await updates.beforeGate(batch.id, signal);
    expect(h.cards()).toEqual([]);
    const notice = h.only(getBatch(h.store.db, batch.id).notices);
    expect(notice.line).toBe('Must regenerate migration 0001_branch_change on top of main');
    expect(notice.body).toContain(
      "Migration 0001_branch_change takes number 0001, which main's 0001_track_prs already has.",
    );
    expect(notice.body).toContain(
      `git -C '${path}' -c core.hooksPath=/dev/null merge 'origin/main'`,
    );
    expect(notice.body).toContain(
      `git -C '${path}' restore --source='origin/main' --staged --worktree -- 'packages/db/drizzle'`,
    );
    expect(notice.body).toContain('drizzle-kit generate');
    expect(notice.body).toContain(`- ${JOURNAL}`);
  });

  it('clears the notice once the branch holds the base with its migration numbered after it', async () => {
    const batch = await collided();
    const path = pathOf(batch);
    const updates = createBaseUpdates(h.ctx);
    await updates.beforeGate(batch.id, signal);
    expect(getBatch(h.store.db, batch.id).notices).toHaveLength(1);
    // The builder follows the card: merge, take main's migrations whole, regenerate, commit.
    expect(() =>
      gitIn(path, '-c', 'core.hooksPath=/dev/null', 'merge', '-q', 'origin/main'),
    ).toThrow();
    gitIn(path, 'restore', '--source=origin/main', '--staged', '--worktree', '--', DRIZZLE);
    expect(existsSync(join(path, DRIZZLE, '0001_branch_change.sql'))).toBe(false);
    // What drizzle-kit generate writes on top of main's migrations.
    writeFileSync(join(path, DRIZZLE, '0002_branch_change.sql'), 'ALTER TABLE a ADD b text;\n');
    writeFileSync(
      join(path, JOURNAL),
      journal('0000_init', '0001_track_prs', '0002_branch_change'),
    );
    gitIn(path, 'add', DRIZZLE);
    gitIn(path, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--no-edit');
    expect((await updates.beforeGate(batch.id, signal)).kind).toBe('up_to_date');
    expect(getBatch(h.store.db, batch.id).notices).toEqual([]);
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
