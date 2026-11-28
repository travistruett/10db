import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { BuilderOwns, type BatchDto, type WorkstreamDto } from '@10db/contracts';
import {
  getAppSetting,
  getBatch,
  getTask,
  getWorkstream,
  listInbox,
  listTasks,
  listWorkstreams,
  patchProject,
  setBatchNotice,
  setAppSetting,
  setTaskStatus,
  transitionBatch,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { commitIn, onOrigin, opened, pathOf } from '../../test/delivery-worlds';
import { isolatedGitEnv } from '../../test/fixtures';
import { createGit, parseWorktreeList, type GitTrustError } from '../git';
import { createInboxService, decidedByBuilder } from '../inbox';
import { retryWorkstream } from '../team';
import {
  batchCardFields,
  createBaseUpdates,
  createBatchCardAnswers,
  ensureWorktreeWhole,
  retireWorktree,
  type DeliveryContext,
} from './index';
import { baseConflictKey } from './cards';
import { baseNotices } from './notices';
import { raise } from './context';
import { INSTALL_SUMMARY } from './worktree-dependencies';

/** A test that runs one batch per case in one repository takes as long as its cases together. */
const LOOP_TIMEOUT = 180_000;

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

/**
 * A batch whose work finished and whose gate failed: what Retry starts from. `content` tells apart
 * the commits of several such batches in one test.
 */
async function failedAfterWork(
  content?: string,
): Promise<{ batch: BatchDto; ws: WorkstreamDto; head: string }> {
  const { batch, ws } = await opened(h);
  const head = await commitIn(h, batch, 'src/api/alpha.txt', content);
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

/** Ignores these patterns in every worktree of the repository, with nothing to commit. */
function ignore(...patterns: string[]): void {
  writeFileSync(join(h.repo, '.git', 'info', 'exclude'), `${patterns.join('\n')}\n`);
}

/** Writes each file under `dir`, as a builder's hand or a build would. */
function write(dir: string, files: readonly string[]): void {
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), 'local\n');
  }
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
    const { batch, ws } = await opened(h, { title: 'add the alpha widget' });
    const wt = pathOf(batch);
    const head = await commitIn(h, batch, 'src/api/alpha.txt');
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
    expect(onOrigin(h, batch.branch)).toBe(head);
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

  it("closes a worktree batch with no commits, removes the worktree, deletes its branch at the base and drops its tasks' kept starts", async () => {
    const { batch, ws } = await opened(h);
    h.git$('update-ref', `refs/10db/${basename(h.worktreeRoot)}/starts/${ws.id}`, 'HEAD');
    h.settle(ws.id, 'DONE');
    h.shipper.checkBatch(batch.id);
    await h.jobs.idle();
    const closed = getBatch(h.store.db, batch.id);
    expect(closed.state).toBe('CLOSED');
    expect(closed.worktreePath).toBeNull();
    expect(worktreePaths()).toEqual([realpathSync(h.repo)]);
    expect(h.git$('branch', '--list', batch.branch ?? '')).toBe('');
    expect(h.gh.prCreates()).toEqual([]);
    expect(h.git$('for-each-ref', '--format=%(refname)', 'refs/10db/')).toBe('');
  });

  it("keeps a CLOSED batch's branch that moved", async () => {
    const { batch } = await opened(h);
    const moved = await commitIn(h, batch, 'src/api/late.txt');
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
    const { batch, ws } = await opened(h);
    const wt = pathOf(batch);
    await commitIn(h, batch, 'src/api/alpha.txt');
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
    expect(onOrigin(h, batch.branch)).toBeNull();
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
    const { batch, ws } = await opened(h);
    const head = await commitIn(h, batch, 'src/api/alpha.txt');
    const teammate = h.teammatePush('main', 'src/ui/teammate.txt');
    // Passes only where main's newer commit is in the worktree.
    gate('test -f src/ui/teammate.txt');

    const shipped = await ship(batch, ws);

    expect(shipped.state).toBe('SHIPPED');
    expect(shipped.baseSha).toBe(teammate);
    const tip = onOrigin(h, batch.branch) ?? '';
    expect(h.origin$('log', '-1', '--format=%P', tip)).toBe(`${head} ${teammate}`);
    expect(h.origin$('ls-tree', '-r', '--name-only', tip).split('\n')).toEqual(
      expect.arrayContaining(['src/api/alpha.txt', 'src/ui/teammate.txt']),
    );
    expect(h.gh.prCreates()).toHaveLength(1);
    expect(h.cards()).toEqual([]);
  });

  it("ships the branch as it is when it conflicts with main, with no card; the tasks say the pull request conflicts once the worktree's own notice goes", async () => {
    const { batch, ws } = await opened(h);
    // Both sides add the file: no session can see the choice in markers, so it stays the builder's.
    const head = await commitIn(h, batch, 'src/api/both.txt');
    h.teammatePush('main', 'src/api/both.txt', 'theirs\n');

    const shipped = await ship(batch, ws);

    expect(shipped.state).toBe('SHIPPED');
    expect(onOrigin(h, batch.branch)).toBe(head);
    // The shipping gate meets the conflict and raises nothing: the pull request shows it now.
    expect(listInbox(h.store.db, {})).toEqual([]);
    const [notice, ...rest] = getBatch(h.store.db, batch.id).notices;
    expect(rest).toEqual([]);
    expect(notice).toMatchObject({
      key: 'base-conflict',
      tone: 'warning',
      line: 'Pull request conflicts with main',
    });
    expect(notice?.body).toContain('Update branch');
    expect(notice?.body).not.toContain(batch.worktreePath ?? 'no worktree');
  });

  it("clears the batch's base notices, and closes the cards an earlier build raised, when its worktree goes", async () => {
    const { batch, ws } = await opened(h);
    const path = pathOf(batch);
    h.state.write((w) => {
      setBatchNotice(w, batch.id, baseNotices.conflict(batch, path, ['README.md']));
      setBatchNotice(w, batch.id, baseNotices.kept(batch, path, ['build/']));
    });
    raise(h.inbox, h.project.id, {
      tier: 'ask',
      urgency: 'high',
      closesWhen: { by: 'answer' },
      decision: decidedByBuilder(BuilderOwns.OutOfMoves),
      title: 'Batch conflicts with main',
      body: 'x',
      foldKey: baseConflictKey(batch.id),
    });
    expect(getBatch(h.store.db, batch.id).notices).toHaveLength(2);
    expect(h.cards()).toHaveLength(1);
    h.settle(ws.id, 'DONE');
    h.shipper.checkBatch(batch.id);
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id)).toMatchObject({
      state: 'CLOSED',
      worktreePath: null,
      notices: [],
    });
    expect(h.cards()).toEqual([]);
  });

  it('names what kept main out in the fix task of a shipping gate that failed', async () => {
    const { batch, ws } = await opened(h);
    await commitIn(h, batch, 'src/api/both.txt');
    h.teammatePush('main', 'src/api/both.txt', 'theirs\n');
    gate('false');

    const failed = await ship(batch, ws);

    expect(failed.state).toBe('OPEN');
    const fix = h.only(
      listTasks(h.store.db, h.project.id).filter((t) => t.title.startsWith('Fix the gate')),
    );
    expect(fix.description).toMatch(
      /^origin\/main conflicts with this branch in src\/api\/both\.txt/,
    );
    expect(onOrigin(h, batch.branch)).toBeNull();
  });

  describe('a conflict whose markers a session can resolve, met at the shipping gate', () => {
    /** Both sides changed the one line of README.md. */
    async function overlapping() {
      const { batch, ws } = await opened(h);
      const own = await commitIn(h, batch, 'README.md', '# ours\n');
      const teammate = h.teammatePush('main', 'README.md', '# theirs\n');
      return { batch, ws, own, teammate };
    }

    /** The workstream the shipper queued for the batch's last task, beside the one that was Done. */
    function queuedBeside(batch: BatchDto, ws: WorkstreamDto): WorkstreamDto {
      const all = listWorkstreams(h.store.db, { batchId: batch.id });
      expect(all).toHaveLength(2);
      const next = all.find((w) => w.id !== ws.id);
      if (!next) throw new Error('no second workstream');
      return next;
    }

    it('reopens the batch with its last task queued to merge, runs no gate on the branch, pushes nothing and raises no card, then ships the resolved branch with the gate run on the merge', async () => {
      const { batch, ws, own, teammate } = await overlapping();

      const reopened = await ship(batch, ws);

      expect(reopened).toMatchObject({ state: 'OPEN', failure: null });
      expect(existsSync(gateOut)).toBe(false);
      expect(onOrigin(h, batch.branch)).toBeNull();
      expect(h.cards()).toEqual([]);
      expect(gitIn(pathOf(batch), 'log', '-1', '--format=%P')).toBe(`${own} ${teammate}`);
      expect(readFileSync(join(pathOf(batch), 'README.md'), 'utf8')).toContain('<<<<<<< ');
      const next = queuedBeside(batch, ws);
      expect(next).toMatchObject({
        taskId: ws.taskId,
        batchId: batch.id,
        state: 'QUEUED',
        nextAction: { kind: 'merge', base: 'origin/main', paths: ['README.md'] },
      });
      expect(next.steps.map((s) => [s.role, s.status])).toEqual([['implement', 'running']]);
      expect(getWorkstream(h.store.db, ws.id).state).toBe('DONE');
      expect(getTask(h.store.db, ws.taskId).status).toBe('open');
      expect(h.only(reopened.notices)).toMatchObject({ key: 'base-conflict', tone: 'info' });

      // The session resolves the markers and its task is done: the merge ships.
      await commitIn(h, batch, 'README.md', '# ours and theirs\n');
      // The worktree goes once the batch ships.
      const worktree = realpathSync(pathOf(batch));
      h.settle(next.id, 'DONE');
      h.shipper.checkBatch(batch.id);
      await h.jobs.idle();

      expect(getBatch(h.store.db, batch.id).state).toBe('SHIPPED');
      expect(readFileSync(gateOut, 'utf8').trim()).toBe(worktree);
      const tip = onOrigin(h, batch.branch) ?? '';
      expect(h.origin$('show', `${tip}:README.md`)).toBe('# ours and theirs');
      expect(h.cards()).toEqual([]);
    });

    it('does the same for markers an earlier gate left, without merging again, and never runs a gate on them', async () => {
      const { batch, ws } = await overlapping();
      await createBaseUpdates(h.ctx).beforeGate(batch.id, new AbortController().signal, {
        inSession: true,
      });
      const merged = gitIn(pathOf(batch), 'rev-parse', 'HEAD');

      const reopened = await ship(batch, ws);

      expect(reopened.state).toBe('OPEN');
      expect(gitIn(pathOf(batch), 'rev-parse', 'HEAD')).toBe(merged);
      expect(existsSync(gateOut)).toBe(false);
      expect(h.cards()).toEqual([]);
      expect(queuedBeside(batch, ws).nextAction).toMatchObject({
        kind: 'merge',
        paths: ['README.md'],
      });
    });

    it('raises one card naming the files and why when the last task cannot take the merge', async () => {
      const { batch, ws } = await overlapping();
      h.settle(ws.id, 'DONE');
      h.state.write((c) => {
        setTaskStatus(c, ws.taskId, 'cancelled');
      });
      h.shipper.checkBatch(batch.id);
      await h.jobs.idle();

      expect(getBatch(h.store.db, batch.id)).toMatchObject({
        state: 'FAILED',
        failure: 'base_conflict',
      });
      expect(existsSync(gateOut)).toBe(false);
      expect(listWorkstreams(h.store.db, { batchId: batch.id })).toHaveLength(1);
      const card = h.only(h.cards());
      expect(card.title).toContain('conflicts with main');
      expect(card.body).toContain('README.md');
      expect(card.body).toContain('was closed');
    });
  });

  it('merges nothing for a project with no gate: the builder checked the work as it is', async () => {
    h.state.write((c) => patchProject(c, h.project.id, { gateCommand: null }));
    const { batch, ws } = await opened(h);
    const head = await commitIn(h, batch, 'src/api/alpha.txt');
    h.teammatePush('main', 'src/ui/teammate.txt');

    const shipped = await ship(batch, ws);

    expect(shipped.state).toBe('SHIPPED');
    expect(onOrigin(h, batch.branch)).toBe(head);
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

  const retries: {
    name: string;
    /** What the builder or a crash did to the worktree; returns the gate's extra check. */
    before: (wt: string, gitDir: string) => string;
    shipped: boolean;
  }[] = [
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
        gitIn(wt, 'switch', '-q', '-c', 'other-clean');
        return 'test -f src/api/alpha.txt';
      },
      shipped: true,
    },
    {
      name: 'refuses a worktree on another branch with changes',
      before: (wt) => {
        gitIn(wt, 'switch', '-q', '-c', 'other-dirty');
        writeFileSync(join(wt, 'README.md'), '# the builder was here\n');
        return 'true';
      },
      shipped: false,
    },
  ];

  it(
    'ships a FAILED batch on Retry from a whole or rebuilt worktree, and refuses one on another branch with changes',
    async () => {
      // One batch per case, one after another; the refused one last, as it keeps its worktree.
      for (const [i, { name, before, shipped }] of retries.entries()) {
        const { batch, head } = await failedAfterWork(`case ${String(i)}\n`);
        const wt = pathOf(batch);
        gate(before(wt, gitIn(wt, 'rev-parse', '--absolute-git-dir')));
        const prs = h.gh.prCreates().length;

        h.shipper.ship(batch.id);
        await h.jobs.idle();

        const now = getBatch(h.store.db, batch.id);
        if (shipped) {
          expect.soft(now.state, name).toBe('SHIPPED');
          expect.soft(readFileSync(gateOut, 'utf8').trim(), name).toBe(wt);
          expect.soft(onOrigin(h, batch.branch), name).toBe(head);
          expect.soft(h.gh.prCreates(), name).toHaveLength(prs + 1);
          expect.soft(now.worktreePath, name).toBeNull();
          expect.soft(worktreePaths(), name).toEqual([realpathSync(h.repo)]);
          continue;
        }
        expect
          .soft(now, name)
          .toMatchObject({ state: 'FAILED', failure: 'wrong_branch', worktreePath: wt });
        expect.soft(h.only(h.cards()).body, name).toContain(wt);
        expect
          .soft(readFileSync(join(wt, 'README.md'), 'utf8'), name)
          .toBe('# the builder was here\n');
        expect.soft(gitIn(wt, 'branch', '--show-current'), name).toBe('other-dirty');
        expect.soft(onOrigin(h, batch.branch), name).toBeNull();
        expect.soft(h.gh.prCreates(), name).toHaveLength(prs);
      }
    },
    LOOP_TIMEOUT,
  );

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
    expect(card.body).toContain('answer Retry');
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

  it('refuses a replaced worktree whose dependency install fails, removing it and naming the cause, and asks about a host the sandbox blocked the install from', async () => {
    h.commit('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    h.git$('push', '-q', 'origin', 'main');
    // The seed needs a node_modules to refresh.
    writeFileSync(join(h.repo, '.gitignore'), 'node_modules/\n');
    mkdirSync(join(h.repo, 'node_modules'), { recursive: true });

    // An install the sandbox blocked from a host.
    const blocked = (await failedAfterWork('blocked\n')).batch;
    rmSync(pathOf(blocked), { recursive: true, force: true });
    h.pnpm.blockedFrom('registry.npmjs.org');

    expect(await ensureWorktreeWhole(h.ctx, blocked, new AbortController().signal)).toBe('refused');
    const host = h.only(
      h.cards().filter((c) => c.title === 'Allow network access to registry.npmjs.org?'),
    );
    expect(host.body).toContain(`Install: ${INSTALL_SUMMARY}`);
    expect(host.targets).toEqual([]);
    const refused = h.only(
      h.cards().filter((c) => c.title.includes("couldn't install the dependencies")),
    );
    expect(refused.body).toContain('The install was blocked from reaching registry.npmjs.org');
    expect(refused.body).not.toMatch(/the gate was blocked|run the gate again/i);

    // An install that fails on its own, in another batch.
    h.pnpm.succeed();
    const earlier = new Set(h.cards().map((c) => c.id));
    const { batch } = await failedAfterWork('failed\n');
    const wt = pathOf(batch);
    rmSync(wt, { recursive: true, force: true });
    h.pnpm.failWith(1, 'ERR_PNPM_META_FETCH_FAIL');

    const outcome = await ensureWorktreeWhole(h.ctx, batch, new AbortController().signal);

    expect(outcome).toBe('refused');
    expect(h.only(h.cards().filter((c) => !earlier.has(c.id))).body).toContain(
      'ERR_PNPM_META_FETCH_FAIL',
    );
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(pathOf(blocked))).toBe(false);
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

  it(
    'reopens a FAILED worktree batch only after making its worktree whole: on Retry with unfinished work, when a fix task joins it, and on a workstream Retry through the cut queue',
    async () => {
      // Retry of a batch with unfinished work.
      {
        const { batch, ws } = await opened(h);
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
      }

      // A fix task joining a batch whose work finished.
      {
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
      }

      // A workstream's Retry, answered on its card.
      const { batch, ws } = await opened(h);
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
        tier: 'ask',
        urgency: 'high',
        closesWhen: { by: 'answer' },
        decision: decidedByBuilder(BuilderOwns.OutOfMoves),
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
    },
    LOOP_TIMEOUT,
  );
});

