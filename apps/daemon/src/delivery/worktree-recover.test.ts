import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { mintId, type BatchDto, type BatchId, type WorkstreamDto } from '@10db/contracts';
import {
  clearWorktreePath,
  deleteAppSetting,
  getAppSetting,
  getBatch,
  insertBatch,
  listBatches,
  listLiveWorktrees,
  listWorkstreams,
  patchBatch,
  seedProject,
  setAppSetting,
  transitionBatch,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { isolatedGitEnv, tempDir, type TempDir } from '../../test/fixtures';
import { createGit, parseWorktreeList, type Git } from '../git';
import { silentLogger } from '../log';
import { systemProcesses } from '../recovery';
import { batchBranchName, createBatchStarter, recoverBatches, type DeliveryJobs } from './index';
import { sweepWorktrees } from './worktree-sweep';

let h: DeliveryHarness;
let elsewhere: TempDir;
beforeEach(() => {
  h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
  elsewhere = tempDir('elsewhere');
});
afterEach(() => {
  h.close();
  elsewhere.cleanup();
});

/** Startup batch recovery as the daemon runs it, with `git` as the restarted daemon's. */
const recover = (git: Git = h.git) =>
  recoverBatches({
    state: h.state,
    git,
    inbox: h.inbox,
    processes: systemProcesses,
    shipper: h.shipper,
    logger: silentLogger,
    worktrees: { ctx: { ...h.ctx, git }, root: h.worktreeRoot },
  });

/** git in a directory, as a builder's terminal would run it. */
function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();
}

/** A path as the file system names it, or as text when nothing is there. */
const comparable = (path: string): string =>
  existsSync(path) ? realpathSync(path) : resolve(path);

/** Every worktree git lists for the main checkout, the main checkout first. */
function listed(): string[] {
  return parseWorktreeList(gitIn(h.repo, 'worktree', 'list', '--porcelain', '-z')).map((e) =>
    comparable(e.path),
  );
}

/** What `git worktree list` may hold: the main checkout and the worktrees of live batches. */
function expectOnlyLiveWorktrees(): void {
  const live = listLiveWorktrees(h.store.db).map((b) => comparable(pathOf(b)));
  expect(listed().sort()).toEqual([realpathSync(h.repo), ...live].sort());
}

function pathOf(batch: BatchDto): string {
  if (batch.worktreePath === null) throw new Error(`batch ${batch.title} has no worktree path`);
  return batch.worktreePath;
}

function onOrigin(branch: string | null): string | null {
  try {
    return h.origin$('rev-parse', '--verify', '-q', `refs/heads/${branch ?? ''}`);
  } catch {
    return null;
  }
}

function branchExists(branch: string): boolean {
  return h.git$('branch', '--list', branch) !== '';
}

