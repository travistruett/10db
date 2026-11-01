import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mintId, type BatchDto, type WorkstreamDto } from '@10db/contracts';
import {
  getBatch,
  insertBatch,
  listBatches,
  listWorkstreams,
  patchBatch,
  type DbReader,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { createTempClone, isolatedGitEnv } from '../../test/fixtures';
import { GhError, PrState } from '../github';
import { insertPlannedWorkstream, planForStart } from '../team';
import { recordCuttingTasks } from './cutting-tasks';
import { worktreePathFor } from './worktree-path';
import { cutWorktree } from './worktree-cut';

let h: DeliveryHarness;
beforeEach(() => {
  // The tests settle work and move batches by hand, then ask the shipper themselves.
  h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
});
afterEach(() => {
  h.close();
});

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();
}

function pathOf(batch: BatchDto): string {
  if (batch.worktreePath === null) throw new Error(`batch ${batch.title} has no worktree path`);
  return batch.worktreePath;
}

function branchOf(batch: BatchDto): string {
  if (batch.branch === null) throw new Error(`batch ${batch.title} has no branch`);
  return batch.branch;
}

/** The SHA of `branch` on origin, or null when origin doesn't have it. */
function onOrigin(branch: string): string | null {
  try {
    return h.origin$('rev-parse', '--verify', '-q', `refs/heads/${branch}`);
  } catch {
    return null;
  }
}

/** The SHA of local branch `branch`, or null when there is none. */
function local(branch: string): string | null {
  try {
    return h.git$('rev-parse', '--verify', '-q', `refs/heads/${branch}`);
  } catch {
    return null;
  }
}

/** Another clone commits `path` to the existing `branch` on origin, as a hand push would. */
function handPush(branch: string, path: string): string {
  const other = createTempClone(h.origin);
  try {
    gitIn(other.path, 'switch', '-q', branch);
    writeFileSync(join(other.path, path), `${path}\n`);
    gitIn(other.path, 'add', path);
    gitIn(other.path, 'commit', '-q', '-m', `Add ${path}`);
    gitIn(other.path, 'push', '-q', 'origin', branch);
    return gitIn(other.path, 'rev-parse', 'HEAD');
  } finally {
    other.cleanup();
  }
}