describe('Abandon of a worktree batch', () => {
  // The rule that saves files is off here: these cases are about the card a kept worktree raises.
  beforeEach(() => {
    h.askBeforeSaving();
  });

  it('removes a clean worktree and clears its path', async () => {
    const { batch } = await opened(h);
    const wt = pathOf(batch);
    await commitIn(h, batch, 'src/api/alpha.txt');
    expect(h.shipper.abandon(batch.id).state).toBe('ABANDONED');
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id).worktreePath).toBeNull();
    expect(existsSync(wt)).toBe(false);
    expect(worktreePaths()).toEqual([realpathSync(h.repo)]);
    expect(h.git$('branch', '--list', batch.branch ?? '')).toContain(batch.branch ?? '');
    expect(h.cards().map((c) => c.title)).toEqual([
      `Delete ${batch.branch ?? ''}? It holds 1 commit`,
    ]);
  });

  it('keeps a dirty worktree and its path, from Abandon and from retireWorktree itself, and names it with --force --force and every git-ignored file that command removes', async () => {
    ignore('.env', '*.tsbuildinfo');
    const { batch } = await opened(h);
    const wt = pathOf(batch);
    writeFileSync(join(wt, 'notes.txt'), 'not committed\n');
    write(wt, ['.env', 'tsconfig.tsbuildinfo']);
    h.shipper.abandon(batch.id);
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id)).toMatchObject({
      state: 'ABANDONED',
      worktreePath: wt,
    });
    expect(readFileSync(join(wt, 'notes.txt'), 'utf8')).toBe('not committed\n');
    expect(worktreePaths()).toEqual([realpathSync(h.repo), wt]);
    const kept = h.only(h.cards());
    expect(kept.title).toContain('uncommitted changes kept');
    expect(kept.body).toContain('- notes.txt');
    expect(kept.body).toContain('- .env');
    expect(kept.body).toContain('- tsconfig.tsbuildinfo');
    expect(kept.body).toContain(`git -C '${h.repo}' worktree remove --force --force '${wt}'`);

    // retireWorktree itself, asked again, keeps it for the uncommitted change alone.
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
    const { batch } = await opened(h);
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
  // With the rule set to ask, today's card is raised; saving the files is the next describe's.
  beforeEach(() => {
    h.askBeforeSaving();
  });

  const keptTitle = (batch: BatchDto) =>
    `10db kept the worktree of "${batch.title}": it holds git-ignored files`;

  /** The open cards and posted notices since `before` was taken. */
  const since = (before: { cards: Set<string>; notices: number }) => ({
    cards: h.cards().filter((c) => !before.cards.has(c.id)),
    notices: h.notices().slice(before.notices),
  });
  const mark = () => ({ cards: new Set(h.cards().map((c) => c.id)), notices: h.notices().length });

  const cases: {
    name: string;
    to: 'CLOSED' | 'ABANDONED';
    patterns?: string[];
    /** Files committed in the worktree before the loose ones are written. */
    tracked?: string[];
    files: string[];
    /** The files the card lists; null when the worktree goes. */
    kept: string[] | null;
  }[] = [
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
      name: 'only a Rust target/ directory',
      to: 'CLOSED',
      patterns: ['target/'],
      files: ['apps/desktop/src-tauri/target/debug/app'],
      kept: null,
    },
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
  ];

  it(
    'keeps a finished worktree for the git-ignored files a person made, and removes one that holds only build output',
    async () => {
      // One batch per case in one repository; a kept worktree stays beside the next case's.
      for (const { name, to, patterns, tracked, files, kept } of cases) {
        ignore(...(patterns ?? ['.env', '.env.*', '.DS_Store', 'dist/', 'node_modules/']));
        const others = worktreePaths();
        const before = mark();
        const { batch } = await opened(h);
        const wt = pathOf(batch);
        for (const file of tracked ?? []) await commitIn(h, batch, file);
        write(wt, files);
        h.state.write((c) => {
          if (to === 'CLOSED') transitionBatch(c, batch.id, { to: 'SHIPPING' });
          transitionBatch(c, batch.id, { to });
        });

        const outcome = await retireWorktree(h.ctx, batch.id);
        const now = since(before);

        if (kept === null) {
          expect.soft(outcome, name).toEqual({ kind: 'retired' });
          expect.soft(getBatch(h.store.db, batch.id).worktreePath, name).toBeNull();
          expect.soft(worktreePaths(), name).toEqual(others);
          // An abandoned batch's branch, with nothing on it, is deleted and a notice says so.
          expect.soft(now.cards, name).toEqual([]);
          expect
            .soft(
              now.notices.map((n) => n.line),
              name,
            )
            .toEqual(
              to === 'ABANDONED' && (tracked ?? []).length === 0
                ? [`Batch "${batch.title}" abandoned: ${batch.branch ?? ''} deleted`]
                : [],
            );
          continue;
        }
        expect.soft(outcome, name).toEqual({ kind: 'kept', reason: 'ignored', paths: kept });
        expect.soft(getBatch(h.store.db, batch.id).worktreePath, name).toBe(wt);
        expect.soft(worktreePaths().sort(), name).toEqual([...others, wt].sort());
        for (const file of files)
          expect.soft(readFileSync(join(wt, file), 'utf8'), `${name}: ${file}`).toBe('local\n');
        expect.soft(now.cards, name).toHaveLength(1);
        const card = now.cards[0];
        expect.soft(card?.title, name).toBe(keptTitle(batch));
        for (const file of files)
          if (kept.includes(file))
            expect.soft(card?.body, `${name}: ${file}`).toContain(`- ${file}`);
          else expect.soft(card?.body, `${name}: ${file}`).not.toContain(file);
        expect
          .soft(card?.body, name)
          .toContain(`git -C '${h.repo}' worktree remove --force --force '${wt}'`);
      }
    },
    LOOP_TIMEOUT,
  );

  it("keeps a shipped batch's worktree that holds a .env, and raises one card however often it retires", async () => {
    ignore('.env');
    const { batch, ws } = await opened(h);
    const wt = pathOf(batch);
    await commitIn(h, batch, 'src/api/alpha.txt');
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
    const { batch } = await opened(h);
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

  it('withdraws the card for a worktree kept for git-ignored files or uncommitted changes once the worktree is removed', async () => {
    ignore('.env');
    const kinds: { name: string; to: 'CLOSED' | 'ABANDONED'; files: string[]; why: string }[] = [
      {
        name: 'git-ignored files',
        to: 'CLOSED',
        files: ['.env'],
        why: 'it holds git-ignored files',
      },
      {
        name: 'uncommitted changes',
        to: 'ABANDONED',
        files: ['notes.txt'],
        why: 'uncommitted changes kept',
      },
    ];
    for (const { name, to, files, why } of kinds) {
      const before = h.notices().length;
      const { batch } = await opened(h);
      const wt = pathOf(batch);
      write(wt, files);
      h.state.write((c) => {
        if (to === 'CLOSED') transitionBatch(c, batch.id, { to: 'SHIPPING' });
        transitionBatch(c, batch.id, { to });
      });
      expect.soft((await retireWorktree(h.ctx, batch.id)).kind, name).toBe('kept');
      expect.soft(h.only(h.cards()).title, name).toContain(why);

      for (const file of files) rmSync(join(wt, file));
      expect.soft(await retireWorktree(h.ctx, batch.id), name).toEqual({ kind: 'retired' });

      // Only the note that an abandoned batch's empty branch was deleted is left, and it is a notice.
      expect.soft(h.cards(), name).toEqual([]);
      expect
        .soft(
          h
            .notices()
            .slice(before)
            .map((n) => n.line),
          name,
        )
        .toEqual(
          to === 'ABANDONED'
            ? [`Batch "${batch.title}" abandoned: ${batch.branch ?? ''} deleted`]
            : [],
        );
    }
  });
});