/** A start whose cut never ran: the CUTTING row and its QUEUED workstreams, nothing in git. */
function cuttingRow(): { batch: BatchDto; path: string; branch: string } {
  const noJobs: DeliveryJobs = {
    run: () => undefined,
    idle: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
  const started = createBatchStarter({ ...h.ctx, jobs: noJobs }).startTask(h.addTask('Alpha').id);
  const batch = getBatch(h.store.db, started.id);
  expect(batch.state).toBe('CUTTING');
  return { batch, path: pathOf(batch), branch: batchBranchName(batch.title, batch.id) };
}

/** What a cut's `worktree add` leaves: a locked entry on the branch, pinned, with no files yet. */
function addedWorktree(batch: BatchDto, path: string, branch: string): void {
  h.state.write((c) => {
    setAppSetting(c, `checkout_pin.${batch.id}`, { kept: true });
  });
  h.git$(
    'worktree',
    'add',
    '-q',
    '--no-checkout',
    '--lock',
    '--reason',
    `10db ${batch.id}`,
    path,
    branch,
  );
}

/** Starts one task and waits for its worktree. */
async function opened(): Promise<{ batch: BatchDto; ws: WorkstreamDto; path: string }> {
  const started = h.starter.startTask(h.addTask('Alpha').id);
  await h.jobs.idle();
  const batch = getBatch(h.store.db, started.id);
  expect(batch.state).toBe('OPEN');
  return {
    batch,
    ws: h.only(listWorkstreams(h.store.db, { batchId: batch.id })),
    path: pathOf(batch),
  };
}

/** Commits a file in the batch's worktree as the commit tool does for an agent; returns the SHA. */
async function commitIn(batch: BatchDto, path: string): Promise<string> {
  const file = join(pathOf(batch), path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${path}\n`);
  const { sha } = await h.git.commit({
    repo: pathOf(batch),
    paths: [path],
    message: `Add ${path}`,
    opId: `op-${path}`,
    branch: batch.branch ?? '',
  });
  return sha;
}

/** An open batch whose work finished, with one commit, moved to SHIPPING by the trigger. */
async function shipping(): Promise<{ batch: BatchDto; path: string; head: string }> {
  const { batch, ws, path } = await opened();
  const head = await commitIn(batch, 'src/api/alpha.txt');
  h.settle(ws.id, 'DONE');
  h.state.write((c) => transitionBatch(c, batch.id, { to: 'SHIPPING' }));
  return { batch: getBatch(h.store.db, batch.id), path, head };
}

/** A batch that reached `to` with its worktree still on disk and its path and pin still set. */
async function finished(
  to: 'SHIPPED' | 'CLOSED' | 'ABANDONED',
): Promise<{ batch: BatchDto; path: string }> {
  const { batch, ws, path } = await opened();
  if (to === 'SHIPPED') await commitIn(batch, 'src/api/alpha.txt');
  h.settle(ws.id, to === 'ABANDONED' ? 'CANCELLED' : 'DONE');
  h.state.write((c) => {
    if (to !== 'ABANDONED') transitionBatch(c, batch.id, { to: 'SHIPPING' });
    transitionBatch(c, batch.id, {
      to,
      ...(to === 'SHIPPED' ? { patch: { prUrl: 'https://github.com/acme/widgets/pull/9' } } : {}),
    });
    setAppSetting(c, `checkout_pin.${batch.id}`, { kept: true });
  });
  return { batch: getBatch(h.store.db, batch.id), path };
}

const CUT_INTERRUPTED = 'Batch not started: 10db stopped while cutting the branch for "Alpha"';

/** What a crash at a point left, and what startup recovery must make of it. */
interface CrashPoint {
  readonly name: string;
  readonly check: () => Promise<void>;
}

/** A CUTTING row's recovery: the row gone, its work cancelled and detached, the start's card. */
function expectCutDeleted(batch: BatchDto, cardTitle: string): void {
  expect(listBatches(h.store.db)).toEqual([]);
  const ws = h.only(listWorkstreams(h.store.db, {}));
  expect(ws).toMatchObject({ state: 'CANCELLED', batchId: null });
  // A branch the crash left behind has no batch any more, and is listed in a card of its own.
  expect(h.only(h.cards().filter((c) => !c.title.includes('without a task'))).title).toBe(
    cardTitle,
  );
  expect(getAppSetting(h.store.db, `checkout_pin.${batch.id}`)).toBeUndefined();
}

describe('recoverBatches with worktrees', () => {
  it.each<CrashPoint>([
    {
      name: 'after the CUTTING insert',
      check: async () => {
        const { batch, path } = cuttingRow();
        const report = await recover();
        expect(report.deleted).toEqual([batch.id]);
        expectCutDeleted(batch, CUT_INTERRUPTED);
        expect(existsSync(path)).toBe(false);
      },
    },
    {
      name: 'after update-ref',
      check: async () => {
        const { batch, branch } = cuttingRow();
        h.git$('update-ref', `refs/heads/${branch}`, 'HEAD');
        await recover();
        expectCutDeleted(batch, CUT_INTERRUPTED);
        expect(branchExists(branch)).toBe(true);
        const stray = h.only(h.cards().filter((c) => c.title.includes('without a task')));
        expect(stray.body).toContain(branch);
      },
    },
    {
      name: 'after worktree add',
      check: async () => {
        const { batch, path, branch } = cuttingRow();
        h.git$('update-ref', `refs/heads/${branch}`, 'HEAD');
        addedWorktree(batch, path, branch);
        expect(listed()).toContain(comparable(path));
        await recover();
        expectCutDeleted(batch, CUT_INTERRUPTED);
        expect(existsSync(path)).toBe(false);
        expect(branchExists(branch)).toBe(true);
      },
    },
    {
      name: 'after read-tree',
      check: async () => {
        const { batch, path, branch } = cuttingRow();
        h.git$('update-ref', `refs/heads/${branch}`, 'HEAD');
        addedWorktree(batch, path, branch);
        gitIn(path, 'read-tree', '-m', '-u', 'HEAD');
        expect(existsSync(join(path, 'README.md'))).toBe(true);
        await recover();
        expectCutDeleted(batch, CUT_INTERRUPTED);
        expect(existsSync(path)).toBe(false);
      },
    },
    {
      name: 'mid seed',
      check: async () => {
        const { batch, path, branch } = cuttingRow();
        h.git$('update-ref', `refs/heads/${branch}`, 'HEAD');
        addedWorktree(batch, path, branch);
        gitIn(path, 'read-tree', '-m', '-u', 'HEAD');
        mkdirSync(join(path, 'node_modules', 'left-pad'), { recursive: true });
        writeFileSync(join(path, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
        await recover();
        expectCutDeleted(batch, CUT_INTERRUPTED);
        expect(existsSync(path)).toBe(false);
      },
    },
    {
      name: 'an unlisted empty directory at the path',
      check: async () => {
        const { batch, path } = cuttingRow();
        mkdirSync(path, { recursive: true });
        await recover();
        expectCutDeleted(batch, CUT_INTERRUPTED);
        expect(existsSync(path)).toBe(false);
      },
    },
    {
      name: 'an unlisted directory with files',
      check: async () => {
        const { batch, path } = cuttingRow();
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, 'notes.txt'), 'mine\n');
        await recover();
        expectCutDeleted(batch, `10db left ${path} in place`);
        expect(existsSync(join(path, 'notes.txt'))).toBe(true);
      },
    },
    {
      name: 'OPEN with its worktree missing',
      check: async () => {
        const { batch, path } = await opened();
        rmSync(path, { recursive: true, force: true });
        const report = await recover();
        expect(report.failed).toEqual([batch.id]);
        expect(getBatch(h.store.db, batch.id)).toMatchObject({
          state: 'FAILED',
          worktreePath: path,
        });
        const card = h.only(h.cards());
        expect(card.title).toBe(`Batch "Alpha" failed: its worktree ${path} is missing`);
      },
    },
    {
      name: 'SHIPPING with its worktree on another branch',
      check: async () => {
        const { batch, path } = await shipping();
        gitIn(path, 'switch', '-q', '-c', 'elsewhere');
        const report = await recover();
        await h.jobs.idle();
        expect(report).toMatchObject({ failed: [batch.id], resumed: [] });
        expect(getBatch(h.store.db, batch.id)).toMatchObject({
          state: 'FAILED',
          failure: 'wrong_branch',
          worktreePath: path,
        });
        const card = h.only(h.cards());
        expect(card.title).toContain('failed: checkout is on elsewhere');
        expect(card.body).toContain(path);
        expect(h.gh.prCreates()).toEqual([]);
      },
    },
    {
      name: 'OPEN with no pin',
      check: async () => {
        const { batch, path } = await opened();
        h.state.write((c) => {
          deleteAppSetting(c, `checkout_pin.${batch.id}`);
        });
        // The restarted daemon's git finds no pin for the worktree.
        const restarted = createGit({ worktreeRoot: h.worktreeRoot });
        const report = await recover(restarted);
        expect(report.failed).toEqual([batch.id]);
        expect(getBatch(h.store.db, batch.id)).toMatchObject({
          state: 'FAILED',
          worktreePath: path,
        });
        expect(h.only(h.cards()).body).toContain(path);
      },
    },
    {
      name: 'FAILED with its worktree missing',
      check: async () => {
        const { batch, path } = await opened();
        h.state.write((c) =>
          transitionBatch(c, batch.id, { to: 'FAILED', patch: { failure: 'gate_failed' } }),
        );
        rmSync(path, { recursive: true, force: true });
        const report = await recover();
        expect(report.failed).toEqual([]);
        expect(getBatch(h.store.db, batch.id)).toMatchObject({
          state: 'FAILED',
          worktreePath: path,
        });
        expect(h.cards()).toEqual([]);
      },
    },
    {
      name: 'SHIPPING after the gate',
      check: async () => {
        const { batch, path, head } = await shipping();
        h.state.write((c) => patchBatch(c, batch.id, { gateExitCode: 0 }));
        const report = await recover();
        expect(report.resumed).toEqual([batch.id]);
        await h.jobs.idle();
        expect(getBatch(h.store.db, batch.id)).toMatchObject({
          state: 'SHIPPED',
          worktreePath: null,
        });
        expect(h.gh.prCreates()).toHaveLength(1);
        expect(onOrigin(batch.branch)).toBe(head);
        expect(existsSync(path)).toBe(false);
      },
    },
    {
      name: 'SHIPPING after the push',
      check: async () => {
        const { batch, path, head } = await shipping();
        h.git$('push', '-q', 'origin', batch.branch ?? '');
        await recover();
        await h.jobs.idle();
        expect(getBatch(h.store.db, batch.id)).toMatchObject({
          state: 'SHIPPED',
          worktreePath: null,
        });
        expect(h.gh.prCreates()).toHaveLength(1);
        expect(onOrigin(batch.branch)).toBe(head);
        expect(existsSync(path)).toBe(false);
      },
    },
    {
      name: 'SHIPPING after gh pr create',
      check: async () => {
        const { batch, path, head } = await shipping();
        h.git$('push', '-q', 'origin', batch.branch ?? '');
        const url = h.gh.openPr(batch.branch ?? '');
        await recover();
        await h.jobs.idle();
        expect(getBatch(h.store.db, batch.id)).toMatchObject({
          state: 'SHIPPED',
          prUrl: url,
          worktreePath: null,
        });
        expect(h.gh.calls.filter((c) => c.method === 'prCreate')).toHaveLength(0);
        expect(onOrigin(batch.branch)).toBe(head);
        expect(existsSync(path)).toBe(false);
      },
    },
    {
      name: 'SHIPPED with its path still set',
      check: async () => {
        const { batch, path } = await finished('SHIPPED');
        const report = await recover();
        expect(report.retired).toEqual([batch.id]);
        expect(getBatch(h.store.db, batch.id).worktreePath).toBeNull();
        expect(existsSync(path)).toBe(false);
        expect(getAppSetting(h.store.db, `checkout_pin.${batch.id}`)).toBeUndefined();
        expect(branchExists(batch.branch ?? '')).toBe(true);
      },
    },
    {
      name: 'SHIPPED after the removal, before the clear',
      check: async () => {
        const { batch, path } = await finished('SHIPPED');
        h.git$('worktree', 'remove', '--force', '--force', path);
        await recover();
        expect(getBatch(h.store.db, batch.id).worktreePath).toBeNull();
        expect(getAppSetting(h.store.db, `checkout_pin.${batch.id}`)).toBeUndefined();
      },
    },
    {
      name: 'CLOSED with its path still set',
      check: async () => {
        const { batch, path } = await finished('CLOSED');
        await recover();
        expect(getBatch(h.store.db, batch.id).worktreePath).toBeNull();
        expect(existsSync(path)).toBe(false);
        expect(branchExists(batch.branch ?? '')).toBe(false);
      },
    },
    {
      name: 'CLOSED after branch deletion, before the clear',
      check: async () => {
        const { batch } = await finished('CLOSED');
        h.git$('worktree', 'remove', '--force', '--force', pathOf(batch));
        h.git$('update-ref', '-d', `refs/heads/${batch.branch ?? ''}`, batch.baseSha ?? '');
        await recover();
        expect(getBatch(h.store.db, batch.id).worktreePath).toBeNull();
        expect(getAppSetting(h.store.db, `checkout_pin.${batch.id}`)).toBeUndefined();
        expect(branchExists(batch.branch ?? '')).toBe(false);
      },
    },
    {
      name: 'ABANDONED clean with its path set',
      check: async () => {
        const { batch, path } = await finished('ABANDONED');
        const report = await recover();
        expect(report.retired).toEqual([batch.id]);
        expect(getBatch(h.store.db, batch.id).worktreePath).toBeNull();
        expect(existsSync(path)).toBe(false);
      },
    },
    {
      name: 'ABANDONED dirty',
      check: async () => {
        const { batch, path } = await finished('ABANDONED');
        writeFileSync(join(path, 'README.md'), '# edited, not committed\n');
        const report = await recover();
        expect(report.retired).toEqual([]);
        expect(getBatch(h.store.db, batch.id).worktreePath).toBe(path);
        expect(existsSync(join(path, 'README.md'))).toBe(true);
        expect(h.only(h.cards()).title).toBe(
          `Batch "Alpha" abandoned: uncommitted changes kept in ${path}`,
        );
      },
    },
  ])('recovers $name', async ({ check }) => {
    await check();
    await h.jobs.idle();
    expectOnlyLiveWorktrees();
  });
});

describe('sweepWorktrees', () => {
  const sweep = () =>
    sweepWorktrees({
      state: h.state,
      git: h.git,
      inbox: h.inbox,
      root: h.worktreeRoot,
      logger: silentLogger,
    });

  /** A worktree on a new branch at `path`, made by hand, locked with `reason` when given. */
  function worktreeAt(path: string, reason?: string): string {
    mkdirSync(dirname(path), { recursive: true });
    const lock = reason === undefined ? [] : ['--lock', '--reason', reason];
    h.git$('worktree', 'add', '-q', ...lock, '-b', `hand/${mintId('Batch')}`, path);
    return path;
  }

  const under = (leaf: string): string => join(h.worktreeRoot, 'widgets-0a1b2c', leaf);
  const ours = (id: BatchId): string => `10db ${id}`;

  /** The batch id the entry at `path` is locked with, when it names one. */
  function lockedId(path: string): string | undefined {
    const reason = parseWorktreeList(gitIn(h.repo, 'worktree', 'list', '--porcelain', '-z')).find(
      (e) => comparable(e.path) === comparable(path),
    )?.locked;
    return reason?.startsWith('10db bat_') === true ? reason.slice('10db '.length) : undefined;
  }

  it.each<{
    name: string;
    entry: () => string;
    removed: boolean;
    /** Whether the pin stored under the lock's batch id survives the sweep. */
    pinKept: boolean;
  }>([
    {
      name: 'a 10db-locked orphan whose batch is gone',
      entry: () => worktreeAt(under('orphan'), ours(mintId('Batch'))),
      removed: true,
      pinKept: false,
    },
    {
      name: 'a 10db-locked orphan holding only ignored build output',
      entry: () => {
        const path = worktreeAt(under('built'), ours(mintId('Batch')));
        writeFileSync(join(h.repo, '.git', 'info', 'exclude'), 'dist/\n');
        mkdirSync(join(path, 'dist'));
        writeFileSync(join(path, 'dist', 'out.js'), 'built\n');
        return path;
      },
      removed: true,
      pinKept: false,
    },
    {
      name: 'a 10db-locked orphan holding only build info and caches the gate wrote',
      entry: () => {
        const path = worktreeAt(under('typechecked'), ours(mintId('Batch')));
        writeFileSync(join(h.repo, '.git', 'info', 'exclude'), '*.tsbuildinfo\n.eslintcache\n');
        writeFileSync(join(path, 'tsconfig.tsbuildinfo'), '{}\n');
        writeFileSync(join(path, '.eslintcache'), '[]\n');
        return path;
      },
      removed: true,
      pinKept: false,
    },
    {
      name: 'a 10db-locked orphan whose directory was deleted',
      entry: () => {
        const path = worktreeAt(under('deleted'), ours(mintId('Batch')));
        rmSync(path, { recursive: true, force: true });
        return path;
      },
      removed: true,
      pinKept: false,
    },
    {
      name: 'a 10db-locked entry whose path was cleared',
      entry: () => {
        const batch = h.state.write((c) =>
          insertBatch(c, { projectId: h.project.id, title: 'Gone', baseBranch: 'main' }),
        );
        return worktreeAt(under('cleared'), ours(batch.id));
      },
      removed: true,
      pinKept: false,
    },
    {
      // The pin is the live worktree's, at the batch's own path.
      name: "a 10db-locked entry at another path than its batch's",
      entry: () => {
        const batch = h.state.write((c) =>
          insertBatch(c, {
            projectId: h.project.id,
            title: 'Moved',
            baseBranch: 'main',
            worktreePath: under('elsewhere'),
          }),
        );
        return worktreeAt(under('moved'), ours(batch.id));
      },
      removed: true,
      pinKept: true,
    },
    {
      name: "a live batch's worktree",
      entry: () => {
        const path = under('live');
        const batch = h.state.write((c) =>
          insertBatch(c, {
            projectId: h.project.id,
            title: 'Live',
            baseBranch: 'main',
            worktreePath: path,
          }),
        );
        return worktreeAt(path, ours(batch.id));
      },
      removed: false,
      pinKept: true,
    },
    {
      name: 'an unlocked worktree under the root',
      entry: () => worktreeAt(under('unlocked')),
      removed: false,
      pinKept: true,
    },
    {
      name: "someone else's lock",
      entry: () => worktreeAt(under('mine'), 'mine'),
      removed: false,
      pinKept: true,
    },
    {
      name: 'outside the root',
      entry: () => worktreeAt(join(realpathSync(elsewhere.path), 'x'), ours(mintId('Batch'))),
      removed: false,
      pinKept: true,
    },
    {
      name: "under another data dir's level",
      entry: () => worktreeAt(join(dirname(h.worktreeRoot), 'other', 'x'), ours(mintId('Batch'))),
      removed: false,
      pinKept: true,
    },
  ])('$name: removed $removed', async ({ entry, removed, pinKept }) => {
    mkdirSync(h.worktreeRoot, { recursive: true });
    const path = entry();
    const id = lockedId(path);
    if (id !== undefined)
      h.state.write((c) => {
        setAppSetting(c, `checkout_pin.${id}`, { kept: true });
      });
    const swept = await sweep();
    expect(swept.map(comparable)).toEqual(removed ? [comparable(path)] : []);
    expect(listed().includes(comparable(path))).toBe(!removed);
    if (removed) expect(existsSync(path)).toBe(false);
    if (id !== undefined)
      expect(getAppSetting(h.store.db, `checkout_pin.${id}`) !== undefined).toBe(pinKept);
    expect(h.cards()).toEqual([]);
  });

  it.each<{
    name: string;
    change: (path: string) => void;
    shown: string;
    /** Text the card leaves out: what the removal command may take without asking. */
    hidden?: string;
    why: string;
  }>([
    {
      name: 'an edited file',
      change: (path) => {
        writeFileSync(join(path, 'README.md'), '# edited, not committed\n');
      },
      shown: '- README.md',
      why: 'it has uncommitted changes',
    },
    {
      name: 'an untracked file',
      change: (path) => {
        writeFileSync(join(path, 'notes.txt'), 'mine\n');
      },
      shown: '- notes.txt',
      why: 'it has uncommitted changes',
    },
    {
      name: 'a git-ignored file 10db did not seed',
      change: (path) => {
        writeFileSync(join(h.repo, '.git', 'info', 'exclude'), '.env\n');
        writeFileSync(join(path, '.env'), 'mine\n');
      },
      shown: '- .env',
      why: 'it holds git-ignored files',
    },
    {
      name: 'a git-ignored file beside build info',
      change: (path) => {
        writeFileSync(join(h.repo, '.git', 'info', 'exclude'), '.env\n*.tsbuildinfo\n');
        writeFileSync(join(path, '.env'), 'mine\n');
        writeFileSync(join(path, 'tsconfig.tsbuildinfo'), '{}\n');
      },
      shown: '- .env',
      hidden: 'tsbuildinfo',
      why: 'it holds git-ignored files',
    },
    {
      name: 'an untracked file beside a git-ignored one',
      change: (path) => {
        writeFileSync(join(h.repo, '.git', 'info', 'exclude'), '.env\n');
        writeFileSync(join(path, '.env'), 'mine\n');
        writeFileSync(join(path, 'notes.txt'), 'mine\n');
      },
      shown: '- .env',
      why: 'it has uncommitted changes',
    },
    {
      name: 'an untracked file beside build info',
      change: (path) => {
        writeFileSync(join(h.repo, '.git', 'info', 'exclude'), '*.tsbuildinfo\n');
        writeFileSync(join(path, 'tsconfig.tsbuildinfo'), '{}\n');
        writeFileSync(join(path, 'notes.txt'), 'mine\n');
      },
      shown: '- tsconfig.tsbuildinfo',
      why: 'it has uncommitted changes',
    },
    {
      name: 'a git file git cannot read',
      change: (path) => {
        writeFileSync(join(path, '.git'), 'not a gitfile\n');
      },
      shown: "10db couldn't read",
      why: "it can't be read",
    },
  ])('keeps an orphan with $name and names it once', async ({ change, shown, hidden, why }) => {
    mkdirSync(h.worktreeRoot, { recursive: true });
    const path = worktreeAt(under('dirty'), ours(mintId('Batch')));
    change(path);
    expect(await sweep()).toEqual([]);
    expect(await sweep()).toEqual([]);
    expect(listed()).toContain(comparable(path));
    expect(existsSync(path)).toBe(true);
    const card = h.only(h.cards());
    expect(card.title).toBe(`10db kept ${path}: ${why}`);
    expect(card.body).toContain(shown);
    if (hidden !== undefined) expect(card.body).not.toContain(hidden);
    expect(card.body).toContain(`git -C '${h.repo}' worktree remove --force --force '${path}'`);
  });

  it.each<{ name: string; file: string }>([
    { name: 'git-ignored files', file: '.env' },
    { name: 'uncommitted changes', file: 'notes.txt' },
  ])(
    'withdraws the card for an orphan kept for $name once a sweep removes it',
    async ({ file }) => {
      mkdirSync(h.worktreeRoot, { recursive: true });
      const path = worktreeAt(under('kept'), ours(mintId('Batch')));
      writeFileSync(join(h.repo, '.git', 'info', 'exclude'), '.env\n');
      writeFileSync(join(path, file), 'mine\n');
      expect(await sweep()).toEqual([]);
      h.only(h.cards());

      rmSync(join(path, file));
      expect((await sweep()).map(comparable)).toEqual([comparable(path)]);

      expect(h.cards()).toEqual([]);
    },
  );

  it('names a path that is not paste-safe as a code span, not a command', async () => {
    mkdirSync(h.worktreeRoot, { recursive: true });
    const path = worktreeAt(under("it's mine"), ours(mintId('Batch')));
    writeFileSync(join(path, 'notes.txt'), 'mine\n');
    await sweep();
    const card = h.only(h.cards());
    expect(card.body).toContain(`run in \`${h.repo}\`, naming \`${path}\``);
    expect(card.body).not.toContain(`git -C '`);
  });

  it("sweeps the other projects when one project's checkout is not a repository", async () => {
    // Projects are swept in name order: this one comes first.
    seedProject(h.store, {
      name: 'aaa-broken',
      repoPath: realpathSync(elsewhere.path),
      delivery: 'pull_request',
      prTitlePrefix: 'feat(app)',
    });
    mkdirSync(h.worktreeRoot, { recursive: true });
    const orphan = worktreeAt(under('orphan'), ours(mintId('Batch')));
    expect((await sweep()).map(comparable)).toEqual([comparable(orphan)]);
    expect(existsSync(orphan)).toBe(false);
  });

  it('drops the kept start of a task no live worktree batch holds, and keeps the rest', async () => {
    const live = h.starter.startTask(h.addTask('Live').id);
    const done = h.starter.startTask(h.addTask('Done', { areas: ['ui'] }).id);
    await h.jobs.idle();
    const member = (id: BatchId) => h.only(listWorkstreams(h.store.db, { batchId: id })).id;
    h.state.write((c) => {
      transitionBatch(c, done.id, { to: 'SHIPPING' });
      transitionBatch(c, done.id, { to: 'CLOSED' });
      clearWorktreePath(c, done.id);
    });
    // This daemon's starts live under its own level; another daemon's, such as a dev daemon with its
    // own data dir on the same repository, are not this sweep's to judge.
    const mine = (id: string) => `refs/10db/${basename(h.worktreeRoot)}/starts/${id}`;
    const theirs = `refs/10db/0a1b2c3d/starts/${mintId('Workstream')}`;
    for (const id of [member(live.id), member(done.id), mintId('Workstream')])
      h.git$('update-ref', mine(id), 'HEAD');
    h.git$('update-ref', theirs, 'HEAD');
    await sweep();
    expect(h.git$('for-each-ref', '--format=%(refname)', 'refs/10db/').split('\n').sort()).toEqual(
      [theirs, mine(member(live.id))].sort(),
    );
  });

  it('prunes after removing', async () => {
    mkdirSync(h.worktreeRoot, { recursive: true });
    const orphan = worktreeAt(under('orphan'), ours(mintId('Batch')));
    const stale = worktreeAt(join(realpathSync(elsewhere.path), 'stale'));
    rmSync(stale, { recursive: true, force: true });
    expect(listed()).toContain(comparable(stale));
    await sweep();
    expect(listed()).toEqual([realpathSync(h.repo)]);
    expect(existsSync(orphan)).toBe(false);
  });

  it('sweeps nothing when the root was never made', async () => {
    expect(await sweep()).toEqual([]);
  });
});