async function commitIn(batch: BatchDto, path: string): Promise<string> {
  const file = join(pathOf(batch), path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${path}\n`);
  const { sha } = await h.git.commit({
    repo: pathOf(batch),
    paths: [path],
    message: `Add ${path}`,
    opId: `op-${path}`,
    branch: branchOf(batch),
  });
  return sha;
}

/** A root batch shipped as a pull request: its branch on origin at `head`, the PR open. */
async function shippedRoot(): Promise<{ root: BatchDto; head: string; prUrl: string }> {
  const started = h.starter.startTask(h.addTask('Alpha').id);
  await h.jobs.idle();
  const batch = getBatch(h.store.db, started.id);
  const ws = h.only(listWorkstreams(h.store.db, { batchId: batch.id }));
  const head = await commitIn(batch, 'src/api/alpha.txt');
  h.settle(ws.id, 'DONE');
  h.shipper.checkBatch(batch.id);
  await h.jobs.idle();
  const root = getBatch(h.store.db, batch.id);
  expect(root.state).toBe('SHIPPED');
  expect(onOrigin(branchOf(root))).toBe(head);
  return { root, head, prUrl: root.prUrl ?? '' };
}

/** What T7 makes when CI fails on `head`: a fix batch on the root's branch, CUTTING, its task queued. */
function fixBatchOf(
  root: BatchDto,
  head: string,
): { fix: BatchDto; plans: Parameters<typeof cutWorktree>[2] } {
  const task = h.addTask('Fix CI');
  const plans = new Map([[task.id, planForStart(h.store.db, task.id)]]);
  mkdirSync(h.worktreeRoot, { recursive: true, mode: 0o700 });
  const id = mintId('Batch');
  const fix = h.state.write((w) => {
    const inserted = insertBatch(w, {
      id,
      projectId: h.project.id,
      title: 'Fix CI',
      baseBranch: root.baseBranch,
      autoMerge: root.autoMerge,
      worktreePath: worktreePathFor(realpathSync(h.worktreeRoot), h.project, `fix-${id}`),
      ciFix: { of: root.id, head },
    });
    patchBatch(w, id, { branch: branchOf(root) });
    for (const [taskId, plan] of plans) insertPlannedWorkstream(w, taskId, plan, id);
    recordCuttingTasks(w, id, plans.keys());
    return inserted;
  });
  return { fix, plans };
}

/** Cuts a fix batch on the root's branch and returns it as it is after the cut. */
async function cutFix(root: BatchDto, head: string): Promise<{ fix: BatchDto; ws: WorkstreamDto }> {
  const { fix, plans } = fixBatchOf(root, head);
  await cutWorktree(h.ctx, fix.id, plans, new AbortController().signal);
  return afterCut(h.store.db, fix.id);
}

function afterCut(db: DbReader, id: BatchDto['id']): { fix: BatchDto; ws: WorkstreamDto } {
  const fix = getBatch(db, id);
  const ws = listWorkstreams(db, { batchId: id })[0];
  if (ws === undefined) throw new Error('the fix batch has no workstream');
  return { fix, ws };
}

describe('cutting a fix batch', () => {
  it("starts the copy at the pull request's failing commit on the pull request's own branch", async () => {
    const { root, head } = await shippedRoot();
    const branch = branchOf(root);

    const { fix } = await cutFix(root, head);

    expect(fix).toMatchObject({ state: 'OPEN', branch, baseSha: head, ciFixOf: root.id });
    expect(gitIn(pathOf(fix), 'branch', '--show-current')).toBe(branch);
    expect(gitIn(pathOf(fix), 'rev-parse', 'HEAD')).toBe(head);
    expect(h.git$('for-each-ref', '--format=%(refname)', 'refs/heads/10db/')).toBe(
      `refs/heads/${branch}`,
    );
    expect(h.cards()).toEqual([]);
  });

  it('brings in a commit pushed by hand: the local branch moves to the failing head, never past it', async () => {
    const { root, head } = await shippedRoot();
    const branch = branchOf(root);
    const handHead = handPush(branch, 'by-hand.txt');
    // The failing head is the one CI ran on, which is the hand push; nothing newer follows it.
    expect(local(branch)).toBe(head);

    const { fix } = await cutFix(root, handHead);

    expect(local(branch)).toBe(handHead);
    expect(fix.state).toBe('OPEN');
    expect(gitIn(pathOf(fix), 'rev-parse', 'HEAD')).toBe(handHead);
    expect(fix.baseSha).toBe(handHead);
  });

  it('makes the local branch from origin when the root batch no longer has one', async () => {
    const { root, head } = await shippedRoot();
    const branch = branchOf(root);
    h.git$('branch', '-D', branch);
    expect(local(branch)).toBeNull();

    const { fix } = await cutFix(root, head);

    expect(fix.state).toBe('OPEN');
    expect(local(branch)).toBe(head);
    expect(gitIn(pathOf(fix), 'rev-parse', 'HEAD')).toBe(head);
  });

  const refusals: {
    name: string;
    spoil: (branch: string) => void;
  }[] = [
    {
      name: 'a local branch that has commits the failing head lacks',
      spoil: (branch) => {
        h.git$('switch', '-q', '-c', 'scratch');
        h.commit('local-only.txt');
        h.git$('update-ref', `refs/heads/${branch}`, 'HEAD');
        h.git$('switch', '-q', 'main');
      },
    },
    {
      name: 'a branch checked out in the main checkout',
      spoil: (branch) => {
        h.git$('switch', '-q', branch);
      },
    },
  ];
  it.each(refusals)(
    'is refused for $name and leaves the pull request branch where it was',
    async ({ spoil }) => {
      const { root, head } = await shippedRoot();
      const branch = branchOf(root);
      spoil(branch);
      const before = local(branch);
      const { fix, plans } = fixBatchOf(root, head);

      await cutWorktree(h.ctx, fix.id, plans, new AbortController().signal);

      expect(listBatches(h.store.db, {}).map((b) => b.id)).toEqual([root.id]);
      // The cut's refusal, and the stop card the same write raised for the root.
      expect(h.cards()).toHaveLength(2);
      // Neither the local branch nor the pull request's branch on origin was deleted or moved.
      expect(local(branch)).toBe(before);
      expect(onOrigin(branch)).toBe(head);
      expect(existsSync(pathOf(fix))).toBe(false);
      expect(h.git$('worktree', 'list', '--porcelain')).not.toContain(pathOf(fix));
    },
  );

  it('is refused when origin cannot give the failing head, leaving the branch in place', async () => {
    const { root, head } = await shippedRoot();
    const branch = branchOf(root);
    const { fix, plans } = fixBatchOf(root, 'f'.repeat(head.length));

    await cutWorktree(h.ctx, fix.id, plans, new AbortController().signal);

    expect(listBatches(h.store.db, {}).map((b) => b.id)).toEqual([root.id]);
    expect(h.cards()).toHaveLength(2);
    expect(local(branch)).toBe(head);
    expect(onOrigin(branch)).toBe(head);
  });
});

describe('shipping a fix batch', () => {
  it('adds its commits to the existing pull request without force and opens no second one', async () => {
    const { root, head, prUrl } = await shippedRoot();
    const branch = branchOf(root);
    const { fix, ws } = await cutFix(root, head);
    const fixed = await commitIn(fix, 'src/api/fix.txt');
    h.settle(ws.id, 'DONE');

    h.shipper.checkBatch(fix.id);
    await h.jobs.idle();

    expect(getBatch(h.store.db, fix.id)).toMatchObject({
      state: 'SHIPPED',
      prUrl,
      worktreePath: null,
    });
    expect(onOrigin(branch)).toBe(fixed);
    // A fast-forward: the failing head is in the pushed history.
    expect(h.origin$('merge-base', '--is-ancestor', head, fixed)).toBe('');
    expect(h.gh.prCreates()).toHaveLength(1);
    // Re-armed where the root wanted it.
    expect(h.gh.autoMerged).toEqual([prUrl, prUrl]);
    // The root's branch is still there for the pull request.
    expect(local(branch)).toBe(fixed);
    expect(h.cards()).toEqual([]);
  });

  it('treats an error to re-arming auto-merge as armed: no notice and still shipped', async () => {
    const { root, head, prUrl } = await shippedRoot();
    const { fix, ws } = await cutFix(root, head);
    await commitIn(fix, 'src/api/fix.txt');
    h.settle(ws.id, 'DONE');
    h.gh.failNext.set(
      'prAutoMerge',
      new GhError('failed', 'gh pr merge failed (exit 1): auto merge is already enabled'),
    );

    h.shipper.checkBatch(fix.id);
    await h.jobs.idle();

    expect(getBatch(h.store.db, fix.id)).toMatchObject({ state: 'SHIPPED', prUrl, notices: [] });
  });

  it('ends closed with nothing pushed when it made no commits, though main moved and was merged in', async () => {
    const { root, head } = await shippedRoot();
    const branch = branchOf(root);
    const { fix, ws } = await cutFix(root, head);
    // Main moves on, and the branch takes it in, as the per-step check's base update does.
    const moved = h.commit('src/ui/elsewhere.txt');
    h.git$('push', '-q', 'origin', 'main');
    await h.git.mergeIntoBranch({
      repo: pathOf(fix),
      branch,
      from: moved,
      message: 'Merge main',
    });
    expect(gitIn(pathOf(fix), 'rev-parse', 'HEAD')).not.toBe(head);
    h.settle(ws.id, 'DONE');

    h.shipper.checkBatch(fix.id);
    await h.jobs.idle();

    expect(getBatch(h.store.db, fix.id)).toMatchObject({ state: 'CLOSED', worktreePath: null });
    expect(onOrigin(branch)).toBe(head);
    expect(h.gh.autoMerged).toHaveLength(1);
    expect(h.gh.prCreates()).toHaveLength(1);
    // The pull request's branch survives the close.
    expect(local(branch)).not.toBeNull();
    expect(h.cards()).toEqual([]);
  });

  it('fails with the dirty-checkout card and keeps the worktree when the fix left its edits uncommitted', async () => {
    const { root, head } = await shippedRoot();
    const branch = branchOf(root);
    const { fix, ws } = await cutFix(root, head);
    // A tracked file, edited and never committed: the fix made no commits of its own.
    const edited = join(pathOf(fix), 'src/api/alpha.txt');
    writeFileSync(edited, 'the fix, uncommitted\n');
    h.settle(ws.id, 'DONE');

    h.shipper.checkBatch(fix.id);
    await h.jobs.idle();

    expect(getBatch(h.store.db, fix.id)).toMatchObject({
      state: 'FAILED',
      worktreePath: pathOf(fix),
    });
    expect(h.cards().map((c) => c.title)).toEqual([
      expect.stringContaining('the checkout has uncommitted changes'),
    ]);
    expect(existsSync(edited)).toBe(true);
    expect(gitIn(pathOf(fix), 'status', '--porcelain')).toContain('src/api/alpha.txt');
    expect(onOrigin(branch)).toBe(head);
  });

  it.each([PrState.Merged, PrState.Closed])(
    'ends closed with nothing pushed when the pull request %s meanwhile',
    async (state) => {
      const { root, head, prUrl } = await shippedRoot();
      const branch = branchOf(root);
      const { fix, ws } = await cutFix(root, head);
      await commitIn(fix, 'src/api/fix.txt');
      h.settle(ws.id, 'DONE');
      h.gh.setState(prUrl, state);

      h.shipper.checkBatch(fix.id);
      await h.jobs.idle();

      expect(getBatch(h.store.db, fix.id)).toMatchObject({ state: 'CLOSED', worktreePath: null });
      expect(onOrigin(branch)).toBe(head);
      expect(h.gh.autoMerged).toHaveLength(1);
      expect(h.gh.prCreates()).toHaveLength(1);
      expect(local(branch)).not.toBeNull();
    },
  );
});
