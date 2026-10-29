import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import type { BatchDto, WorkstreamDto } from '@10db/contracts';
import {
  getAppSetting,
  getBatch,
  getWorkstream,
  listInbox,
  listWorkstreams,
  patchProject,
  setAppSetting,
  transitionBatch,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { isolatedGitEnv } from '../../test/fixtures';
import { createGit, parseWorktreeList, type GitTrustError } from '../git';
import { createInboxService } from '../inbox';
import { retryWorkstream } from '../team';
import {
  batchCardFields,
  createBatchCardAnswers,
  ensureWorktreeWhole,
  retireWorktree,
  type DeliveryContext,
} from './index';
import { baseCards } from './cards';
import { raise } from './context';

let h: DeliveryHarness;
/** Where the gate writes the directory it ran in. */
let gateOut: string;
beforeEach(() => {
  // The tests settle work and move batches by hand, then ask the shipper themselves.
  h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
  gateOut = join(h.dataDir, 'gate-ran-in');
  gate('true');
});
afterEach(() => {
  h.close();
});

/** The project's gate: `check`, then the directory it ran in, written to `gateOut`. */
function gate(check: string): void {
  h.state.write((c) =>
    patchProject(c, h.project.id, { gateCommand: `${check} && pwd -P > '${gateOut}'` }),
  );
}

/** git in a directory, as a builder's terminal would run it. */
function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();
}

/** Every worktree git lists for the main checkout, as real paths, the main checkout first. */
function worktreePaths(): string[] {
  return parseWorktreeList(
    execFileSync('git', ['-C', h.repo, 'worktree', 'list', '--porcelain', '-z'], {
      env: isolatedGitEnv(),
      stdio: 'pipe',
    }).toString(),
  ).map((e) => (existsSync(e.path) ? realpathSync(e.path) : e.path));
}

function pathOf(batch: BatchDto): string {
  if (batch.worktreePath === null) throw new Error(`batch ${batch.title} has no worktree path`);
  return batch.worktreePath;
}

/** The SHA of `branch` on origin, or null when origin doesn't have it. */
function onOrigin(branch: string | null): string | null {
  try {
    return h.origin$('rev-parse', '--verify', '-q', `refs/heads/${branch ?? ''}`);
  } catch {
    return null;
  }
}

