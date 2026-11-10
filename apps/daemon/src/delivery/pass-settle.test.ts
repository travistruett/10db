import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AbandonStep,
  PASS_MOVE_CHOICE,
  PASS_RETARGET_CHOICE,
  PassNoticeKind,
  PassState,
  type InboxItemDto,
  type PassId,
  type ProjectInput,
} from '@10db/contracts';
import {
  abandonPassAndBatch,
  closePass,
  findOpenByFoldKey,
  getBatch,
  getPass,
  getPassProgress,
  getTask,
  passHoldingFolder,
  setAbandonStep,
  setClosePlan,
  setPassPullRequest,
  transitionBatch,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { ManualClock } from '../clock';
import { PrState } from '../github';
import {
  answerPassMoveCard,
  createPrWatch,
  openPass,
  removeMergedBranches,
  resumePassSettles,
  subscribePassSettles,
  type PrWatch,
  type PutBackKeptWork,
} from './index';
import { passPrBase } from './pass-pr';
import { settleClosedPass } from './pass-settle';
import { passMoveKey } from './pass-stack';

// Workbench spec §5.3, §5.4, D22, call 29: a closed pass on a pull request project settles when its
// pull request merges with the base's tree its tip, and otherwise offers one card, Move <branch> to
// origin/<base>, which the builder may also take before the merge. Nothing is forced.

const PAGES: Partial<ProjectInput> = {
  areas: [
    { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
    { name: 'people', globs: ['src/people/**'], role: 'page', route: '/people' },
  ],
};

const nothingKept: PutBackKeptWork = () => Promise.resolve({ applied: [], left: [] });

let h: DeliveryHarness;
let w: PrWatch | null = null;
let unsubscribe: () => void = () => undefined;
afterEach(async () => {
  unsubscribe();
  await w?.stop();
  w = null;
  h.close();
});

interface Closed {
  readonly passId: PassId;
  readonly url: string;
  /** The pass's tip, where the close left `main`. */
  readonly tip: string;
  readonly branch: string;
}

function write(path: string, content: string): void {
  const file = join(h.repo, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const read = (path: string): string => readFileSync(join(h.repo, path), 'utf8');

/**
 * A pass closed as slice 7a's close leaves one: its page signed off on its branch, pushed, its pull
 * request ready, `main` fast-forwarded to its tip and the folder on `main` (D8), the pass CLOSED and
 * its batch SHIPPED.
 */
async function closedPass(): Promise<Closed> {
  h = createDeliveryHarness(PAGES);
  unsubscribe = subscribePassSettles(h.bus, h.ctx);
  h.commit('src/settings/page.tsx', 'settings\n');
  h.git$('push', '-q', 'origin', 'main');
  const start = h.git$('rev-parse', 'HEAD');
  const task = h.addTask('Settings page', { areas: ['settings'] });
  const opened = await openPass(
    h.ctx,
    { projectId: h.project.id, name: 'Polish pages', taskIds: [task.id] },
    { leaseMs: 60_000, putBack: nothingKept },
  );
  const branch = opened.batch.branch ?? '';
  const tip = h.commit('src/settings/page.tsx', 'signed off\n');
  const run = getTask(h.store.db, task.id).workstreamId;
  if (run !== null) h.settle(run, 'DONE');
  h.git$('push', '-q', 'origin', branch);
  const url = h.gh.openPr(branch, PrState.Open, 'main');
  h.git$('update-ref', 'refs/heads/main', tip, start);
  h.git$('symbolic-ref', 'HEAD', 'refs/heads/main');
  h.state.write((ctx) => {
    setPassPullRequest(ctx, opened.pass.id, { url, draft: false });
    setClosePlan(ctx, opened.pass.id, { token: 't', pages: [], files: [], shared: [] });
    transitionBatch(ctx, opened.batch.id, { to: 'SHIPPING' });
    transitionBatch(ctx, opened.batch.id, { to: 'SHIPPED' });
    closePass(ctx, opened.pass.id, { settled: false });
  });
  await h.jobs.idle();
  return { passId: opened.pass.id, url, tip, branch };
}

/** The base on origin as a squash merge of the pull request leaves it: the pass's tip's tree. */
function squashOnOrigin(tip: string): string {
  return h.origin$('commit-tree', '-p', 'main', '-m', 'squash', `${tip}^{tree}`);
}

/** The pass's open Move cards: at most one, by its fold key. */
const moveCards = (passId: PassId): InboxItemDto[] => {
  const open = findOpenByFoldKey(h.store.db, h.project.id, passMoveKey(passId));
  const all = h
    .cards()
    .filter((c) => c.detail?.['kind'] === 'pass_move' && c.detail['passId'] === passId);
  expect(all.map((c) => c.id)).toEqual(open ? [open.id] : []);
  return all;
};

async function watchRound(): Promise<void> {
  w ??= createPrWatch({ ctx: h.ctx, clock: new ManualClock(), intervalMs: 120_000 });
  w.start();
  await w.idle();
  await h.jobs.idle();
}

function answerMove(card: InboxItemDto): Promise<void> {
  answerPassMoveCard(h.ctx, card, { choice: PASS_MOVE_CHOICE });
  return h.jobs.idle();
}

describe('a closed pass', () => {
  it('offers Move as it closes, and Move before the merge puts the folder on the base and settles it', async () => {
    const { passId } = await closedPass();
    const card = h.only(moveCards(passId));
    expect(card).toMatchObject({
      title: 'Move main to origin/main',
      detail: expect.objectContaining({ kind: 'pass_move', reason: 'closed' }) as unknown,
    });
    expect(passHoldingFolder(h.store.db, h.project.id)?.id).toBe(passId);

    await answerMove(card);

    expect(getPass(h.store.db, passId).state).toBe(PassState.Settled);
    expect(h.git$('rev-parse', 'refs/heads/main')).toBe(h.git$('rev-parse', 'origin/main'));
    expect(read('src/settings/page.tsx')).toBe('settings\n');
    expect(moveCards(passId)).toEqual([]);
    expect(passHoldingFolder(h.store.db, h.project.id)).toBeUndefined();
  });

  it.each([
    {
      name: 'an uncommitted change where the move writes',
      arrange: () => {
        write('src/settings/page.tsx', 'mine\n');
      },
      says: 'uncommitted changes lie where the move writes: src/settings/page.tsx',
    },
    {
      name: 'a commit of the builder’s own on the branch',
      arrange: () => {
        h.commit('notes.md', 'mine\n');
      },
      says: 'holds 1 commit of your own',
    },
  ])('refuses Move, saying so on the card, for $name', async ({ arrange, says }) => {
    const { passId } = await closedPass();
    arrange();
    const before = h.git$('rev-parse', 'refs/heads/main');

    await answerMove(h.only(moveCards(passId)));

    expect(getPass(h.store.db, passId).state).toBe(PassState.Closed);
    expect(h.git$('rev-parse', 'refs/heads/main')).toBe(before);
    expect(h.only(moveCards(passId)).body).toContain(says);
  });

  it('realigns with no file changed when its pull request merges and the trees match', async () => {
    const { passId, url, tip } = await closedPass();
    const squash = squashOnOrigin(tip);
    h.origin$('update-ref', 'refs/heads/main', squash);
    h.gh.setState(url, PrState.Merged);
    write('notes.md', 'left in the folder\n');

    await watchRound();

    expect(getPass(h.store.db, passId).state).toBe(PassState.Settled);
    expect(h.git$('rev-parse', 'refs/heads/main')).toBe(squash);
    expect(h.git$('symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    expect(h.git$('status', '--porcelain')).toBe('?? notes.md');
    expect(moveCards(passId)).toEqual([]);
  });

  it.each([
    {
      name: 'drift: the base holds more than the pass',
      act: (c: Closed) => {
        h.teammatePush('main', 'src/people/page.tsx', 'people\n');
        h.gh.setState(c.url, PrState.Merged);
      },
      reason: 'drift',
    },
    {
      name: 'its pull request closed without merging',
      act: (c: Closed) => {
        h.gh.setState(c.url, PrState.Closed);
      },
      reason: 'closed_unmerged',
    },
  ])('moves nothing and rewords its card for $name', async ({ act, reason }) => {
    const c = await closedPass();
    act(c);

    await watchRound();

    expect(getPass(h.store.db, c.passId).state).toBe(PassState.Closed);
    expect(h.git$('rev-parse', 'refs/heads/main')).toBe(c.tip);
    expect(h.only(moveCards(c.passId)).detail).toMatchObject({ reason });
  });

  it("keeps a closed pass's branch through the merged-branch sweep, so Move after drift still settles it", async () => {
    const c = await closedPass();
    h.teammatePush('main', 'src/people/page.tsx', 'people\n');
    h.gh.setState(c.url, PrState.Merged);
    h.gh.setHead(c.url, c.tip);
    await watchRound();
    expect(h.only(moveCards(c.passId)).detail).toMatchObject({ reason: 'drift' });

    await removeMergedBranches(h.ctx, new AbortController().signal);

    expect(h.git$('rev-parse', `refs/heads/${c.branch}`)).toBe(c.tip);
    expect(h.git$('rev-parse', `refs/remotes/origin/${c.branch}`)).toBe(c.tip);
    await answerMove(h.only(moveCards(c.passId)));
    expect(getPass(h.store.db, c.passId).state).toBe(PassState.Settled);
  });

  it('after a restart, raises no second card, keeps the folder held, and realigns when the merge is read', async () => {
    const { passId, url, tip } = await closedPass();
    const first = h.only(moveCards(passId));
    // A restart, twice over, looks at the pass again: the card it raised at the close is the one.
    resumePassSettles(h.ctx);
    resumePassSettles(h.ctx);
    await h.jobs.idle();
    expect(h.only(moveCards(passId)).id).toBe(first.id);
    expect(passHoldingFolder(h.store.db, h.project.id)?.id).toBe(passId);

    h.origin$('update-ref', 'refs/heads/main', squashOnOrigin(tip));
    h.gh.setState(url, PrState.Merged);
    await watchRound();
    await settleClosedPass(h.ctx, passId, new AbortController().signal);

    expect(getPass(h.store.db, passId).state).toBe(PassState.Settled);
    expect(moveCards(passId)).toEqual([]);
  });
});

describe('a pass stacked on a closed one (D24)', () => {
  /** Pass B, opened on closed pass A: its page signed off and pushed, its pull request on A's branch. */
  async function stacked(a: Closed) {
    const task = h.addTask('People page', { areas: ['people'] });
    const opened = await openPass(
      h.ctx,
      { projectId: h.project.id, name: 'More pages', taskIds: [task.id] },
      { leaseMs: 60_000, putBack: nothingKept },
    );
    await h.jobs.idle();
    const branch = opened.batch.branch ?? '';
    const tip = h.commit('src/people/page.tsx', 'people\n');
    h.git$('push', '-q', 'origin', branch);
    const url = h.gh.openPr(branch, PrState.Open, a.branch);
    h.state.write((ctx) => {
      setPassPullRequest(ctx, opened.pass.id, { url, draft: true });
    });
    return { passId: opened.pass.id, start: opened.pass.startSha, branch, tip, url };
  }

  const edits = (url: string) =>
    h.gh.calls.filter(
      (c) => c.method === 'prEditBase' && (c.args as { readonly url: string }).url === url,
    );

  it("opens at the closed pass's tip, targets its branch, and the closed pass's Move card waits", async () => {
    const a = await closedPass();
    expect(moveCards(a.passId)).toHaveLength(1);

    const b = await stacked(a);

    expect(getPassProgress(h.store.db, b.passId).stackedOn).toBe(a.passId);
    expect(b.start).toBe(a.tip);
    expect(passPrBase(h.store.db, getPass(h.store.db, b.passId))).toBe(a.branch);
    expect(moveCards(a.passId)).toEqual([]);
  });

  it('when the closed pass merges with matching trees: it settles, the stacked one is retargeted and takes the base by one merge that changes no file, once', async () => {
    const a = await closedPass();
    const b = await stacked(a);
    const squash = squashOnOrigin(a.tip);
    h.origin$('update-ref', 'refs/heads/main', squash);
    h.gh.setState(a.url, PrState.Merged);
    // As a daemon that retargeted and stopped before the merge left it: each step is checked first.
    await h.gh.prEditBase({ repo: 'acme/widgets', url: b.url, base: 'main' });

    await watchRound();
    await settleClosedPass(h.ctx, a.passId, new AbortController().signal);

    expect(getPass(h.store.db, a.passId).state).toBe(PassState.Settled);
    expect(edits(b.url)).toHaveLength(1);
    const head = h.git$('rev-parse', `refs/heads/${b.branch}`);
    expect(h.git$('rev-parse', `${head}^1`, `${head}^2`)).toBe(`${b.tip}\n${squash}`);
    expect(h.git$('rev-parse', `${head}^{tree}`)).toBe(h.git$('rev-parse', `${b.tip}^{tree}`));
    expect(h.origin$('rev-parse', `refs/heads/${b.branch}`)).toBe(head);
    expect(h.git$('status', '--porcelain')).toBe('');
    expect(passPrBase(h.store.db, getPass(h.store.db, b.passId))).toBe('main');
  });

  it('when the closed pass merges after the stacked one has closed too: it still retargets it, takes the base in and keeps the folder on the tip', async () => {
    const a = await closedPass();
    const b = await stacked(a);
    // B closes as 7a's close leaves it: main fast-forwarded from A's tip to B's, the folder on main.
    const batchOf = getPass(h.store.db, b.passId).batchId;
    h.git$('update-ref', 'refs/heads/main', b.tip, a.tip);
    h.git$('symbolic-ref', 'HEAD', 'refs/heads/main');
    h.state.write((ctx) => {
      setClosePlan(ctx, b.passId, { token: 't', pages: [], files: [], shared: [] });
      transitionBatch(ctx, batchOf, { to: 'SHIPPING' });
      transitionBatch(ctx, batchOf, { to: 'SHIPPED' });
      closePass(ctx, b.passId, { settled: false });
    });
    await h.jobs.idle();
    const squash = squashOnOrigin(a.tip);
    h.origin$('update-ref', 'refs/heads/main', squash);
    h.gh.setState(a.url, PrState.Merged);

    await watchRound();

    expect(getPass(h.store.db, a.passId).state).toBe(PassState.Settled);
    expect(moveCards(a.passId)).toEqual([]);
    expect(edits(b.url)).toHaveLength(1);
    const head = h.git$('rev-parse', `refs/heads/${b.branch}`);
    expect(h.git$('rev-parse', `${head}^2`)).toBe(squash);
    expect(h.git$('rev-parse', 'refs/heads/main')).toBe(head);
    expect(h.git$('status', '--porcelain')).toBe('');
  });

  it('when the closed pass closes unmerged: the stacked one says so and offers Retarget, which bases its pull request on the base', async () => {
    const a = await closedPass();
    const b = await stacked(a);
    h.gh.setState(a.url, PrState.Closed);

    await watchRound();

    const card = h.only(h.cards().filter((c) => c.detail?.['kind'] === 'pass_retarget'));
    expect(getPassProgress(h.store.db, b.passId).notices).toEqual([
      expect.objectContaining({ kind: PassNoticeKind.StackUnmerged, cardId: card.id }),
    ]);
    expect(edits(b.url)).toEqual([]);

    answerPassMoveCard(h.ctx, card, { choice: PASS_RETARGET_CHOICE });
    await h.jobs.idle();

    expect(edits(b.url)).toHaveLength(1);
    expect(getPassProgress(h.store.db, b.passId).notices).toEqual([]);
    expect(h.git$('rev-parse', `refs/heads/${b.branch}`)).toBe(b.tip);
  });

  it('when the stacked pass is abandoned at its start, the closed pass offers Move again', async () => {
    const a = await closedPass();
    const task = h.addTask('People page', { areas: ['people'] });
    const opened = await openPass(
      h.ctx,
      { projectId: h.project.id, name: 'More pages', taskIds: [task.id] },
      { leaseMs: 60_000, putBack: nothingKept },
    );
    await h.jobs.idle();
    expect(moveCards(a.passId)).toEqual([]);

    h.state.write((ctx) => {
      setAbandonStep(ctx, opened.pass.id, AbandonStep.Abandoning);
      abandonPassAndBatch(ctx, opened.pass.id);
    });
    await h.jobs.idle();

    expect(getBatch(h.store.db, opened.batch.id).state).toBe('ABANDONED');
    expect(h.only(moveCards(a.passId)).detail).toMatchObject({ reason: 'closed' });
  });
});
