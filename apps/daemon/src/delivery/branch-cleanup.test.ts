import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BatchDto, InboxItemDto, WorkstreamDto } from '@10db/contracts';
import {
  clearWorktreePath,
  getBatch,
  getInboxItem,
  listWorkstreams,
  transitionBatch,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { ManualClock } from '../clock';
import { PrState } from '../github';
import { createInboxService, type InboxService } from '../inbox';
import { silentLogger } from '../log';
import { systemProcesses } from '../recovery';
import {
  createBranchCardAnswers,
  createPrWatch,
  recoverBatches,
  removeMergedBranches,
  type PrWatch,
} from './index';
import { removeBranch } from './branch-cleanup';
import { listStrayBranches } from './branch-sweep';
import { retireWorktree } from './worktree-cleanup';

let h: DeliveryHarness;
let inbox: InboxService;
const watches: PrWatch[] = [];
beforeEach(() => {
  h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
  inbox = createInboxService({
    state: h.state,
    onParkedAnswer: () => undefined,
    onFlagAnswer: createBranchCardAnswers(h.ctx),
  });
});
afterEach(async () => {
  for (const w of watches.splice(0)) await w.stop();
  h.close();
});

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
  const worktree = batch.worktreePath ?? '';
  const file = join(worktree, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${path}\n`);
  const { sha } = await h.git.commit({
    repo: worktree,
    paths: [path],
    message: `Add ${path}`,
    opId: `op-${path}`,
    branch: batch.branch ?? '',
  });
  return sha;
}

/** Whether the local branch is in the main repository. */
const exists = (branch: string | null): boolean => h.git$('branch', '--list', branch ?? '') !== '';

/** The open cards that name the branch. */
const cardsAbout = (branch: string | null): InboxItemDto[] =>
  h.cards().filter((c) => c.title.includes(branch ?? '?'));

/** A task that shipped: its pull request is open and its branch is still local. */
async function shipped(title = 'Alpha'): Promise<{ batch: BatchDto; tip: string; prUrl: string }> {
  const { batch, ws } = await opened(title);
  const tip = await commitIn(batch, `src/api/${title.toLowerCase()}.txt`);
  h.settle(ws.id, 'DONE');
  h.shipper.checkBatch(batch.id);
  await h.jobs.idle();
  const done = getBatch(h.store.db, batch.id);
  expect(done.state).toBe('SHIPPED');
  expect(exists(done.branch)).toBe(true);
  return { batch: done, tip, prUrl: done.prUrl ?? '' };
}

/** Startup batch recovery as the daemon runs it, with this test's inbox. */
const recover = () =>
  recoverBatches({
    state: h.state,
    git: h.git,
    inbox,
    processes: systemProcesses,
    shipper: h.shipper,
    logger: silentLogger,
    worktrees: { ctx: { ...h.ctx, inbox }, root: h.worktreeRoot },
  });

/** A pull request watch that cleans merged branches after each round, as the daemon wires it. */
function watch(): PrWatch {
  const w = createPrWatch({
    ctx: h.ctx,
    clock: new ManualClock(),
    intervalMs: 120_000,
    afterRound: (signal) => removeMergedBranches(h.ctx, signal),
  });
  watches.push(w);
  return w;
}

describe('an abandoned task whose branch holds commits', () => {
  it('raises one card naming the branch and its commit count, and keeps the branch', async () => {
    const { batch } = await opened();
    await commitIn(batch, 'src/api/one.txt');
    await commitIn(batch, 'src/api/two.txt');
    h.shipper.abandon(batch.id);
    await h.jobs.idle();
    expect(exists(batch.branch)).toBe(true);
    const card = h.only(cardsAbout(batch.branch));
    expect(card.title).toBe(`Delete ${batch.branch ?? ''}? It holds 2 commits`);
    expect(card.options.map((o) => o.label)).toEqual(['Delete Branch', 'Keep']);
  });

  it('says one commit in the singular', async () => {
    const { batch } = await opened();
    await commitIn(batch, 'src/api/one.txt');
    h.shipper.abandon(batch.id);
    await h.jobs.idle();
    expect(h.only(cardsAbout(batch.branch)).title).toContain('1 commit');
    expect(h.only(cardsAbout(batch.branch)).title).not.toContain('1 commits');
  });

  it('deletes the branch on Delete Branch', async () => {
    const { batch } = await opened();
    await commitIn(batch, 'src/api/one.txt');
    h.shipper.abandon(batch.id);
    await h.jobs.idle();
    const card = h.only(cardsAbout(batch.branch));
    expect(inbox.answer(card.id, { choice: 'Delete Branch' }).state).toBe('RESOLVED');
    await h.jobs.idle();
    expect(exists(batch.branch)).toBe(false);
  });

  it('keeps the branch on Keep, and does not ask again', async () => {
    const { batch } = await opened();
    await commitIn(batch, 'src/api/one.txt');
    h.shipper.abandon(batch.id);
    await h.jobs.idle();
    const card = h.only(cardsAbout(batch.branch));
    inbox.answer(card.id, { choice: 'Keep' });
    await h.jobs.idle();
    expect(exists(batch.branch)).toBe(true);
    expect(cardsAbout(batch.branch)).toEqual([]);
  });

  it('refuses to delete a branch checked out in the main checkout, and says so on a new card', async () => {
    const { batch } = await opened();
    await commitIn(batch, 'src/api/one.txt');
    h.shipper.abandon(batch.id);
    await h.jobs.idle();
    const card = h.only(cardsAbout(batch.branch));
    h.git$('switch', '-q', batch.branch ?? '');
    inbox.answer(card.id, { choice: 'Delete Branch' });
    await h.jobs.idle();
    expect(exists(batch.branch)).toBe(true);
    const again = h.only(cardsAbout(batch.branch));
    expect(again.id).not.toBe(card.id);
    expect(again.title).toBe(`${batch.branch ?? ''} was not deleted: it is checked out`);
    expect(again.options.map((o) => o.label)).toEqual(['Delete Branch', 'Keep']);
    // Switched away, the second answer deletes it.
    h.git$('switch', '-q', 'main');
    inbox.answer(again.id, { choice: 'Delete Branch' });
    await h.jobs.idle();
    expect(exists(batch.branch)).toBe(false);
  });

  it('refuses to delete a branch checked out in another worktree', async () => {
    const { batch } = await opened();
    await commitIn(batch, 'src/api/one.txt');
    h.shipper.abandon(batch.id);
    await h.jobs.idle();
    const card = h.only(cardsAbout(batch.branch));
    const elsewhere = join(h.dataDir, 'their-worktree');
    h.git$('worktree', 'add', '-q', elsewhere, batch.branch ?? '');
    inbox.answer(card.id, { choice: 'Delete Branch' });
    await h.jobs.idle();
    expect(exists(batch.branch)).toBe(true);
    expect(h.only(cardsAbout(batch.branch)).body).toContain(elsewhere);
  });

  it('deletes the branch of an abandoned task that never moved off its base, without a card', async () => {
    const { batch } = await opened();
    h.shipper.abandon(batch.id);
    await h.jobs.idle();
    expect(exists(batch.branch)).toBe(false);
    expect(cardsAbout(batch.branch)).toEqual([]);
  });

  it('answers a card whose branch is already gone without a new card', async () => {
    const { batch } = await opened();
    await commitIn(batch, 'src/api/one.txt');
    h.shipper.abandon(batch.id);
    await h.jobs.idle();
    const card = h.only(cardsAbout(batch.branch));
    h.git$('branch', '-D', batch.branch ?? '');
    inbox.answer(card.id, { choice: 'Delete Branch' });
    await h.jobs.idle();
    expect(h.cards().filter((c) => c.id !== card.id && c.title.includes('not deleted'))).toEqual(
      [],
    );
  });

  it('never removes a branch outside 10db/, and reports one that is not there', async () => {
    h.git$('branch', 'precious');
    await expect(
      removeBranch(h.git, h.repo, 'precious', () => Promise.resolve(true)),
    ).resolves.toEqual({ kind: 'foreign' });
    expect(exists('precious')).toBe(true);
    await expect(
      removeBranch(h.git, h.repo, '10db/none', () => Promise.resolve(true)),
    ).resolves.toEqual({ kind: 'absent' });
  });
});

describe('a pull request closed without merging', () => {
  it('raises one card offering to delete the local branch, which stays until answered', async () => {
    const { batch, prUrl } = await shipped();
    h.gh.setState(prUrl, PrState.Closed);
    const w = watch();
    w.start();
    await w.idle();
    const card = h.only(h.cards().filter((c) => c.title.startsWith('Pull request closed')));
    expect(card.options.map((o) => o.label)).toEqual(['Delete Branch', 'Keep']);
    expect(exists(batch.branch)).toBe(true);
    w.poke();
    await w.idle();
    expect(h.cards().filter((c) => c.title.startsWith('Pull request closed'))).toHaveLength(1);
    expect(exists(batch.branch)).toBe(true);
  });

  it('deletes the branch on Delete Branch and leaves it on Keep', async () => {
    const first = await shipped('Alpha');
    const second = await shipped('Beta');
    h.gh.setState(first.prUrl, PrState.Closed);
    h.gh.setState(second.prUrl, PrState.Closed);
    const w = watch();
    w.start();
    await w.idle();
    const cards = h.cards().filter((c) => c.title.startsWith('Pull request closed'));
    expect(cards).toHaveLength(2);
    const [a, b] = [
      cards.find((c) => c.title.includes('"Alpha"')),
      cards.find((c) => c.title.includes('"Beta"')),
    ];
    if (!a || !b) throw new Error('a card per pull request expected');
    inbox.answer(a.id, { choice: 'Delete Branch' });
    inbox.answer(b.id, { choice: 'Keep' });
    await h.jobs.idle();
    expect(exists(first.batch.branch)).toBe(false);
    expect(exists(second.batch.branch)).toBe(true);
    expect(getInboxItem(h.store.db, a.id).state).toBe('RESOLVED');
  });
});

describe('a pull request that merged', () => {
  it('has its local branch deleted in the watch round that reads the merge', async () => {
    const { batch, tip, prUrl } = await shipped();
    h.gh.setState(prUrl, PrState.Merged);
    h.gh.setHead(prUrl, tip);
    const w = watch();
    w.start();
    await w.idle();
    expect(getBatch(h.store.db, batch.id).pr?.state).toBe('merged');
    expect(exists(batch.branch)).toBe(false);
    expect(h.cards()).toEqual([]);
  });

  it('leaves a branch that is checked out in the main checkout', async () => {
    const { batch, tip, prUrl } = await shipped();
    h.git$('switch', '-q', batch.branch ?? '');
    h.gh.setState(prUrl, PrState.Merged);
    h.gh.setHead(prUrl, tip);
    const w = watch();
    w.start();
    await w.idle();
    expect(exists(batch.branch)).toBe(true);
    // Switched away, the next round deletes it.
    h.git$('switch', '-q', 'main');
    w.poke();
    await w.idle();
    expect(exists(batch.branch)).toBe(false);
  });

  it('leaves a branch that holds a commit the pull request did not carry', async () => {
    const { batch, tip, prUrl } = await shipped();
    h.gh.setState(prUrl, PrState.Merged);
    h.gh.setHead(prUrl, tip);
    h.git$('update-ref', `refs/heads/${batch.branch ?? ''}`, h.commit('src/api/late.txt'));
    const w = watch();
    w.start();
    await w.idle();
    expect(exists(batch.branch)).toBe(true);
  });

  it('deletes a branch behind the pull request head, whose commits the pull request carried', async () => {
    const { batch, tip, prUrl } = await shipped();
    const head = h.git$('commit-tree', `${tip}^{tree}`, '-p', tip, '-m', 'a later commit');
    h.gh.setState(prUrl, PrState.Merged);
    h.gh.setHead(prUrl, head);
    const w = watch();
    w.start();
    await w.idle();
    expect(exists(batch.branch)).toBe(false);
  });

  it('leaves the branch when gh gives no head commit', async () => {
    const { batch, prUrl } = await shipped();
    h.gh.setState(prUrl, PrState.Merged);
    const w = watch();
    w.start();
    await w.idle();
    expect(exists(batch.branch)).toBe(true);
  });

  it('says on the kept-worktree card that the branch stays with the worktree', async () => {
    const { batch, ws } = await opened();
    await commitIn(batch, 'src/api/alpha.txt');
    writeFileSync(join(h.repo, '.git', 'info', 'exclude'), '.env\n');
    writeFileSync(join(batch.worktreePath ?? '', '.env'), 'SECRET=1\n');
    h.settle(ws.id, 'DONE');
    h.shipper.checkBatch(batch.id);
    await h.jobs.idle();
    const card = h.only(h.cards().filter((c) => c.title.includes('kept the worktree')));
    expect(card.body).toContain(
      `Its branch ${batch.branch ?? ''} is checked out there, so 10db leaves the branch too until the worktree is gone.`,
    );
  });

  it('never touches a branch it did not make', async () => {
    const { batch, tip, prUrl } = await shipped();
    h.git$('branch', 'feature/mine');
    h.git$('branch', '10db-mine');
    h.gh.setState(prUrl, PrState.Merged);
    h.gh.setHead(prUrl, tip);
    const w = watch();
    w.start();
    await w.idle();
    expect(exists(batch.branch)).toBe(false);
    expect(exists('feature/mine')).toBe(true);
    expect(exists('10db-mine')).toBe(true);
  });
});

describe('the sweep at startup', () => {
  it('removes the branch of a pull request already recorded as merged', async () => {
    const { batch, tip, prUrl } = await shipped();
    h.gh.setState(prUrl, PrState.Merged);
    h.gh.setHead(prUrl, tip);
    // The merge was recorded by an earlier daemon that stopped before it deleted the branch.
    const w = createPrWatch({ ctx: h.ctx, clock: new ManualClock(), intervalMs: 120_000 });
    watches.push(w);
    w.start();
    await w.idle();
    expect(exists(batch.branch)).toBe(true);
    await removeMergedBranches(h.ctx, new AbortController().signal);
    expect(exists(batch.branch)).toBe(false);
  });

  it('keeps the branch of a pull request that is still open', async () => {
    const { batch } = await shipped();
    await removeMergedBranches(h.ctx, new AbortController().signal);
    expect(exists(batch.branch)).toBe(true);
  });

  it('lists in one card every 10db branch no batch names, and deletes none', async () => {
    h.git$('branch', '10db/stray-one');
    h.git$('branch', '10db/stray-two');
    h.git$('branch', 'feature/mine');
    const { batch } = await opened();
    await listStrayBranches(h.ctx);
    await listStrayBranches(h.ctx);
    const card = h.only(h.cards());
    expect(card.title).toBe('2 local branches under 10db/ without a task');
    expect(card.body).toContain('10db/stray-one');
    expect(card.body).toContain('10db/stray-two');
    expect(card.body).not.toContain('feature/mine');
    expect(card.body).not.toContain(batch.branch ?? '?');
    expect(exists('10db/stray-one')).toBe(true);
    expect(exists('10db/stray-two')).toBe(true);
  });

  /**
   * An abandoned batch whose worktree is gone but whose branch was never settled: abandoned by a
   * daemon before branch cleanup, or in a shared checkout whose settle failed.
   */
  async function unsettled(commits: number): Promise<BatchDto> {
    const { batch, ws } = await opened();
    for (let i = 0; i < commits; i++) await commitIn(batch, `src/api/${String(i)}.txt`);
    h.settle(ws.id, 'DONE');
    await h.git.removeWorktree(h.repo, batch.worktreePath ?? '');
    h.state.write((w) => {
      transitionBatch(w, batch.id, { to: 'ABANDONED' });
      clearWorktreePath(w, batch.id);
    });
    expect(exists(batch.branch)).toBe(true);
    return getBatch(h.store.db, batch.id);
  }

  it('offers once to delete an abandoned branch that holds commits, and not again after Keep', async () => {
    const batch = await unsettled(2);
    await recover();
    await recover();
    const card = h.only(cardsAbout(batch.branch));
    expect(card.title).toBe(`Delete ${batch.branch ?? ''}? It holds 2 commits`);
    expect(card.options.map((o) => o.label)).toEqual(['Delete Branch', 'Keep']);
    inbox.answer(card.id, { choice: 'Keep' });
    await h.jobs.idle();
    await recover();
    expect(cardsAbout(batch.branch)).toEqual([]);
    expect(exists(batch.branch)).toBe(true);
  });

  it('deletes an abandoned branch that never moved off its base, without a card', async () => {
    const batch = await unsettled(0);
    await recover();
    expect(exists(batch.branch)).toBe(false);
    expect(h.cards()).toEqual([]);
  });

  it('leaves an abandoned batch whose branch is gone alone', async () => {
    const batch = await unsettled(1);
    h.git$('branch', '-D', batch.branch ?? '');
    await recover();
    expect(h.cards()).toEqual([]);
  });

  it('raises no card when every 10db branch has a batch, and withdraws an old one', async () => {
    h.git$('branch', '10db/stray');
    await listStrayBranches(h.ctx);
    expect(h.cards()).toHaveLength(1);
    h.git$('branch', '-D', '10db/stray');
    await listStrayBranches(h.ctx);
    expect(h.cards()).toEqual([]);
  });
});

describe('a closed batch whose branch moved off its base', () => {
  it('keeps the branch without a card, as before', async () => {
    const { batch } = await opened();
    await commitIn(batch, 'src/api/late.txt');
    h.state.write((c) => {
      transitionBatch(c, batch.id, { to: 'SHIPPING' });
      transitionBatch(c, batch.id, { to: 'CLOSED' });
    });
    await retireWorktree(h.ctx, batch.id);
    expect(exists(batch.branch)).toBe(true);
    expect(cardsAbout(batch.branch)).toEqual([]);
  });
});