describe('a finished worktree whose own files are saved first', () => {
  /** The folder a save made for the batch under the kept root, and the files it holds. */
  const savedFor = (batch: BatchDto): { dir: string; files: string[] } | null => {
    const parent = join(h.keptRoot, batch.id);
    if (!existsSync(parent)) return null;
    const [stamp] = readdirSync(parent);
    if (stamp === undefined) return null;
    const dir = join(parent, stamp);
    return {
      dir,
      files: readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => relative(dir, join(e.parentPath, e.name)))
        .sort(),
    };
  };

  /** Closes the batch the way a shipped one ends, so the next `retireWorktree` finds it finished. */
  const close = (batch: BatchDto): void => {
    h.state.write((c) => {
      transitionBatch(c, batch.id, { to: 'SHIPPING' });
      transitionBatch(c, batch.id, { to: 'CLOSED' });
    });
  };

  const savedNotices = () => h.notices().filter((n) => n.key.startsWith('worktree-saved:'));

  it("saves a shipped batch's .env under the kept folder, verified, then removes the worktree with one notice and no card", async () => {
    ignore('.env', '.env.shared', '*.tsbuildinfo');
    const { batch, ws } = await opened(h);
    const wt = pathOf(batch);
    await commitIn(h, batch, 'src/api/alpha.txt');
    // A hand-made .env, a copy of a file the checkout holds, and build info the gate writes again.
    write(wt, ['.env.shared', 'tsconfig.tsbuildinfo']);
    writeFileSync(join(h.repo, '.env.shared'), 'local\n');
    writeFileSync(join(wt, '.env'), 'secret\n');
    chmodSync(join(wt, '.env'), 0o600);
    h.settle(ws.id, 'DONE');
    h.shipper.checkBatch(batch.id);
    await h.jobs.idle();

    expect(getBatch(h.store.db, batch.id)).toMatchObject({ state: 'SHIPPED', worktreePath: null });
    expect(existsSync(wt)).toBe(false);
    expect(worktreePaths()).toEqual([realpathSync(h.repo)]);
    const saved = savedFor(batch);
    expect(saved?.files).toEqual(['.env']);
    expect(readFileSync(join(saved?.dir ?? '', '.env'), 'utf8')).toBe('secret\n');
    expect(statSync(join(saved?.dir ?? '', '.env')).mode & 0o777).toBe(0o600);
    const notice = h.only(savedNotices());
    expect(notice.key).toBe(`worktree-saved:${wt}`);
    expect(notice.line).toBe('Saved 1 file from a finished worktree and removed it');
    expect(notice.decision).toMatchObject({ by: 'rule', rule: 'worktree-leftovers' });
    expect(h.cards()).toEqual([]);
  });

  it('removes a worktree whose leftovers all have copies in the checkout or are rewritten, saving nothing', async () => {
    ignore('.env.shared', '*.tsbuildinfo');
    const { batch } = await opened(h);
    const wt = pathOf(batch);
    write(wt, ['.env.shared', 'tsconfig.tsbuildinfo']);
    writeFileSync(join(h.repo, '.env.shared'), 'local\n');
    close(batch);

    expect(await retireWorktree(h.ctx, batch.id)).toEqual({ kind: 'retired' });

    expect(existsSync(wt)).toBe(false);
    expect(savedFor(batch)).toBeNull();
    expect(savedNotices()).toEqual([]);
    expect(h.cards()).toEqual([]);
  });

  it("keeps the worktree and raises today's card when the copy can't be made", async () => {
    ignore('.env');
    const { batch } = await opened(h);
    const wt = pathOf(batch);
    write(wt, ['.env']);
    close(batch);
    // The kept folder's parent can't take a new folder, so the save fails before it copies anything.
    const parent = dirname(h.keptRoot);
    chmodSync(parent, 0o500);
    try {
      expect(await retireWorktree(h.ctx, batch.id)).toEqual({
        kind: 'kept',
        reason: 'ignored',
        paths: ['.env'],
      });
    } finally {
      chmodSync(parent, 0o700);
    }

    expect(getBatch(h.store.db, batch.id).worktreePath).toBe(wt);
    expect(readFileSync(join(wt, '.env'), 'utf8')).toBe('local\n');
    expect(h.only(h.cards()).title).toBe(
      `10db kept the worktree of "${batch.title}": it holds git-ignored files`,
    );
    expect(savedNotices()).toEqual([]);
  });

  it("copies nothing and raises today's card when the rule is set to ask", async () => {
    ignore('.env');
    h.askBeforeSaving();
    const { batch } = await opened(h);
    const wt = pathOf(batch);
    write(wt, ['.env']);
    close(batch);

    expect((await retireWorktree(h.ctx, batch.id)).kind).toBe('kept');

    expect(getBatch(h.store.db, batch.id).worktreePath).toBe(wt);
    expect(existsSync(h.keptRoot)).toBe(false);
    expect(h.only(h.cards()).title).toContain('it holds git-ignored files');
  });
});