/** Starts one task and waits for its worktree. */
async function opened(title = 'Alpha'): Promise<{ batch: BatchDto; ws: WorkstreamDto }> {
  const started = h.starter.startTask(h.addTask(title).id);
  await h.jobs.idle();
  const batch = getBatch(h.store.db, started.id);
  expect(batch.state).toBe('OPEN');
  return { batch, ws: h.only(listWorkstreams(h.store.db, { batchId: batch.id })) };
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

/** A batch whose work finished and whose gate failed: what Retry starts from. */
async function failedAfterWork(): Promise<{ batch: BatchDto; ws: WorkstreamDto; head: string }> {
  const { batch, ws } = await opened();
  const head = await commitIn(batch, 'src/api/alpha.txt');
  h.settle(ws.id, 'DONE');
  h.state.write((c) =>
    transitionBatch(c, batch.id, { to: 'FAILED', patch: { failure: 'gate_failed' } }),
  );
  return { batch, ws, head };
}

/**
 * The delivery context with a git that holds no pins, as a daemon that lost a worktree's pin would
 * run: every read of a worktree under the root is refused as unpinned.
 */
function unpinned(): { ctx: DeliveryContext; refusals: GitTrustError[] } {
  const refusals: GitTrustError[] = [];
  const git = createGit({
    worktreeRoot: h.worktreeRoot,
    onRefused: (error) => refusals.push(error),
  });
  return { ctx: { ...h.ctx, git }, refusals };
}

/** What the builder sees of the main checkout. */
function mainCheckout() {
  return {
    head: h.git$('rev-parse', 'HEAD'),
    branch: h.git$('branch', '--show-current'),
    index: h.git$('ls-files', '-s'),
    status: h.git$('status', '--porcelain', '--untracked-files=all'),
    readme: readFileSync(join(h.repo, 'README.md'), 'utf8'),
  };
}

describe('shipping a worktree batch', () => {
  it('ships a worktree batch: gate in its worktree, its branch pushed, one PR titled after the task, the worktree removed and the main checkout untouched', async () => {
    // A lowercase title, so the PR title shows it unchanged after the prefix.
    const { batch, ws } = await opened('add the alpha widget');
    const wt = pathOf(batch);
    const head = await commitIn(batch, 'src/api/alpha.txt');
    h.state.write((c) => {
      setAppSetting(c, `checkout_pin.${batch.id}`, { kept: true });
      setAppSetting(c, `worktree_lockfile.${batch.id}`, 'a lockfile blob');
    });
    // The builder works on in the main checkout meanwhile: another branch, edits not committed.
    h.git$('switch', '-q', '-c', 'mine');
    writeFileSync(join(h.repo, 'README.md'), '# edited, not committed\n');
    writeFileSync(join(h.repo, 'scratch.txt'), 'untracked\n');
    const before = mainCheckout();

    h.settle(ws.id, 'DONE');
    h.shipper.checkBatch(batch.id);
    await h.jobs.idle();

    const shipped = getBatch(h.store.db, batch.id);
    expect(shipped.state).toBe('SHIPPED');
    expect(readFileSync(gateOut, 'utf8').trim()).toBe(wt);
    expect(onOrigin(batch.branch)).toBe(head);
    expect(h.gh.prCreates()).toMatchObject([
      { title: 'feat(app): add the alpha widget', head: batch.branch },
    ]);
    expect(shipped.worktreePath).toBeNull();
    expect(worktreePaths()).toEqual([realpathSync(h.repo)]);
    expect(existsSync(wt)).toBe(false);
    expect(getAppSetting(h.store.db, `checkout_pin.${batch.id}`)).toBeUndefined();
    expect(getAppSetting(h.store.db, `worktree_lockfile.${batch.id}`)).toBeUndefined();
    expect(h.git$('branch', '--list', batch.branch ?? '')).toContain(batch.branch ?? '');
    expect(mainCheckout()).toEqual(before);
    expect(h.cards()).toEqual([]);
  });

  it("drops its tasks' kept starts on the merged base when the batch's worktree goes", async () => {
    const { batch, ws } = await opened('Alpha');
    h.git$('update-ref', `refs/10db/${basename(h.worktreeRoot)}/starts/${ws.id}`, 'HEAD');
    h.settle(ws.id, 'DONE');
    h.shipper.checkBatch(batch.id);
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id)).toMatchObject({ state: 'CLOSED', worktreePath: null });
    expect(h.git$('for-each-ref', '--format=%(refname)', 'refs/10db/')).toBe('');
  });

  it('closes a worktree batch with no commits, removes the worktree and deletes its branch at the base', async () => {
    const { batch, ws } = await opened('Alpha');
    h.settle(ws.id, 'DONE');
    h.shipper.checkBatch(batch.id);
    await h.jobs.idle();
    const closed = getBatch(h.store.db, batch.id);
    expect(closed.state).toBe('CLOSED');
    expect(closed.worktreePath).toBeNull();
    expect(worktreePaths()).toEqual([realpathSync(h.repo)]);
    expect(h.git$('branch', '--list', batch.branch ?? '')).toBe('');
    expect(h.gh.prCreates()).toEqual([]);
  });

  it("keeps a CLOSED batch's branch that moved", async () => {
    const { batch } = await opened('Alpha');
    const moved = await commitIn(batch, 'src/api/late.txt');
    h.state.write((c) => {
      transitionBatch(c, batch.id, { to: 'SHIPPING' });
      transitionBatch(c, batch.id, { to: 'CLOSED' });
    });
    await retireWorktree(h.ctx, batch.id);
    expect(getBatch(h.store.db, batch.id).worktreePath).toBeNull();
    expect(worktreePaths()).toEqual([realpathSync(h.repo)]);
    expect(h.git$('rev-parse', `refs/heads/${batch.branch ?? ''}`)).toBe(moved);
    // Safe to repeat once cleared.
    await retireWorktree(h.ctx, batch.id);
    expect(h.git$('rev-parse', `refs/heads/${batch.branch ?? ''}`)).toBe(moved);
  });

  it("fails with the worktree's path when it has uncommitted changes", async () => {
    const { batch, ws } = await opened('Alpha');
    const wt = pathOf(batch);
    await commitIn(batch, 'src/api/alpha.txt');
    writeFileSync(join(wt, 'src', 'api', 'stray.txt'), 'not committed\n');
    h.settle(ws.id, 'DONE');
    h.shipper.checkBatch(batch.id);
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id)).toMatchObject({
      state: 'FAILED',
      failure: 'dirty_checkout',
      worktreePath: wt,
    });
    const card = h.only(h.cards());
    expect(card.body).toContain(wt);
    expect(card.body).toContain('src/api/stray.txt');
    expect(existsSync(join(wt, 'src', 'api', 'stray.txt'))).toBe(true);
    expect(onOrigin(batch.branch)).toBeNull();
  });
});

describe("the base, brought into a worktree batch's branch before the shipping gate", () => {
  /** Ships one finished task's batch and waits for the ship to settle. */
  async function ship(batch: BatchDto, ws: WorkstreamDto): Promise<BatchDto> {
    h.settle(ws.id, 'DONE');
    h.shipper.checkBatch(batch.id);
    await h.jobs.idle();
    return getBatch(h.store.db, batch.id);
  }

  it("gates and pushes the branch merged with main as origin has it now, and reads the PR's base from it", async () => {
    const { batch, ws } = await opened();
    const head = await commitIn(batch, 'src/api/alpha.txt');
    const teammate = h.teammatePush('main', 'src/ui/teammate.txt');
    // Passes only where main's newer commit is in the worktree.
    gate('test -f src/ui/teammate.txt');

    const shipped = await ship(batch, ws);

    expect(shipped.state).toBe('SHIPPED');
    expect(shipped.baseSha).toBe(teammate);
    const tip = onOrigin(batch.branch) ?? '';
    expect(h.origin$('log', '-1', '--format=%P', tip)).toBe(`${head} ${teammate}`);
    expect(h.origin$('ls-tree', '-r', '--name-only', tip).split('\n')).toEqual(
      expect.arrayContaining(['src/api/alpha.txt', 'src/ui/teammate.txt']),
    );
    expect(h.gh.prCreates()).toHaveLength(1);
    expect(h.cards()).toEqual([]);
  });

  it('ships the branch as it is when it conflicts with main; its conflict card goes with the worktree', async () => {
    const { batch, ws } = await opened();
    const head = await commitIn(batch, 'README.md');
    h.teammatePush('main', 'README.md', '# theirs\n');

    const shipped = await ship(batch, ws);

    expect(shipped.state).toBe('SHIPPED');
    expect(onOrigin(batch.branch)).toBe(head);
    // Raised by the shipping gate, then withdrawn with the worktree: the pull request shows it now.
    const card = h.only(
      listInbox(h.store.db, {}).filter(
        (i) => i.title === `Batch "${batch.title}" conflicts with main`,
      ),
    );
    expect(card.state).toBe('CANCELLED');
    expect(h.cards()).toEqual([]);
  });

  it("withdraws the batch's base cards when its worktree goes", async () => {
    const { batch, ws } = await opened();
    const path = pathOf(batch);
    raise(h.inbox, h.project.id, baseCards.conflict(batch, path, ['README.md']));
    raise(h.inbox, h.project.id, baseCards.kept(batch, path, ['build/']));
    expect(h.cards()).toHaveLength(2);
    h.settle(ws.id, 'DONE');
    h.shipper.checkBatch(batch.id);
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id)).toMatchObject({ state: 'CLOSED', worktreePath: null });
    expect(h.cards()).toEqual([]);
  });

  it('names what kept main out in the card of a shipping gate that failed', async () => {
    const { batch, ws } = await opened();
    await commitIn(batch, 'README.md');
    h.teammatePush('main', 'README.md', '# theirs\n');
    gate('false');

    const failed = await ship(batch, ws);

    expect(failed.state).toBe('FAILED');
    const card = h.cards().find((c) => c.title.includes('the gate failed'));
    expect(card?.body).toMatch(/^origin\/main conflicts with this branch in README\.md/);
    expect(onOrigin(batch.branch)).toBeNull();
  });

  it('merges nothing for a project with no gate: the builder checked the work as it is', async () => {
    h.state.write((c) => patchProject(c, h.project.id, { gateCommand: null }));
    const { batch, ws } = await opened();
    const head = await commitIn(batch, 'src/api/alpha.txt');
    h.teammatePush('main', 'src/ui/teammate.txt');

    const shipped = await ship(batch, ws);

    expect(shipped.state).toBe('SHIPPED');
    expect(onOrigin(batch.branch)).toBe(head);
  });
});

describe('Retry of a FAILED worktree batch', () => {
  beforeEach(() => {
    // An ignored node_modules the seed copies into every new worktree.
    h.commit('.gitignore', 'node_modules/\n');
    h.git$('push', '-q', 'origin', 'main');
    mkdirSync(join(h.repo, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(h.repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  });

  it.each<{
    name: string;
    /** What the builder or a crash did to the worktree; returns the gate's extra check. */
    before: (wt: string, gitDir: string) => string;
    shipped: boolean;
  }>([
    {
      name: 'keeps a whole worktree',
      before: (_wt, gitDir) => {
        writeFileSync(join(gitDir, '10db-test-kept'), '');
        return `test -f '${join(gitDir, '10db-test-kept')}'`;
      },
      shipped: true,
    },
    {
      name: 'rebuilds a missing worktree from the branch',
      before: (wt) => {
        rmSync(wt, { recursive: true, force: true });
        return 'test -f node_modules/pkg/index.js';
      },
      shipped: true,
    },
    {
      name: 'rebuilds a half-made worktree',
      before: (_wt, gitDir) => {
        rmSync(join(gitDir, 'index'));
        return 'test -f src/api/alpha.txt';
      },
      shipped: true,
    },
    {
      name: 'rebuilds a clean worktree on another branch',
      before: (wt) => {
        gitIn(wt, 'switch', '-q', '-c', 'other');
        return 'test -f src/api/alpha.txt';
      },
      shipped: true,
    },
    {
      name: 'refuses a worktree on another branch with changes',
      before: (wt) => {
        gitIn(wt, 'switch', '-q', '-c', 'other');
        writeFileSync(join(wt, 'README.md'), '# the builder was here\n');
        return 'true';
      },
      shipped: false,
    },
  ])('$name', async ({ before, shipped }) => {
    const { batch, head } = await failedAfterWork();
    const wt = pathOf(batch);
    gate(before(wt, gitIn(wt, 'rev-parse', '--absolute-git-dir')));

    h.shipper.ship(batch.id);
    await h.jobs.idle();

    const now = getBatch(h.store.db, batch.id);
    if (shipped) {
      expect(now.state).toBe('SHIPPED');
      expect(readFileSync(gateOut, 'utf8').trim()).toBe(wt);
      expect(onOrigin(batch.branch)).toBe(head);
      expect(h.gh.prCreates()).toHaveLength(1);
      expect(now.worktreePath).toBeNull();
      expect(worktreePaths()).toEqual([realpathSync(h.repo)]);
      return;
    }
    expect(now).toMatchObject({ state: 'FAILED', failure: 'wrong_branch', worktreePath: wt });
    expect(h.only(h.cards()).body).toContain(wt);
    expect(readFileSync(join(wt, 'README.md'), 'utf8')).toBe('# the builder was here\n');
    expect(gitIn(wt, 'branch', '--show-current')).toBe('other');
    expect(onOrigin(batch.branch)).toBeNull();
    expect(h.gh.prCreates()).toEqual([]);
  });

  it('refuses a directory git does not list at the worktree path, naming it, and leaves it', async () => {
    const { batch } = await failedAfterWork();
    const wt = pathOf(batch);
    h.git$('worktree', 'remove', '--force', '--force', wt);
    mkdirSync(wt);
    writeFileSync(join(wt, 'mine.txt'), 'the builder put this here\n');

    h.shipper.ship(batch.id);
    await h.jobs.idle();

    expect(getBatch(h.store.db, batch.id)).toMatchObject({ state: 'FAILED', worktreePath: wt });
    const card = h.only(h.cards());
    expect(card.title).toContain(`${wt} is in the way`);
    expect(card.body).toContain('git lists no worktree there');
    expect(card.body).toContain('press Retry');
    expect(readFileSync(join(wt, 'mine.txt'), 'utf8')).toBe('the builder put this here\n');
    expect(h.gh.prCreates()).toEqual([]);
  });

  it('makes one worktree whole once when two repairs of the batch run at once', async () => {
    const { batch } = await failedAfterWork();
    const wt = pathOf(batch);
    rmSync(wt, { recursive: true, force: true });
    const signal = new AbortController().signal;
    const outcomes = await Promise.all([
      ensureWorktreeWhole(h.ctx, batch, signal),
      ensureWorktreeWhole(h.ctx, batch, signal),
    ]);
    expect(outcomes.sort()).toEqual(['replaced', 'whole']);
    expect(gitIn(wt, 'branch', '--show-current')).toBe(batch.branch);
    expect(worktreePaths()).toEqual([realpathSync(h.repo), wt]);
  });

  it('refuses a replaced worktree whose dependency install fails, removing it and naming the cause', async () => {
    h.commit('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    h.git$('push', '-q', 'origin', 'main');
    const { batch } = await failedAfterWork();
    const wt = pathOf(batch);
    // The seed needs a node_modules to refresh.
    writeFileSync(join(h.repo, '.gitignore'), 'node_modules/\n');
    mkdirSync(join(h.repo, 'node_modules'), { recursive: true });
    rmSync(wt, { recursive: true, force: true });
    h.pnpm.failWith(1, 'ERR_PNPM_META_FETCH_FAIL');

    const outcome = await ensureWorktreeWhole(h.ctx, batch, new AbortController().signal);

    expect(outcome).toBe('refused');
    expect(h.only(h.cards()).body).toContain('ERR_PNPM_META_FETCH_FAIL');
    expect(existsSync(wt)).toBe(false);
    expect(worktreePaths()).toEqual([realpathSync(h.repo)]);
  });

  it('refuses, and removes nothing, when git no longer trusts the worktree', async () => {
    const { batch } = await failedAfterWork();
    const wt = pathOf(batch);
    gitIn(wt, 'switch', '-q', '-c', 'other');
    writeFileSync(join(wt, 'README.md'), '# the builder was here\n');
    const { ctx, refusals } = unpinned();

    expect(await ensureWorktreeWhole(ctx, batch, new AbortController().signal)).toBe('refused');

    expect(refusals.map((r) => r.detail.kind)).toEqual(['unpinned']);
    expect(worktreePaths()).toEqual([realpathSync(h.repo), wt]);
    expect(readFileSync(join(wt, 'README.md'), 'utf8')).toBe('# the builder was here\n');
    expect(h.cards()).toEqual([]);
  });

  it('Retry with unfinished work reopens only after the worktree is whole', async () => {
    const { batch, ws } = await opened();
    const wt = pathOf(batch);
    h.state.write((c) =>
      transitionBatch(c, batch.id, { to: 'FAILED', patch: { failure: 'wrong_branch' } }),
    );
    rmSync(wt, { recursive: true, force: true });
    const ticks = h.ticks.count;

    expect(h.shipper.ship(batch.id).state).toBe('FAILED');
    await h.jobs.idle();

    expect(getBatch(h.store.db, batch.id)).toMatchObject({ state: 'OPEN', failure: null });
    expect(gitIn(wt, 'branch', '--show-current')).toBe(batch.branch);
    expect(readFileSync(join(wt, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe(
      'module.exports = 1;\n',
    );
    expect(getWorkstream(h.store.db, ws.id).state).toBe('QUEUED');
    expect(h.ticks.count).toBeGreaterThan(ticks);
    expect(h.cards()).toEqual([]);
  });

  it('a fix task joins a FAILED worktree batch and reopens it after making its worktree whole', async () => {
    const { batch, ws } = await failedAfterWork();
    const wt = pathOf(batch);
    rmSync(wt, { recursive: true, force: true });
    const fix = h.addTask('Fix', { areas: ['ui'] });

    const answered = h.starter.startBatch(h.project.id, {
      title: 'Fix',
      taskIds: [fix.id],
      batchId: batch.id,
    });
    expect(answered.map((b) => [b.id, b.state])).toEqual([[batch.id, 'FAILED']]);
    await h.jobs.idle();

    expect(getBatch(h.store.db, batch.id)).toMatchObject({ state: 'OPEN', failure: null });
    expect(listWorkstreams(h.store.db, { batchId: batch.id }).map((w) => w.taskId)).toEqual([
      ws.taskId,
      fix.id,
    ]);
    expect(gitIn(wt, 'branch', '--show-current')).toBe(batch.branch);
    expect(existsSync(join(wt, 'src', 'api', 'alpha.txt'))).toBe(true);
    expect(h.cards()).toEqual([]);
  });

  it('a workstream Retry in a FAILED worktree batch reopens it through the cut queue', async () => {
    const { batch, ws } = await opened();
    const wt = pathOf(batch);
    h.settle(ws.id, 'FAILED');
    h.state.write((c) =>
      transitionBatch(c, batch.id, { to: 'FAILED', patch: { failure: 'gate_failed' } }),
    );
    rmSync(wt, { recursive: true, force: true });
    const inbox = createInboxService({
      state: h.state,
      onParkedAnswer: () => undefined,
      onFlagAnswer: createBatchCardAnswers({
        // As the composition root builds it.
        retry: (id) => {
          const retried = retryWorkstream(h.state, id);
          if (retried.batchId !== null) h.starter.reopen(retried.batchId);
        },
        shipper: h.shipper,
      }),
    });
    const fields = batchCardFields({ id: ws.id, batchId: batch.id });
    if (!fields) throw new Error('a batch member gets card actions');
    const card = inbox.flag({
      projectId: h.project.id,
      workstreamId: ws.id,
      title: 'Workstream failed: Alpha',
      body: 'The gate failed',
      ...fields,
    });

    inbox.answer(card.id, { choice: 'Retry' });
    expect(getWorkstream(h.store.db, ws.id).state).toBe('QUEUED');
    expect(getBatch(h.store.db, batch.id).state).toBe('FAILED');
    await h.jobs.idle();

    expect(getBatch(h.store.db, batch.id)).toMatchObject({ state: 'OPEN', failure: null });
    expect(gitIn(wt, 'branch', '--show-current')).toBe(batch.branch);
  });
});

describe('Abandon of a worktree batch', () => {
  it('removes a clean worktree and clears its path', async () => {
    const { batch } = await opened();
    const wt = pathOf(batch);
    await commitIn(batch, 'src/api/alpha.txt');
    expect(h.shipper.abandon(batch.id).state).toBe('ABANDONED');
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id).worktreePath).toBeNull();
    expect(existsSync(wt)).toBe(false);
    expect(worktreePaths()).toEqual([realpathSync(h.repo)]);
    expect(h.git$('branch', '--list', batch.branch ?? '')).toContain(batch.branch ?? '');
    expect(h.only(h.cards()).title).toBe('Batch "Alpha" abandoned');
  });

  it('keeps a dirty worktree, keeps its path and names it with --force --force', async () => {
    const { batch } = await opened();
    const wt = pathOf(batch);
    writeFileSync(join(wt, 'notes.txt'), 'not committed\n');
    h.shipper.abandon(batch.id);
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id)).toMatchObject({
      state: 'ABANDONED',
      worktreePath: wt,
    });
    expect(readFileSync(join(wt, 'notes.txt'), 'utf8')).toBe('not committed\n');
    expect(worktreePaths()).toEqual([realpathSync(h.repo), wt]);
    const kept = h.cards().find((c) => c.title.includes('uncommitted changes kept'));
    expect(kept?.body).toContain('notes.txt');
    expect(kept?.body).toContain(`git -C '${h.repo}' worktree remove --force --force '${wt}'`);
  });

  it('retireWorktree itself keeps an ABANDONED worktree with uncommitted changes', async () => {
    const { batch } = await opened();
    const wt = pathOf(batch);
    writeFileSync(join(wt, 'notes.txt'), 'not committed\n');
    h.state.write((c) => transitionBatch(c, batch.id, { to: 'ABANDONED' }));

    expect(await retireWorktree(h.ctx, batch.id)).toEqual({
      kind: 'kept',
      reason: 'changes',
      paths: ['notes.txt'],
    });

    expect(getBatch(h.store.db, batch.id).worktreePath).toBe(wt);
    expect(worktreePaths()).toEqual([realpathSync(h.repo), wt]);
    expect(readFileSync(join(wt, 'notes.txt'), 'utf8')).toBe('not committed\n');
  });

  it('keeps a clean worktree git no longer trusts, and removes nothing', async () => {
    const { batch } = await opened();
    const wt = pathOf(batch);
    h.state.write((c) => transitionBatch(c, batch.id, { to: 'ABANDONED' }));
    const { ctx, refusals } = unpinned();

    await retireWorktree(ctx, batch.id);

    expect(refusals.map((r) => r.detail.kind)).toEqual(['unpinned']);
    expect(getBatch(h.store.db, batch.id).worktreePath).toBe(wt);
    expect(worktreePaths()).toEqual([realpathSync(h.repo), wt]);
    expect(existsSync(join(wt, 'README.md'))).toBe(true);
  });
});

describe('a finished worktree with git-ignored files', () => {
  /** Ignores these patterns in every worktree of the repository, with nothing to commit. */
  const ignore = (...patterns: string[]) => {
    writeFileSync(join(h.repo, '.git', 'info', 'exclude'), `${patterns.join('\n')}\n`);
  };
  const write = (dir: string, files: readonly string[]) => {
    for (const file of files) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), 'local\n');
    }
  };
  const keptTitle = (batch: BatchDto) =>
    `10db kept the worktree of "${batch.title}": it holds git-ignored files`;

  it.each<{
    name: string;
    to: 'CLOSED' | 'ABANDONED';
    patterns?: string[];
    /** Files committed in the worktree before the loose ones are written. */
    tracked?: string[];
    files: string[];
    /** The files the card lists; null when the worktree goes. */
    kept: string[] | null;
  }>([
    { name: 'a hand-made .env', to: 'CLOSED', files: ['.env'], kept: ['.env'] },
    {
      name: 'a local file in a directory git does not track',
      to: 'ABANDONED',
      files: ['apps/web/.env.local'],
      kept: ['apps/web/.env.local'],
    },
    {
      name: 'only build output in an ignored directory',
      to: 'CLOSED',
      files: ['dist/out.js'],
      kept: null,
    },
    { name: "only Finder's .DS_Store", to: 'CLOSED', files: ['src/.DS_Store'], kept: null },
    {
      name: 'only the seeded node_modules',
      to: 'ABANDONED',
      files: ['node_modules/x/i.js'],
      kept: null,
    },
    {
      name: 'files of the seeded node_modules ignored one by one',
      to: 'CLOSED',
      patterns: ['*.js'],
      files: ['node_modules/x/i.js'],
      kept: null,
    },
    {
      name: "only the gate's typecheck build info",
      to: 'CLOSED',
      patterns: ['*.tsbuildinfo'],
      files: ['tsconfig.tsbuildinfo', 'apps/web/tsconfig.tsbuildinfo'],
      kept: null,
    },
    {
      name: "only a commit hook's eslint cache",
      to: 'ABANDONED',
      patterns: ['.eslintcache'],
      files: ['.eslintcache'],
      kept: null,
    },
    {
      name: 'a file in an output directory ignored file by file',
      to: 'CLOSED',
      patterns: ['*.js'],
      files: ['dist/out.js'],
      kept: ['dist/out.js'],
    },
    {
      name: 'a local env file in a tracked directory named like build output',
      to: 'CLOSED',
      patterns: ['.env*'],
      tracked: ['packages/coverage/index.ts'],
      files: ['packages/coverage/.env.local'],
      kept: ['packages/coverage/.env.local'],
    },
    {
      name: 'a hand-made .env beside build output',
      to: 'CLOSED',
      patterns: ['.env', '*.tsbuildinfo', '.eslintcache'],
      files: ['.env', 'tsconfig.tsbuildinfo', '.eslintcache'],
      kept: ['.env'],
    },
    {
      name: 'a log outside any build-output directory',
      to: 'CLOSED',
      patterns: ['*.log'],
      files: ['debug.log'],
      kept: ['debug.log'],
    },
  ])('$name: kept $kept', async ({ to, patterns, tracked, files, kept }) => {
    ignore(...(patterns ?? ['.env', '.env.*', '.DS_Store', 'dist/', 'node_modules/']));
    const { batch } = await opened();
    const wt = pathOf(batch);
    for (const file of tracked ?? []) await commitIn(batch, file);
    write(wt, files);
    h.state.write((c) => {
      if (to === 'CLOSED') transitionBatch(c, batch.id, { to: 'SHIPPING' });
      transitionBatch(c, batch.id, { to });
    });

    const outcome = await retireWorktree(h.ctx, batch.id);

    if (kept === null) {
      expect(outcome).toEqual({ kind: 'retired' });
      expect(getBatch(h.store.db, batch.id).worktreePath).toBeNull();
      expect(worktreePaths()).toEqual([realpathSync(h.repo)]);
      expect(h.cards()).toEqual([]);
      return;
    }
    expect(outcome).toEqual({ kind: 'kept', reason: 'ignored', paths: kept });
    expect(getBatch(h.store.db, batch.id).worktreePath).toBe(wt);
    expect(worktreePaths()).toEqual([realpathSync(h.repo), wt]);
    for (const file of files) expect(readFileSync(join(wt, file), 'utf8')).toBe('local\n');
    const card = h.only(h.cards());
    expect(card.title).toBe(keptTitle(batch));
    for (const file of files)
      if (kept.includes(file)) expect(card.body).toContain(`- ${file}`);
      else expect(card.body).not.toContain(file);
    expect(card.body).toContain(`git -C '${h.repo}' worktree remove --force --force '${wt}'`);
  });

  it("keeps a shipped batch's worktree that holds a .env, and raises one card however often it retires", async () => {
    ignore('.env');
    const { batch, ws } = await opened();
    const wt = pathOf(batch);
    await commitIn(batch, 'src/api/alpha.txt');
    write(wt, ['.env']);
    h.settle(ws.id, 'DONE');
    h.shipper.checkBatch(batch.id);
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id)).toMatchObject({ state: 'SHIPPED', worktreePath: wt });
    await retireWorktree(h.ctx, batch.id);
    expect(worktreePaths()).toEqual([realpathSync(h.repo), wt]);
    expect(h.only(h.cards()).title).toBe(keptTitle(batch));
  });

  it('keeps a worktree whose git dir 10db will not read through, with a card, and removes nothing', async () => {
    ignore('.env');
    const { batch } = await opened();
    const wt = pathOf(batch);
    write(wt, ['.env']);
    // `git worktree repair` under `worktree.useRelativePaths=true` leaves a relative gitfile.
    const gitDir = readFileSync(join(wt, '.git'), 'utf8')
      .replace(/^gitdir: /, '')
      .trim();
    writeFileSync(join(wt, '.git'), `gitdir: ${relative(wt, gitDir)}\n`);
    h.state.write((c) => {
      transitionBatch(c, batch.id, { to: 'SHIPPING' });
      transitionBatch(c, batch.id, { to: 'CLOSED' });
    });

    expect(await retireWorktree(h.ctx, batch.id)).toEqual({
      kind: 'kept',
      reason: 'unreadable',
      paths: [],
    });

    expect(getBatch(h.store.db, batch.id).worktreePath).toBe(wt);
    expect(readFileSync(join(wt, '.env'), 'utf8')).toBe('local\n');
    const card = h.only(h.cards());
    expect(card.title).toBe(`10db kept the worktree of "${batch.title}": it can't be read`);
    expect(card.body).toContain(`git -C '${h.repo}' worktree remove --force --force '${wt}'`);
  });

  it('lists every git-ignored file its command removes beside the uncommitted changes', async () => {
    ignore('.env', '*.tsbuildinfo');
    const { batch } = await opened();
    const wt = pathOf(batch);
    write(wt, ['.env', 'notes.txt', 'tsconfig.tsbuildinfo']);
    h.state.write((c) => transitionBatch(c, batch.id, { to: 'ABANDONED' }));

    expect(await retireWorktree(h.ctx, batch.id)).toMatchObject({
      kind: 'kept',
      reason: 'changes',
      paths: ['notes.txt'],
    });

    const card = h.only(h.cards());
    expect(card.title).toContain('uncommitted changes kept');
    expect(card.body).toContain('- notes.txt');
    expect(card.body).toContain('- .env');
    expect(card.body).toContain('- tsconfig.tsbuildinfo');
  });

  it.each<{ name: string; to: 'CLOSED' | 'ABANDONED'; files: string[]; why: string }>([
    { name: 'git-ignored files', to: 'CLOSED', files: ['.env'], why: 'it holds git-ignored files' },
    {
      name: 'uncommitted changes',
      to: 'ABANDONED',
      files: ['notes.txt'],
      why: 'uncommitted changes kept',
    },
  ])(
    'withdraws the card for a worktree kept for $name once the worktree is removed',
    async ({ to, files, why }) => {
      ignore('.env');
      const { batch } = await opened();
      const wt = pathOf(batch);
      write(wt, files);
      h.state.write((c) => {
        if (to === 'CLOSED') transitionBatch(c, batch.id, { to: 'SHIPPING' });
        transitionBatch(c, batch.id, { to });
      });
      expect((await retireWorktree(h.ctx, batch.id)).kind).toBe('kept');
      expect(h.only(h.cards()).title).toContain(why);

      for (const file of files) rmSync(join(wt, file));
      expect(await retireWorktree(h.ctx, batch.id)).toEqual({ kind: 'retired' });

      expect(h.cards()).toEqual([]);
    },
  );
});
