import {
  findOpenByFoldKey,
  getBatch,
  insertBatch,
  listEventsAfter,
  listWorkstreams,
  seedProject,
  setBatchNotice,
  transitionBatch,
} from '@10db/db';
import type { BatchId, ProjectId } from '@10db/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { waitFor } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { GhError, UNREADABLE_CHECK, type CheckRollupItem, type Gh } from '../github';
import { createInboxService } from '../inbox';
import { GH_CHECK_CHOICE, prCardKey } from './cards';
import { raiseIn } from './context';
import { createGhCardAnswers, createPrWatch, subscribePrWatch, type PrWatch } from './index';
import { baseNotices } from './notices';

const INTERVAL = 120_000;

let h: DeliveryHarness;
let clock: ManualClock;
const watches: PrWatch[] = [];
afterEach(async () => {
  for (const w of watches.splice(0)) await w.stop();
  h.close();
});

function setup(): void {
  h = createDeliveryHarness();
  clock = new ManualClock();
}

function watcher(ctx = h.ctx): PrWatch {
  const w = createPrWatch({ ctx, clock, intervalMs: INTERVAL });
  watches.push(w);
  return w;
}

/** A check run; its link names the check unless `url` says which run it is. */
const run = (
  name: string,
  conclusion: string | null,
  url = `https://github.com/acme/widgets/actions/runs/${name}`,
): CheckRollupItem => ({
  __typename: 'CheckRun',
  name,
  status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
  conclusion,
  detailsUrl: url,
});

/** A SHIPPED batch with a pull request, as shipping leaves one. */
function shipped(
  projectId: ProjectId,
  title: string,
  /** A url GitHub has no pull request for; by default the batch's pull request exists. */
  missing?: string,
  /** Whether the batch asked to be merged by itself, as batches do by default. */
  autoMerge = true,
): { id: BatchId; prUrl: string } {
  const prUrl = missing ?? h.gh.openPr(`10db/${title}`);
  const id = h.state.write((ctx) =>
    insertBatch(ctx, {
      projectId,
      title,
      baseBranch: 'main',
      autoMerge,
      worktreePath: `/tmp/wt/${title}`,
    }),
  ).id;
  for (const to of ['OPEN', 'SHIPPING'] as const)
    h.state.write((ctx) => transitionBatch(ctx, id, { to }));
  h.state.write((ctx) =>
    transitionBatch(ctx, id, {
      to: 'SHIPPED',
      patch: { repo: 'acme/widgets', prUrl, branch: `10db/${title}` },
    }),
  );
  return { id, prUrl };
}

const pr = (id: BatchId) => getBatch(h.store.db, id).pr;
const prEvents = (id: BatchId) =>
  listEventsAfter(h.store.db, 0, 10_000).filter(
    (e) =>
      e.type === 'batch.updated' &&
      e.entityId === id &&
      JSON.stringify(e.data) === JSON.stringify({ changed: ['pr'] }),
  );

const notices = (id: BatchId) => getBatch(h.store.db, id).notices.map((n) => n.key);
const noticeEvents = (id: BatchId) =>
  listEventsAfter(h.store.db, 0, 10_000).filter(
    (e) =>
      e.type === 'batch.updated' &&
      e.entityId === id &&
      JSON.stringify(e.data) === JSON.stringify({ changed: ['notices'] }),
  ).length;

const polls = () => h.gh.calls.filter((c) => c.method === 'prStatus').length;
/** How many times gh was asked for this pull request's status. */
const reads = (prUrl: string) =>
  h.gh.calls.filter(
    (c) => c.method === 'prStatus' && (c.args as { readonly ref: string }).ref === prUrl,
  ).length;
const TIMEOUT = 'gh pr view gave no answer within 120 s';
/** The inbox refuses every new card from now on, as a full disk would. */
const refuseCards = () => {
  h.store.db.$client.exec(
    "CREATE TRIGGER refuse_cards BEFORE INSERT ON inbox_items BEGIN SELECT RAISE(ABORT, 'disk full'); END",
  );
};
const allowCards = () => {
  h.store.db.$client.exec('DROP TRIGGER refuse_cards');
};
const round = async (w: PrWatch, ms = INTERVAL) => {
  clock.advance(ms);
  await w.idle();
};

describe('the pull request watch', () => {
  it('polls on the clock: pending, then passing, then merged and no more polls', async () => {
    setup();
    const { id, prUrl } = shipped(h.project.id, 'Alpha');
    h.gh.setChecks(prUrl, [run('build', null)]);
    const w = watcher();
    w.start();
    await w.idle();
    expect(pr(id)).toMatchObject({ state: 'open', checks: 'pending', unknownReason: null });
    expect(polls()).toBe(1);

    await round(w, INTERVAL - 1);
    expect(polls()).toBe(1);

    h.gh.setChecks(prUrl, [run('build', 'SUCCESS')]);
    await round(w, 1);
    expect(pr(id)).toMatchObject({ state: 'open', checks: 'passing' });

    h.gh.setState(prUrl, 'MERGED');
    await round(w);
    expect(pr(id)).toMatchObject({ state: 'merged', checks: 'passing' });
    const before = polls();
    await round(w, INTERVAL * 5);
    expect(polls()).toBe(before);
    expect(h.cards()).toEqual([]);
  });

  it('poke reads now, and a poke during a round queues exactly one more', async () => {
    setup();
    const { id, prUrl } = shipped(h.project.id, 'Alpha');
    const w = watcher();
    w.start();
    await w.idle();
    h.gh.setChecks(prUrl, [run('build', 'SUCCESS')]);
    w.poke();
    w.poke();
    w.poke();
    await w.idle();
    expect(pr(id)?.checks).toBe('passing');
    expect(polls()).toBe(3);
  });

  it('raises one card for failing checks, naming the check and linking it, and withdraws it on passing', async () => {
    setup();
    const { id, prUrl } = shipped(h.project.id, 'Alpha');
    h.gh.setChecks(prUrl, [
      run('build', 'SUCCESS'),
      run('lint', 'FAILURE'),
      run('test', 'TIMED_OUT'),
    ]);
    const w = watcher();
    w.start();
    await w.idle();

    const card = h.only(h.cards());
    const lintUrl = 'https://github.com/acme/widgets/actions/runs/lint';
    expect(card.title).toBe('Pull request checks failed for "Alpha": lint and 1 more');
    expect(card.body.startsWith(lintUrl)).toBe(true);
    expect(card.body).toContain('https://github.com/acme/widgets/actions/runs/test');
    expect(card.body).toContain(prUrl);
    expect(card.detail).toEqual({ batchId: id, prUrl, link: lintUrl });
    expect(pr(id)).toMatchObject({ checks: 'failing' });

    await round(w);
    await round(w);
    expect(h.cards()).toHaveLength(1);

    h.gh.setChecks(prUrl, [run('build', 'SUCCESS'), run('lint', 'SUCCESS')]);
    await round(w);
    expect(h.cards()).toEqual([]);
  });

  it('keeps the open card naming the checks that fail now, and a dismissed card dismissed', async () => {
    setup();
    const { id, prUrl } = shipped(h.project.id, 'Alpha');
    h.gh.setChecks(prUrl, [run('lint', 'FAILURE'), run('test', 'FAILURE')]);
    const w = watcher();
    w.start();
    await w.idle();
    const first = h.only(h.cards());
    expect(first.title).toBe('Pull request checks failed for "Alpha": lint and 1 more');

    // lint passes now and test still fails: the same card names test and links its run.
    const testUrl = 'https://github.com/acme/widgets/actions/runs/test';
    h.gh.setChecks(prUrl, [run('lint', 'SUCCESS'), run('test', 'FAILURE')]);
    await round(w);
    const card = h.only(h.cards());
    expect(card.id).toBe(first.id);
    expect(card.title).toBe('Pull request checks failed for "Alpha": test');
    expect(card.body.startsWith(testUrl)).toBe(true);
    expect(card.body).not.toContain('runs/lint');
    expect(card.detail).toEqual({ batchId: id, prUrl, link: testUrl });

    // A new commit fails test again, in a new run: the card links that run.
    const rerun = 'https://github.com/acme/widgets/actions/runs/test-2';
    h.gh.setChecks(prUrl, [run('test', 'FAILURE', rerun)]);
    await round(w);
    expect(h.only(h.cards())).toMatchObject({
      id: first.id,
      title: 'Pull request checks failed for "Alpha": test',
      detail: { link: rerun },
    });

    // Dismissed, it stays dismissed however the failing checks change.
    h.inbox.answer(first.id, { choice: 'dismissed' });
    h.gh.setChecks(prUrl, [run('lint', 'FAILURE'), run('test', 'FAILURE', rerun)]);
    await round(w);
    expect(h.cards()).toEqual([]);
  });

  it('brings the open card up to date when checks fail again after a pending run', async () => {
    setup();
    const { prUrl } = shipped(h.project.id, 'Alpha');
    h.gh.setChecks(prUrl, [run('lint', 'FAILURE')]);
    const w = watcher();
    w.start();
    await w.idle();
    const first = h.only(h.cards());

    // A push starts the run again: pending leaves the card open.
    h.gh.setChecks(prUrl, [run('lint', null)]);
    await round(w);
    expect(h.only(h.cards()).id).toBe(first.id);

    const rerun = 'https://github.com/acme/widgets/actions/runs/lint-2';
    h.gh.setChecks(prUrl, [run('lint', 'FAILURE', rerun), run('test', 'FAILURE')]);
    await round(w);
    expect(h.only(h.cards())).toMatchObject({
      id: first.id,
      title: 'Pull request checks failed for "Alpha": lint and 1 more',
      detail: { link: rerun },
    });
  });

  it('writes the open card only when what it says changes', async () => {
    setup();
    const { prUrl } = shipped(h.project.id, 'Alpha');
    h.gh.setChecks(prUrl, [run('lint', 'FAILURE')]);
    const w = watcher();
    w.start();
    await w.idle();
    const card = h.only(h.cards());
    const writes = () =>
      listEventsAfter(h.store.db, 0, 10_000).filter(
        (e) => e.type === 'inbox.changed' && e.entityId === card.id,
      ).length;
    const before = writes();
    await round(w);
    await round(w);
    expect(writes()).toBe(before);
  });

  it('falls back to the pull request link when the failing check has none', async () => {
    setup();
    const { id, prUrl } = shipped(h.project.id, 'Alpha');
    h.gh.setChecks(prUrl, [
      { __typename: 'StatusContext', context: 'ci/deploy', state: 'ERROR', targetUrl: null },
    ]);
    const w = watcher();
    w.start();
    await w.idle();
    const card = h.only(h.cards());
    expect(card.title).toBe('Pull request checks failed for "Alpha": ci/deploy');
    expect(card.body.startsWith(prUrl)).toBe(true);
    expect(card.detail).toEqual({ batchId: id, prUrl, link: prUrl });
  });

  it('raises one card for a pull request closed without merging, withdraws the checks card, and stops polling', async () => {
    setup();
    const { id, prUrl } = shipped(h.project.id, 'Alpha');
    h.gh.setChecks(prUrl, [run('build', 'FAILURE')]);
    const w = watcher();
    w.start();
    await w.idle();
    expect(h.cards()).toHaveLength(1);

    h.gh.setState(prUrl, 'CLOSED');
    await round(w);
    const card = h.only(h.cards());
    expect(card.title).toBe('Pull request closed without merging: "Alpha"');
    expect(card.body).toContain(prUrl);
    expect(card.body).toContain('main');
    expect(card.body).toContain('10db/Alpha');
    // The tasks are in Blocked, where the builder reopens or closes them; reopening the pull request
    // on GitHub is not followed, and the local branch stays until the builder answers.
    expect(card.body).toContain('in Blocked on the Board');
    expect(card.body).toContain('reopen a task to run it again, or close it');
    expect(card.body).toContain('reopen the pull request on GitHub and merge it');
    expect(card.body).toContain("10db doesn't follow a reopened pull request");
    expect(card.body).toContain('keeps the local branch 10db/Alpha until you answer');
    expect(card.body).not.toContain('new batch');
    expect(card.options.map((o) => o.label)).toEqual(['Delete Branch', 'Keep']);
    expect(card.detail).toEqual({ batchId: id, prUrl, link: prUrl, branchCard: { batchId: id } });
    expect(pr(id)).toMatchObject({ state: 'closed' });
    expect(findOpenByFoldKey(h.store.db, h.project.id, `pr-closed:${id}`)).toBeDefined();
    expect(findOpenByFoldKey(h.store.db, h.project.id, `pr-checks:${id}`)).toBeUndefined();

    const before = polls();
    await round(w, INTERVAL * 4);
    expect(polls()).toBe(before);
    expect(h.cards()).toHaveLength(1);
  });

  it('clears the conflict notice once GitHub says the pull request merges cleanly, with no card', async () => {
    setup();
    const { id, prUrl } = shipped(h.project.id, 'Alpha');
    h.state.write((w) => {
      setBatchNotice(w, id, baseNotices.shippedConflict(getBatch(w.tx, id)));
    });
    h.gh.setMergeable(prUrl, 'CONFLICTING');
    const w = watcher();
    w.start();
    await w.idle();
    expect(notices(id)).toEqual(['base-conflict']);

    // GitHub is still working it out after Update branch: the notice stays.
    h.gh.setMergeable(prUrl, 'UNKNOWN');
    await round(w);
    expect(notices(id)).toEqual(['base-conflict']);

    h.gh.setMergeable(prUrl, 'MERGEABLE');
    await round(w);
    expect(notices(id)).toEqual([]);
    expect(h.cards()).toEqual([]);
  });

  it('shows a conflict that comes up after shipping on the tasks, once, and keeps a notice it already has', async () => {
    setup();
    const { id, prUrl } = shipped(h.project.id, 'Alpha');
    const w = watcher();
    w.start();
    await w.idle();
    expect(notices(id)).toEqual([]);

    h.gh.setMergeable(prUrl, 'CONFLICTING');
    await round(w);
    expect(getBatch(h.store.db, id).notices).toEqual([
      baseNotices.shippedConflict(getBatch(h.store.db, id)),
    ]);
    const written = noticeEvents(id);
    await round(w);
    await round(w);
    expect(noticeEvents(id)).toBe(written);
    expect(h.cards()).toEqual([]);
  });

  describe('a pull request 10db lands', () => {
    /** A watch whose landing is a spy: what it was asked, in order. */
    function landing(): { asked: string[]; watch: PrWatch } {
      const asked: string[] = [];
      const watch = createPrWatch({
        ctx: h.ctx,
        clock,
        intervalMs: INTERVAL,
        landing: {
          catchUp: (id) => asked.push(`catch-up ${id}`),
          restartCi: (id) => {
            asked.push(`restart-ci ${id}`);
            return true;
          },
          retryMerge: (id, opts) =>
            asked.push(opts?.catchUpCardWasOpen ? `retry ${id} after card` : `retry ${id}`),
        },
      });
      watches.push(watch);
      return { asked, watch };
    }

    it('asks for the base to be merged into it when it conflicts, and shows no notice that says to resolve it by hand', async () => {
      setup();
      const { id, prUrl } = shipped(h.project.id, 'Alpha');
      h.gh.setMergeable(prUrl, 'CONFLICTING');
      h.gh.setMergeBlocked(prUrl, 'conflicts');
      const { asked, watch } = landing();
      watch.start();
      await watch.idle();
      expect(asked).toEqual([`catch-up ${id}`]);
      expect(notices(id)).toEqual([]);
      expect(h.cards()).toEqual([]);
    });

    it('asks for a refused merge to be retried once GitHub says it is clean, not while it conflicts', async () => {
      setup();
      const { id, prUrl } = shipped(h.project.id, 'Alpha');
      const { asked, watch } = landing();
      watch.start();
      await watch.idle();
      expect(asked).toEqual([`retry ${id}`]);

      h.gh.setMergeable(prUrl, 'UNKNOWN');
      await round(watch);
      expect(asked).toEqual([`retry ${id}`]);
    });

    it('asks nothing of a pull request the builder merges by hand, and keeps saying it conflicts', async () => {
      setup();
      const { id, prUrl } = shipped(h.project.id, 'Alpha', undefined, false);
      h.gh.setMergeable(prUrl, 'CONFLICTING');
      const { asked, watch } = landing();
      watch.start();
      await watch.idle();
      expect(asked).toEqual([]);
      expect(notices(id)).toEqual(['base-conflict']);
    });

    it('withdraws the catch-up card once the pull request merges cleanly', async () => {
      setup();
      const { id, prUrl } = shipped(h.project.id, 'Alpha');
      h.gh.setMergeable(prUrl, 'CONFLICTING');
      const { watch } = landing();
      watch.start();
      await watch.idle();
      h.state.write((w) => {
        raiseIn(w, h.project.id, {
          title: 'Pull request conflicts',
          body: 'x',
          foldKey: prCardKey.catchUp(id),
        });
      });
      expect(h.cards()).toHaveLength(1);
      h.gh.setMergeable(prUrl, 'MERGEABLE');
      await round(watch);
      expect(h.cards()).toEqual([]);
    });

    it('says the catch-up card was open when it asks for the merge in the round that withdraws it', async () => {
      setup();
      const { id, prUrl } = shipped(h.project.id, 'Alpha');
      h.gh.setMergeable(prUrl, 'CONFLICTING');
      h.gh.setMergeBlocked(prUrl, 'conflicts');
      const { asked, watch } = landing();
      watch.start();
      await watch.idle();
      h.state.write((w) => {
        raiseIn(w, h.project.id, {
          title: 'Pull request conflicts',
          body: 'x',
          foldKey: prCardKey.catchUp(id),
        });
      });
      h.gh.setMergeable(prUrl, 'MERGEABLE');
      h.gh.setMergeBlocked(prUrl, null);
      await round(watch);
      await round(watch);
      expect(asked).toEqual([`catch-up ${id}`, `retry ${id} after card`, `retry ${id}`]);
      expect(h.cards()).toEqual([]);
    });
  });

  it('withdraws the checks card when the pull request merges', async () => {
    setup();
    const { prUrl } = shipped(h.project.id, 'Alpha');
    h.gh.setChecks(prUrl, [run('build', 'FAILURE')]);
    const w = watcher();
    w.start();
    await w.idle();
    expect(h.cards()).toHaveLength(1);
    h.gh.setState(prUrl, 'MERGED');
    await round(w);
    expect(h.cards()).toEqual([]);
  });

  it('withdraws the checks card for no checks only when two reads in a row find none', async () => {
    setup();
    const { id, prUrl } = shipped(h.project.id, 'Alpha');
    h.gh.setChecks(prUrl, [run('lint', 'FAILURE')]);
    const w = watcher();
    w.start();
    await w.idle();
    const card = h.only(h.cards());

    // Right after a push GitHub can list no checks before the new runs appear.
    h.gh.setChecks(prUrl, []);
    await round(w);
    expect(pr(id)).toMatchObject({ checks: 'none' });
    expect(h.only(h.cards()).id).toBe(card.id);

    // The new run fails: still the one card, linking that run.
    const rerun = 'https://github.com/acme/widgets/actions/runs/lint-2';
    h.gh.setChecks(prUrl, [run('lint', 'FAILURE', rerun)]);
    await round(w);
    expect(h.only(h.cards())).toMatchObject({ id: card.id, detail: { link: rerun } });

    // None twice in a row: the pull request has no checks now, and the card goes.
    h.gh.setChecks(prUrl, []);
    await round(w);
    expect(h.cards()).toHaveLength(1);
    await round(w);
    expect(h.cards()).toEqual([]);
  });

  it('counts only reads gh answered toward the two reads of none', async () => {
    setup();
    const { id, prUrl } = shipped(h.project.id, 'Alpha');
    h.gh.setChecks(prUrl, [run('lint', 'FAILURE')]);
    const w = watcher();
    w.start();
    await w.idle();
    const card = h.only(h.cards());
    const checksCard = () => findOpenByFoldKey(h.store.db, h.project.id, `pr-checks:${id}`);

    h.gh.setChecks(prUrl, []);
    await round(w);
    expect(pr(id)).toMatchObject({ checks: 'none' });

    // Offline: the read keeps the last known checks, none, but it is not a second read of none.
    h.gh.failNext.set('prStatus', new GhError('timeout', TIMEOUT));
    await round(w);
    expect(pr(id)).toMatchObject({ state: 'unknown', checks: 'none' });
    expect(checksCard()?.id).toBe(card.id);

    // The new run fails: still the one card, and gh answered, so its card goes.
    h.gh.setChecks(prUrl, [
      run('lint', 'FAILURE', 'https://github.com/acme/widgets/actions/runs/lint-2'),
    ]);
    await round(w);
    expect(h.only(h.cards()).id).toBe(card.id);
  });

  it('records unknown checks for a rollup entry 10db cannot read, without a card, and reads on', async () => {
    setup();
    const a = shipped(h.project.id, 'Alpha');
    const b = shipped(h.project.id, 'Beta');
    h.gh.setChecks(a.prUrl, [run('build', 'SUCCESS'), UNREADABLE_CHECK]);
    h.gh.setChecks(b.prUrl, [run('build', 'SUCCESS')]);
    const w = watcher();
    w.start();
    await w.idle();
    expect(pr(a.id)).toMatchObject({ state: 'open', checks: 'unknown', unknownReason: null });
    expect(pr(b.id)).toMatchObject({ state: 'open', checks: 'passing' });
    expect(h.cards()).toEqual([]);
  });

  it('records no checks as none', async () => {
    setup();
    const { id } = shipped(h.project.id, 'Alpha');
    const w = watcher();
    w.start();
    await w.idle();
    expect(pr(id)).toMatchObject({ state: 'open', checks: 'none' });
  });

  it('writes one batch.updated for a status that stays the same over three rounds', async () => {
    setup();
    const { id, prUrl } = shipped(h.project.id, 'Alpha');
    h.gh.setChecks(prUrl, [run('build', null)]);
    const w = watcher();
    w.start();
    await w.idle();
    const updatedAt = getBatch(h.store.db, id).updatedAt;
    await round(w);
    await round(w);
    expect(polls()).toBe(3);
    expect(prEvents(id)).toHaveLength(1);
    expect(getBatch(h.store.db, id).updatedAt).toBe(updatedAt);
    expect(pr(id)?.checkedAt).toBe(clock.now().toISOString());
  });

  it('marks a pull request GitHub no longer knows as unknown, without a gh card', async () => {
    setup();
    const { id } = shipped(h.project.id, 'Alpha', 'https://github.com/acme/widgets/pull/999');
    const w = watcher();
    w.start();
    await w.idle();
    expect(pr(id)).toMatchObject({ state: 'unknown', checks: 'unknown' });
    expect(pr(id)?.unknownReason).toContain('no pull request');
    expect(h.cards()).toEqual([]);
  });
});

describe('a pull request whose head never got its required checks', () => {
  const GRACE_ROUNDS = 5; // 10 minutes of 2-minute rounds: how long runs get to appear
  const HEAD_A = 'a'.repeat(40);
  const HEAD_B = 'b'.repeat(40);

  /** A watch whose landing is a spy: what it was asked, in order. */
  function spy(held: () => boolean = () => false): { asked: string[]; watch: PrWatch } {
    const asked: string[] = [];
    const watch = createPrWatch({
      ctx: h.ctx,
      clock,
      intervalMs: INTERVAL,
      landing: {
        catchUp: (id) => asked.push(`catch-up ${id}`),
        // A restart held by a drain is asked about and does nothing, as the shipper's is.
        restartCi: (id) => {
          asked.push(`restart-ci ${id}${held() ? ' (held)' : ''}`);
          return !held();
        },
        retryMerge: (id) => asked.push(`retry ${id}`),
      },
    });
    watches.push(watch);
    return { asked, watch };
  }

  /** A shipped pull request that GitHub holds for a required check that has not reported. */
  function stuck(autoMerge = true): { id: BatchId; prUrl: string } {
    setup();
    const made = shipped(h.project.id, 'Alpha', undefined, autoMerge);
    h.gh.setBlockedOnChecks(made.prUrl, true);
    h.gh.setHead(made.prUrl, HEAD_A);
    // Landing asks to merge a clean pull request again; that is not what these cases are about.
    return made;
  }

  const stuckNotice = (id: BatchId) =>
    getBatch(h.store.db, id).notices.find((n) => n.key === 'checks-never-started');

  const rounds = async (w: PrWatch, n: number) => {
    for (let i = 0; i < n; i++) await round(w);
  };

  it('asks for CI to be started again once the head has had minutes to get its runs, and not before', async () => {
    const { id } = stuck();
    const { asked, watch } = spy();
    watch.start();
    await watch.idle();
    await rounds(watch, GRACE_ROUNDS - 1);
    expect(asked.filter((a) => a.startsWith('restart-ci'))).toEqual([]);
    expect(stuckNotice(id)).toBeUndefined();

    await round(watch);
    expect(asked.filter((a) => a.startsWith('restart-ci'))).toEqual([`restart-ci ${id}`]);
    // 10db pushed or tried to: no notice yet, the new head gets its own minutes.
    expect(stuckNotice(id)).toBeUndefined();
  });

  it('keeps a restart a drain held unasked: no notice during the drain, and the first round after it asks', async () => {
    const { id } = stuck();
    let draining = true;
    const { asked, watch } = spy(() => draining);
    watch.start();
    await watch.idle();
    // The drain outlasts the minutes the head gets, twice over.
    await rounds(watch, GRACE_ROUNDS * 2);
    expect(stuckNotice(id)).toBeUndefined();
    expect(asked.filter((a) => a.startsWith('restart-ci')).every((a) => a.endsWith('(held)'))).toBe(
      true,
    );

    // The drain ends without a relaunch.
    draining = false;
    const before = asked.length;
    await round(watch);
    expect(asked.slice(before).filter((a) => a.startsWith('restart-ci'))).toEqual([
      `restart-ci ${id}`,
    ]);
    expect(stuckNotice(id)).toBeUndefined();

    // Asked once: the next minutes of the new head end in the notice, not a second ask.
    await rounds(watch, GRACE_ROUNDS);
    expect(asked.filter((a) => a === `restart-ci ${id}`)).toHaveLength(1);
    expect(stuckNotice(id)).toBeDefined();
  });

  it('asks once per head, then says on the task that the checks never started, naming the pull request', async () => {
    const { id, prUrl } = stuck();
    const { asked, watch } = spy();
    watch.start();
    await watch.idle();
    await rounds(watch, GRACE_ROUNDS);
    await rounds(watch, GRACE_ROUNDS - 1);
    expect(stuckNotice(id)).toBeUndefined();
    await round(watch);

    expect(asked.filter((a) => a.startsWith('restart-ci'))).toEqual([`restart-ci ${id}`]);
    const notice = stuckNotice(id);
    expect(notice).toMatchObject({ tone: 'warning' });
    expect(notice?.line).toBe(`Checks never started on pull request #1`);
    expect(notice?.body).toContain(prUrl);
    expect(h.cards()).toEqual([]);
  });

  it('gives the head 10db pushed its own minutes before it says the checks never started', async () => {
    const { id, prUrl } = stuck();
    const { asked, watch } = spy();
    watch.start();
    await watch.idle();
    await rounds(watch, GRACE_ROUNDS);
    expect(asked).toContain(`restart-ci ${id}`);

    // 10db's merge landed: a new head, still without runs.
    h.gh.setHead(prUrl, HEAD_B);
    await rounds(watch, GRACE_ROUNDS);
    expect(stuckNotice(id)).toBeUndefined();
    await round(watch);
    expect(stuckNotice(id)).toBeDefined();
    expect(asked.filter((a) => a.startsWith('restart-ci'))).toHaveLength(1);
  });

  it('keeps the ask across the unknown read GitHub gives the head 10db pushed', async () => {
    const { id, prUrl } = stuck();
    const { asked, watch } = spy();
    watch.start();
    await watch.idle();
    await rounds(watch, GRACE_ROUNDS);
    expect(asked).toContain(`restart-ci ${id}`);

    // GitHub has not worked out the new head yet: not blocked, mergeability unknown.
    h.gh.setHead(prUrl, HEAD_B);
    h.gh.setBlockedOnChecks(prUrl, false);
    h.gh.setMergeable(prUrl, 'UNKNOWN');
    await round(watch);
    h.gh.setBlockedOnChecks(prUrl, true);
    h.gh.setMergeable(prUrl, 'MERGEABLE');
    await rounds(watch, GRACE_ROUNDS);
    expect(stuckNotice(id)).toBeUndefined();
    await round(watch);

    expect(asked.filter((a) => a.startsWith('restart-ci'))).toEqual([`restart-ci ${id}`]);
    expect(stuckNotice(id)).toBeDefined();
  });

  it('keeps the notice through an unknown read, and drops it when a check appears', async () => {
    const { id, prUrl } = stuck();
    const { watch } = spy();
    watch.start();
    await watch.idle();
    await rounds(watch, GRACE_ROUNDS * 2);
    expect(stuckNotice(id)).toBeDefined();

    // The base moved: GitHub works the merge state out again.
    h.gh.setBlockedOnChecks(prUrl, false);
    h.gh.setMergeable(prUrl, 'UNKNOWN');
    await round(watch);
    expect(stuckNotice(id)).toBeDefined();

    h.gh.setChecks(prUrl, [run('build', null)]);
    await round(watch);
    expect(stuckNotice(id)).toBeUndefined();
  });

  it('drops the notice once the checks start, and starts counting again for a later head', async () => {
    const { id, prUrl } = stuck();
    const { asked, watch } = spy();
    watch.start();
    await watch.idle();
    await rounds(watch, GRACE_ROUNDS * 2);
    expect(stuckNotice(id)).toBeDefined();

    h.gh.setChecks(prUrl, [run('build', null)]);
    await round(watch);
    expect(stuckNotice(id)).toBeUndefined();
    expect(asked.filter((a) => a.startsWith('restart-ci'))).toHaveLength(1);
  });

  it.each([
    ['running', [run('build', null)]],
    ['passed', [run('build', 'SUCCESS')]],
    ['failed', [run('build', 'FAILURE')]],
  ])('never asks anything of a pull request whose checks are %s', async (_name, rollup) => {
    const { id, prUrl } = stuck();
    h.gh.setChecks(prUrl, rollup);
    const { asked, watch } = spy();
    watch.start();
    await watch.idle();
    await rounds(watch, GRACE_ROUNDS * 3);
    expect(asked.filter((a) => a.startsWith('restart-ci'))).toEqual([]);
    expect(stuckNotice(id)).toBeUndefined();
  });

  it('leaves a pull request alone when GitHub is not blocked on checks, such as a base with no CI', async () => {
    const { id, prUrl } = stuck();
    h.gh.setBlockedOnChecks(prUrl, false);
    const { asked, watch } = spy();
    watch.start();
    await watch.idle();
    await rounds(watch, GRACE_ROUNDS * 3);
    expect(asked.filter((a) => a.startsWith('restart-ci'))).toEqual([]);
    expect(stuckNotice(id)).toBeUndefined();
  });

  it('leaves a pull request that conflicts to the catch-up for conflicts', async () => {
    const { id, prUrl } = stuck();
    h.gh.setMergeable(prUrl, 'CONFLICTING');
    h.gh.setMergeBlocked(prUrl, 'conflicts');
    const { asked, watch } = spy();
    watch.start();
    await watch.idle();
    await rounds(watch, GRACE_ROUNDS * 2);
    expect(asked.filter((a) => a.startsWith('restart-ci'))).toEqual([]);
    expect(stuckNotice(id)).toBeUndefined();
  });

  it('does not count a read gh could not answer, nor a pull request that is not open', async () => {
    const { id, prUrl } = stuck();
    const { asked, watch } = spy();
    watch.start();
    await watch.idle();
    await rounds(watch, GRACE_ROUNDS - 1);
    h.gh.setState(prUrl, 'MERGED');
    await rounds(watch, GRACE_ROUNDS);
    expect(asked.filter((a) => a.startsWith('restart-ci'))).toEqual([]);
    expect(stuckNotice(id)).toBeUndefined();
  });

  it('says the checks never started, without pushing, for a pull request held for the builder', async () => {
    const { id } = stuck(false);
    const { asked, watch } = spy();
    watch.start();
    await watch.idle();
    await rounds(watch, GRACE_ROUNDS - 1);
    expect(stuckNotice(id)).toBeUndefined();
    await round(watch);
    expect(asked).toEqual([]);
    expect(stuckNotice(id)).toBeDefined();
  });

  it('says the checks never started when nothing can start them again', async () => {
    const { id } = stuck();
    const w = watcher();
    w.start();
    await w.idle();
    await rounds(w, GRACE_ROUNDS);
    expect(stuckNotice(id)).toBeDefined();
  });
});

describe('gh unavailable', () => {
  it('shows signed out as unknown with one card across projects, one call per round, and withdraws it on sign-in', async () => {
    setup();
    const second = seedProject(h.store, { delivery: 'pull_request' });
    const a = shipped(h.project.id, 'Alpha');
    const b = shipped(second.id, 'Beta');
    h.gh.auth = 'signed_out';
    const w = watcher();
    w.start();
    await w.idle();

    for (const batch of [a, b])
      expect(pr(batch.id)).toMatchObject({
        state: 'unknown',
        checks: 'unknown',
        unknownReason: 'gh is not signed in',
      });
    expect(polls()).toBe(1);
    const card = h.only(h.cards());
    expect(card.projectId).toBe(h.project.id);
    expect(card.body).toContain('gh auth login');
    expect(card.body).toContain('unknown');
    // No link: the desktop's Open on GitHub would open one pull request, which says nothing about gh.
    expect(card.detail).toEqual({ batchId: a.id, prUrl: a.prUrl, ghCheck: true });

    await round(w);
    expect(polls()).toBe(2);
    expect(h.cards()).toHaveLength(1);

    h.gh.auth = 'ok';
    await round(w);
    expect(pr(a.id)).toMatchObject({ state: 'open', checks: 'none', unknownReason: null });
    expect(pr(b.id)).toMatchObject({ state: 'open' });
    expect(h.cards()).toEqual([]);
  });

  it.each([
    {
      name: 'not installed',
      error: new GhError('not_installed', 'no gh'),
      says: 'brew install gh',
    },
    {
      name: 'a failure',
      error: new GhError('failed', 'gh pr view failed (exit 1): HTTP 502'),
      says: "gh couldn't reach GitHub: gh pr view failed (exit 1): HTTP 502",
    },
    {
      name: 'a timeout',
      error: new GhError('timeout', 'gh pr view gave no answer within 120 s'),
      says: "gh couldn't reach GitHub: gh pr view gave no answer within 120 s",
    },
    {
      name: 'out of reach of GitHub',
      error: new GhError(
        'unreachable',
        'gh pr view failed (exit 1): error connecting to api.github.com',
      ),
      says: "gh couldn't reach GitHub: gh pr view failed (exit 1): error connecting to api.github.com",
    },
  ])('says what to do when gh is $name', async ({ error, says }) => {
    setup();
    const { id } = shipped(h.project.id, 'Alpha');
    h.gh.failNext.set('prStatus', error);
    const w = watcher();
    w.start();
    await w.idle();
    expect(pr(id)).toMatchObject({ state: 'unknown', unknownReason: error.message });
    const card = h.only(h.cards());
    expect(card.body).toContain(says);
    expect(card.body).toContain('Nothing else is affected');
  });

  it('rewrites the open gh card when gh fails another way, and only then', async () => {
    setup();
    const { id } = shipped(h.project.id, 'Alpha');
    h.gh.failNext.set('prStatus', new GhError('timeout', 'gh pr view gave no answer within 120 s'));
    const w = watcher();
    w.start();
    await w.idle();
    const first = h.only(h.cards());
    expect(first.body).toContain(
      "gh couldn't reach GitHub: gh pr view gave no answer within 120 s",
    );

    h.gh.auth = 'signed_out';
    await round(w);
    expect(pr(id)).toMatchObject({ state: 'unknown', unknownReason: 'gh is not signed in' });
    const card = h.only(h.cards());
    expect(card.id).toBe(first.id);
    expect(card.title).toBe('Pull request status unknown: gh is signed out');
    expect(card.body).toContain('gh auth login');
    expect(card.body).not.toContain('gave no answer');
    expect(card.detail).toEqual(first.detail);

    const writes = () =>
      listEventsAfter(h.store.db, 0, 10_000).filter(
        (e) => e.type === 'inbox.changed' && e.entityId === card.id,
      ).length;
    const before = writes();
    await round(w);
    expect(writes()).toBe(before);
  });

  it('does not raise a second card when a later batch also goes unknown', async () => {
    setup();
    const a = shipped(h.project.id, 'Alpha');
    h.gh.auth = 'signed_out';
    const w = watcher();
    w.start();
    await w.idle();
    const b = shipped(h.project.id, 'Beta');
    await round(w);
    expect(pr(b.id)).toMatchObject({ state: 'unknown' });
    expect(pr(a.id)).toMatchObject({ state: 'unknown' });
    expect(h.cards()).toHaveLength(1);
  });

  it("keeps reading the other pull requests while one pull request's read fails every time", async () => {
    setup();
    const a = shipped(h.project.id, 'Alpha');
    const b = shipped(h.project.id, 'Beta');
    h.gh.setChecks(b.prUrl, [run('build', 'SUCCESS')]);
    // gh fails for this pull request alone, round after round; it is the oldest, so it is read first.
    const saml =
      'gh pr view failed (exit 1): GraphQL: Resource protected by organization SAML enforcement. (repository)';
    h.gh.failRead.set(a.prUrl, new GhError('failed', saml));
    const w = watcher();
    w.start();
    await w.idle();
    for (let i = 0; i < 3; i += 1) await round(w);

    expect(reads(b.prUrl)).toBe(4);
    expect(pr(b.id)).toMatchObject({ state: 'open', checks: 'passing', unknownReason: null });
    expect(pr(a.id)).toMatchObject({ state: 'unknown', unknownReason: saml });
    // gh answered for Beta, so gh itself works: no gh card.
    expect(h.cards()).toEqual([]);
  });

  it('withdraws the gh card once gh answers, though one pull request still fails on its own', async () => {
    setup();
    const a = shipped(h.project.id, 'Alpha');
    const b = shipped(h.project.id, 'Beta');
    h.gh.auth = 'signed_out';
    const w = watcher();
    w.start();
    await w.idle();
    expect(h.cards()).toHaveLength(1);

    h.gh.auth = 'ok';
    h.gh.failRead.set(b.prUrl, new GhError('failed', 'HTTP 502'));
    await round(w);
    expect(pr(a.id)).toMatchObject({ state: 'open', unknownReason: null });
    expect(pr(b.id)).toMatchObject({ state: 'unknown', unknownReason: 'HTTP 502' });
    expect(h.cards()).toEqual([]);

    h.gh.failRead.delete(b.prUrl);
    await round(w);
    expect(pr(b.id)).toMatchObject({ state: 'open', unknownReason: null });
  });

  it.each([
    { name: 'is not installed', error: new GhError('not_installed', 'no gh') },
    { name: 'gives no answer in time', error: new GhError('timeout', TIMEOUT) },
    {
      name: 'cannot reach GitHub',
      error: new GhError(
        'unreachable',
        'gh pr view failed (exit 1): Post "https://api.github.com/graphql": dial tcp 140.82.112.6:443: i/o timeout',
      ),
    },
  ])('ends the round at the first read when gh $name', async ({ error }) => {
    setup();
    const a = shipped(h.project.id, 'Alpha');
    const b = shipped(h.project.id, 'Beta');
    h.gh.failNext.set('prStatus', error);
    const w = watcher();
    w.start();
    await w.idle();
    // Every later read would fail the same way, or wait as long: one is enough.
    expect(polls()).toBe(1);
    for (const x of [a, b])
      expect(pr(x.id)).toMatchObject({ state: 'unknown', unknownReason: error.message });
    expect(h.cards()).toHaveLength(1);
  });

  it('raises one gh card when no read in a round answers, after asking for every pull request', async () => {
    setup();
    const second = seedProject(h.store, { delivery: 'pull_request' });
    const a = shipped(h.project.id, 'Alpha');
    const b = shipped(second.id, 'Beta');
    // GitHub fails every read, as in an outage. gh reached it, so each is a read of its own.
    const outage =
      'gh pr view failed (exit 1): HTTP 502: Bad Gateway (https://api.github.com/graphql)';
    for (const x of [a, b]) h.gh.failRead.set(x.prUrl, new GhError('failed', outage));
    const w = watcher();
    w.start();
    await w.idle();

    expect(polls()).toBe(2);
    for (const x of [a, b])
      expect(pr(x.id)).toMatchObject({ state: 'unknown', unknownReason: outage });
    const card = h.only(h.cards());
    expect(card.projectId).toBe(h.project.id);
    expect(card.body).toContain(`gh couldn't reach GitHub: ${outage}`);

    h.gh.failRead.clear();
    await round(w);
    expect(pr(b.id)).toMatchObject({ state: 'open' });
    expect(h.cards()).toEqual([]);
  });

  describe('the gh card’s Check again', () => {
    async function ghCard() {
      setup();
      shipped(h.project.id, 'Alpha');
      h.gh.auth = 'signed_out';
      const w = watcher();
      w.start();
      await w.idle();
      return h.only(h.cards());
    }

    it('offers an answer the daemon acts on, not a dismiss', async () => {
      const card = await ghCard();
      expect(card.options.map((o) => o.label)).toEqual([GH_CHECK_CHOICE]);
      expect(card.body).toContain(GH_CHECK_CHOICE);
    });

    it('reads every followed pull request again at once', async () => {
      const card = await ghCard();
      let pokes = 0;
      createGhCardAnswers({
        recheck: () => {
          pokes += 1;
        },
      })(card, { choice: GH_CHECK_CHOICE });
      expect(pokes).toBe(1);
    });

    it('does nothing for another answer or another card', async () => {
      const card = await ghCard();
      let pokes = 0;
      const answer = createGhCardAnswers({
        recheck: () => {
          pokes += 1;
        },
      });
      answer(card, { choice: 'Later' });
      answer({ ...card, detail: {} }, { choice: GH_CHECK_CHOICE });
      expect(pokes).toBe(0);
    });

    /** The inbox the daemon runs: an answer to the gh card reaches the watch before the card closes. */
    function answeringInbox(w: PrWatch) {
      return createInboxService({
        state: h.state,
        onParkedAnswer: () => undefined,
        onFlagAnswer: createGhCardAnswers(w),
      });
    }

    it('raises a fresh card saying how gh fails now when gh still fails', async () => {
      setup();
      shipped(h.project.id, 'Alpha');
      h.gh.auth = 'signed_out';
      const w = watcher();
      w.start();
      await w.idle();
      const first = h.only(h.cards());

      h.gh.failNext.set('prStatus', new GhError('timeout', TIMEOUT));
      answeringInbox(w).answer(first.id, { choice: GH_CHECK_CHOICE });
      await w.idle();

      const fresh = h.only(h.cards());
      expect(fresh.id).not.toBe(first.id);
      expect(fresh.body).toContain(TIMEOUT);
      expect(fresh.options.map((o) => o.label)).toEqual([GH_CHECK_CHOICE]);

      // Only the round the answer asked for raises again: a later failing round keeps the one card.
      await round(w);
      expect(h.only(h.cards()).id).toBe(fresh.id);
    });

    it('leaves no card once gh answers', async () => {
      setup();
      const a = shipped(h.project.id, 'Alpha');
      h.gh.auth = 'signed_out';
      const w = watcher();
      w.start();
      await w.idle();
      const card = h.only(h.cards());

      h.gh.auth = 'ok';
      answeringInbox(w).answer(card.id, { choice: GH_CHECK_CHOICE });
      await w.idle();

      expect(pr(a.id)).toMatchObject({ state: 'open', unknownReason: null });
      expect(h.cards()).toEqual([]);
      // gh failing in a later round raises a card again, as any first failure does.
      h.gh.auth = 'signed_out';
      await round(w);
      expect(h.cards()).toHaveLength(1);
    });
  });

  it('starts the next round after the read that ended the last, so one that always times out holds up no other', async () => {
    setup();
    const a = shipped(h.project.id, 'Alpha');
    const b = shipped(h.project.id, 'Beta');
    const c = shipped(h.project.id, 'Gamma');
    h.gh.failRead.set(a.prUrl, new GhError('timeout', TIMEOUT));
    const w = watcher();
    w.start();
    await w.idle();
    // A timeout ends the round: offline, every read would wait as long.
    expect(polls()).toBe(1);
    for (const x of [a, b, c])
      expect(pr(x.id)).toMatchObject({ state: 'unknown', unknownReason: TIMEOUT });

    await round(w);
    expect(polls()).toBe(4);
    expect(pr(b.id)).toMatchObject({ state: 'open', unknownReason: null });
    expect(pr(c.id)).toMatchObject({ state: 'open', unknownReason: null });
    expect(pr(a.id)).toMatchObject({ state: 'unknown', unknownReason: TIMEOUT });
    // A read that times out is what gh being offline looks like, so the gh card stays.
    expect(h.only(h.cards()).body).toContain(`gh couldn't reach GitHub: ${TIMEOUT}`);

    await round(w);
    expect(reads(b.prUrl)).toBe(2);
    expect(reads(c.prUrl)).toBe(2);
  });

  it('withdraws the gh card in its own project after that project has no pull request left to read', async () => {
    setup();
    const second = seedProject(h.store, { delivery: 'pull_request' });
    const a = shipped(h.project.id, 'Alpha');
    const b = shipped(second.id, 'Beta');
    for (const x of [a, b]) h.gh.failRead.set(x.prUrl, new GhError('failed', 'HTTP 502'));
    const w = watcher();
    w.start();
    await w.idle();
    expect(h.only(h.cards()).projectId).toBe(h.project.id);

    // Alpha answers merged; Beta's read times out, which keeps the card open.
    h.gh.failRead.delete(a.prUrl);
    h.gh.setState(a.prUrl, 'MERGED');
    h.gh.failRead.set(b.prUrl, new GhError('timeout', TIMEOUT));
    await round(w);
    expect(pr(a.id)).toMatchObject({ state: 'merged' });
    expect(pr(b.id)).toMatchObject({ state: 'unknown', unknownReason: TIMEOUT });
    expect(h.cards()).toHaveLength(1);

    // Only Beta is read now, in the second project; gh answers, so the card in the first goes.
    h.gh.failRead.delete(b.prUrl);
    await round(w);
    expect(pr(b.id)).toMatchObject({ state: 'open', unknownReason: null });
    expect(h.cards()).toEqual([]);

    h.gh.failNext.set('prStatus', new GhError('failed', 'HTTP 503'));
    await round(w);
    expect(pr(b.id)).toMatchObject({ state: 'unknown', unknownReason: 'HTTP 503' });
    expect(h.only(h.cards()).body).toContain("gh couldn't reach GitHub: HTTP 503");
  });

  it('raises no second gh card while one is open in a project the round does not read', async () => {
    setup();
    const second = seedProject(h.store, { delivery: 'pull_request' });
    const a = shipped(h.project.id, 'Alpha');
    const b = shipped(second.id, 'Beta');
    const c = shipped(second.id, 'Gamma');
    for (const x of [a, b, c]) h.gh.failRead.set(x.prUrl, new GhError('failed', 'HTTP 502'));
    const w = watcher();
    w.start();
    await w.idle();
    expect(h.only(h.cards()).projectId).toBe(h.project.id);

    // Alpha merges and Beta answers; Gamma's read times out, which keeps the card open.
    h.gh.failRead.clear();
    h.gh.setState(a.prUrl, 'MERGED');
    h.gh.failRead.set(c.prUrl, new GhError('timeout', TIMEOUT));
    await round(w);
    expect(pr(a.id)).toMatchObject({ state: 'merged' });
    expect(pr(b.id)).toMatchObject({ state: 'open' });
    expect(pr(c.id)).toMatchObject({ state: 'unknown' });
    expect(h.cards()).toHaveLength(1);

    // Only the second project is read now; gh is signed out, and the first project's card stays
    // the one card, saying how gh fails now.
    h.gh.auth = 'signed_out';
    await round(w);
    expect(pr(b.id)).toMatchObject({ state: 'unknown', unknownReason: 'gh is not signed in' });
    const card = h.only(h.cards());
    expect(card.projectId).toBe(h.project.id);
    expect(card.title).toBe('Pull request status unknown: gh is signed out');
  });

  it('does not raise a dismissed failing-checks card again after an offline round', async () => {
    setup();
    const { id, prUrl } = shipped(h.project.id, 'Alpha');
    h.gh.setChecks(prUrl, [run('build', 'FAILURE')]);
    const w = watcher();
    w.start();
    await w.idle();
    const card = h.only(h.cards());
    h.inbox.withdraw(card.id);

    h.gh.failNext.set('prStatus', new GhError('timeout', 'gh pr view gave no answer within 120 s'));
    await round(w);
    // Unknown, but the last known checks are kept.
    expect(pr(id)).toMatchObject({ state: 'unknown', checks: 'failing' });
    expect(pr(id)?.failingChecks.map((c) => c.name)).toEqual(['build']);
    const ghCard = h.only(h.cards());
    expect(ghCard.title).not.toContain('checks failed');

    await round(w);
    expect(pr(id)).toMatchObject({ state: 'open', checks: 'failing', unknownReason: null });
    expect(h.cards()).toEqual([]);
  });

  it('keeps shipping while prStatus fails', async () => {
    setup();
    const offline: Gh = {
      authStatus: () => h.gh.authStatus(),
      authLogin: () => h.gh.authLogin(),
      prView: (input) => h.gh.prView(input),
      prCreate: (input) => h.gh.prCreate(input),
      repoAllowsAutoMerge: () => h.gh.repoAllowsAutoMerge(),
      prAutoMerge: (input) => h.gh.prAutoMerge(input),
      prMerge: (input) => h.gh.prMerge(input),
      prRequiredChecks: (input) => h.gh.prRequiredChecks(input),
      jobLog: (input) => h.gh.jobLog(input),
      rerunFailed: (input) => h.gh.rerunFailed(input),
      prInMergeQueue: (input) => h.gh.prInMergeQueue(input),
      prStatus: () => Promise.reject(new GhError('failed', 'HTTP 502')),
    };
    const w = watcher({ ...h.ctx, gh: offline });
    subscribePrWatch(h.bus, w);
    w.start();
    await w.idle();

    const task = h.addTask('Alpha');
    const started = h.only(
      h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: [task.id] }),
    );
    await h.jobs.idle();
    h.commit('src/api/alpha.txt');
    for (const ws of listWorkstreams(h.store.db, { batchId: started.id })) h.settle(ws.id, 'DONE');
    await h.jobs.idle();

    const batch = getBatch(h.store.db, started.id);
    expect(batch.state).toBe('SHIPPED');
    expect(batch.prUrl).not.toBeNull();
    await waitFor(() => getBatch(h.store.db, started.id).pr !== null);
    await w.idle();
    expect(pr(started.id)).toMatchObject({ state: 'unknown', unknownReason: 'HTTP 502' });
    expect(h.only(h.cards()).body).toContain("gh couldn't reach GitHub: HTTP 502");
  });
});

describe('restart and stop', () => {
  it('a new watcher on the same database reads the stored status and raises no second card', async () => {
    setup();
    const { id, prUrl } = shipped(h.project.id, 'Alpha');
    h.gh.setChecks(prUrl, [run('build', 'FAILURE')]);
    const first = watcher();
    first.start();
    await first.idle();
    await first.stop();
    const card = h.only(h.cards());

    expect(pr(id)).toMatchObject({ state: 'open', checks: 'failing' });
    const second = watcher();
    expect(pr(id)).toMatchObject({ checks: 'failing' });
    second.start();
    await second.idle();
    expect(h.cards()).toHaveLength(1);

    // A card the builder dismissed stays dismissed.
    h.inbox.withdraw(card.id);
    await round(second);
    expect(h.cards()).toEqual([]);
  });

  it('stores a status only with its card, so a card that could not be written comes with the next read', async () => {
    setup();
    const { id, prUrl } = shipped(h.project.id, 'Alpha');
    h.gh.setChecks(prUrl, [run('build', 'FAILURE')]);
    refuseCards();
    const w = watcher();
    w.start();
    await w.idle();
    expect(pr(id)).toBeNull();

    allowCards();
    await round(w);
    expect(pr(id)).toMatchObject({ checks: 'failing' });
    expect(h.only(h.cards()).title).toBe('Pull request checks failed for "Alpha": build');
  });

  it('stores the unknown statuses gh left only with the gh card', async () => {
    setup();
    const { id } = shipped(h.project.id, 'Alpha');
    h.gh.auth = 'signed_out';
    refuseCards();
    const w = watcher();
    w.start();
    await w.idle();
    expect(pr(id)).toBeNull();

    allowCards();
    await round(w);
    expect(pr(id)).toMatchObject({ state: 'unknown', unknownReason: 'gh is not signed in' });
    expect(h.only(h.cards()).title).toBe('Pull request status unknown: gh is signed out');
  });

  it('stop aborts the call in flight, records nothing and leaves no timer', async () => {
    setup();
    const { id } = shipped(h.project.id, 'Alpha');
    let entered = false;
    const hanging: Gh = {
      authStatus: () => h.gh.authStatus(),
      authLogin: () => h.gh.authLogin(),
      prView: (input) => h.gh.prView(input),
      prCreate: (input) => h.gh.prCreate(input),
      repoAllowsAutoMerge: () => h.gh.repoAllowsAutoMerge(),
      prAutoMerge: (input) => h.gh.prAutoMerge(input),
      prMerge: (input) => h.gh.prMerge(input),
      prRequiredChecks: (input) => h.gh.prRequiredChecks(input),
      jobLog: (input) => h.gh.jobLog(input),
      rerunFailed: (input) => h.gh.rerunFailed(input),
      prInMergeQueue: (input) => h.gh.prInMergeQueue(input),
      prStatus: (_input, call) =>
        new Promise((_resolve, reject) => {
          entered = true;
          call.signal?.addEventListener('abort', () => {
            reject(new GhError('aborted', 'gh was stopped'));
          });
        }),
    };
    const w = watcher({ ...h.ctx, gh: hanging });
    w.start();
    await waitFor(() => entered);
    await w.stop();
    expect(pr(id)).toBeNull();
    expect(h.cards()).toEqual([]);
    expect(clock.pendingTimers()).toBe(0);
    w.poke();
    await w.idle();
    expect(clock.pendingTimers()).toBe(0);
  });

  it('stop between rounds cancels the timer', async () => {
    setup();
    shipped(h.project.id, 'Alpha');
    const w = watcher();
    w.start();
    await w.idle();
    expect(clock.pendingTimers()).toBe(1);
    await w.stop();
    expect(clock.pendingTimers()).toBe(0);
  });
});

describe('the required checks of a pull request', () => {
  const job = (name: string) => ({
    name,
    link: `https://github.com/acme/widgets/actions/runs/1/job/${name}`,
    jobId: name,
    runId: '1',
    description: null,
  });
  const requiredReads = () => h.gh.calls.filter((c) => c.method === 'prRequiredChecks').length;
  const stored = (id: BatchId) => getBatch(h.store.db, id);

  /** A fix batch sharing its root's pull request, shipped as a fix leaves one. */
  function shippedFix(root: { id: BatchId; prUrl: string }, title: string, head: string): BatchId {
    const id = h.state.write((ctx) =>
      insertBatch(ctx, {
        projectId: h.project.id,
        title,
        baseBranch: 'main',
        worktreePath: `/tmp/wt/${title}`,
        ciFix: { of: root.id, head },
      }),
    ).id;
    for (const to of ['OPEN', 'SHIPPING'] as const)
      h.state.write((ctx) => transitionBatch(ctx, id, { to }));
    h.state.write((ctx) =>
      transitionBatch(ctx, id, {
        to: 'SHIPPED',
        patch: { repo: 'acme/widgets', prUrl: root.prUrl, branch: `10db/${title}` },
      }),
    );
    return id;
  }

  it('stores the required checks of an open pull request on its batch', async () => {
    setup();
    const { id, prUrl } = shipped(h.project.id, 'Alpha');
    h.gh.setRequiredChecks(prUrl, {
      state: 'pending',
      failing: [],
      pending: [job('build')],
      cancelled: [],
    });
    const w = watcher();
    w.start();
    await w.idle();
    expect(stored(id).prRequired).toEqual({
      state: 'pending',
      failing: [],
      pending: [job('build')],
      cancelled: [],
    });

    h.gh.setRequiredChecks(prUrl, {
      state: 'failing',
      failing: [job('build')],
      pending: [],
      cancelled: [],
    });
    await round(w);
    expect(stored(id).prRequired).toMatchObject({ state: 'failing', failing: [job('build')] });
  });

  it('stores none for a pull request with no required checks', async () => {
    setup();
    const { id } = shipped(h.project.id, 'Alpha');
    const w = watcher();
    w.start();
    await w.idle();
    expect(stored(id).prRequired).toEqual({
      state: 'none',
      failing: [],
      pending: [],
      cancelled: [],
    });
  });

  it('stores why GitHub will not merge the pull request, and clears it', async () => {
    setup();
    const { id, prUrl } = shipped(h.project.id, 'Alpha');
    h.gh.setMergeBlocked(prUrl, 'conflicts');
    const w = watcher();
    w.start();
    await w.idle();
    expect(stored(id).prMergeBlocked).toBe('conflicts');
    h.gh.setMergeBlocked(prUrl, 'behind');
    await round(w);
    expect(stored(id).prMergeBlocked).toBe('behind');
    h.gh.setMergeBlocked(prUrl, null);
    await round(w);
    expect(stored(id).prMergeBlocked).toBeNull();
  });

  it('keeps what it stored when the required checks cannot be read, and writes nothing for a read that changes nothing', async () => {
    setup();
    const { id, prUrl } = shipped(h.project.id, 'Alpha');
    h.gh.setRequiredChecks(prUrl, { state: 'passing', failing: [], pending: [], cancelled: [] });
    const w = watcher();
    w.start();
    await w.idle();
    const written = () =>
      listEventsAfter(h.store.db, 0, 10_000).filter(
        (e) => e.entityId === id && JSON.stringify(e.data).includes('prRequired'),
      ).length;
    expect(written()).toBe(1);

    h.gh.failNext.set('prRequiredChecks', new GhError('failed', 'HTTP 502'));
    await round(w);
    expect(stored(id).prRequired?.state).toBe('passing');
    expect(stored(id).pr?.state).toBe('open');
    await round(w);
    expect(written()).toBe(1);
  });

  it('reads a pull request shared by two batches once per round, and records its status on both', async () => {
    setup();
    const root = shipped(h.project.id, 'Alpha');
    const fix = shippedFix(root, 'Fix CI: build', 'abc');
    h.gh.setRequiredChecks(root.prUrl, {
      state: 'pending',
      failing: [],
      pending: [job('build')],
      cancelled: [],
    });
    const w = watcher();
    w.start();
    await w.idle();
    expect(polls()).toBe(1);
    expect(requiredReads()).toBe(1);
    expect(pr(root.id)).toMatchObject({ state: 'open' });
    expect(pr(fix)).toMatchObject({ state: 'open' });

    await round(w);
    expect(polls()).toBe(2);
    expect(requiredReads()).toBe(2);

    // The required checks and merge state are the root's alone.
    h.gh.setMergeBlocked(root.prUrl, 'behind');
    await round(w);
    expect(stored(root.id)).toMatchObject({ prMergeBlocked: 'behind' });
    expect(stored(root.id).prRequired?.state).toBe('pending');
    expect(stored(fix)).toMatchObject({ prRequired: null, prMergeBlocked: null });

    h.gh.setState(root.prUrl, 'MERGED');
    await round(w);
    expect(pr(root.id)).toMatchObject({ state: 'merged' });
    expect(pr(fix)).toMatchObject({ state: 'merged' });
    const before = polls();
    await round(w, INTERVAL * 3);
    expect(polls()).toBe(before);
  });

  it('raises one failing-checks card for a shared pull request, keyed by the root', async () => {
    setup();
    const root = shipped(h.project.id, 'Alpha');
    shippedFix(root, 'Fix CI: build', 'abc');
    h.gh.setChecks(root.prUrl, [run('build', 'FAILURE')]);
    const w = watcher();
    w.start();
    await w.idle();
    const card = h.only(h.cards());
    expect(card.detail).toMatchObject({ batchId: root.id });
    await round(w);
    expect(h.cards()).toHaveLength(1);
  });

  it('raises one closed card for a shared pull request, keyed by the root', async () => {
    setup();
    const root = shipped(h.project.id, 'Alpha');
    shippedFix(root, 'Fix CI: build', 'abc');
    h.gh.setState(root.prUrl, 'CLOSED');
    const w = watcher();
    w.start();
    await w.idle();
    const card = h.only(h.cards());
    expect(card.detail).toMatchObject({ batchId: root.id });
  });

  it('reads each of two pull requests once, a group of batches counting as one', async () => {
    setup();
    const a = shipped(h.project.id, 'Alpha');
    shippedFix(a, 'Fix A', 'abc');
    const b = shipped(h.project.id, 'Beta');
    const w = watcher();
    w.start();
    await w.idle();
    expect(reads(a.prUrl)).toBe(1);
    expect(reads(b.prUrl)).toBe(1);
    expect(polls()).toBe(2);
  });
});

describe('a required check GitHub cancelled', () => {
  const HEAD_A = 'a'.repeat(40);
  const HEAD_B = 'b'.repeat(40);
  const GRACE_ROUNDS = 5; // 10 minutes of 2-minute rounds

  const job = (name: string, runId: string | null = '77') => ({
    name,
    link: `https://github.com/acme/widgets/actions/runs/${runId ?? 'x'}/job/${name}1`,
    jobId: `${name}1`,
    runId,
    description: null,
  });
  const cancelled = (...names: string[]) => ({
    state: 'cancelled' as const,
    failing: [],
    pending: [],
    cancelled: names.map((n) => job(n)),
  });
  const running = (...names: string[]) => ({
    state: 'pending' as const,
    failing: [],
    pending: names.map((n) => job(n)),
    cancelled: [],
  });
  const passing = { state: 'passing' as const, failing: [], pending: [], cancelled: [] };

  const stored = (id: BatchId) => getBatch(h.store.db, id);
  const noticeOf = (id: BatchId) => stored(id).notices.find((n) => n.key === 'checks-cancelled');
  const rerunNoticeOf = (id: BatchId) =>
    stored(id).notices.find((n) => n.key === `checks-rerun:${HEAD_A}`);

  function watching(autoMerge = true): { id: BatchId; prUrl: string; w: PrWatch } {
    setup();
    const made = shipped(h.project.id, 'Alpha', undefined, autoMerge);
    h.gh.setHead(made.prUrl, HEAD_A);
    const w = watcher();
    return { ...made, w };
  }

  it('is stored as cancelled, never pending, with the cancelled check listed', async () => {
    const { id, prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, cancelled('desktop'));
    w.start();
    await w.idle();
    expect(stored(id).prRequired).toMatchObject({
      state: 'cancelled',
      pending: [],
      cancelled: [job('desktop')],
    });
  });

  it('runs the check again once, from the second read in a row, without a card', async () => {
    const { id, prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, cancelled('desktop'));
    w.start();
    await w.idle();
    // One read can be a run a newer push replaced: it is not rerun yet.
    expect(h.gh.reruns).toEqual([]);
    await round(w);
    expect(h.gh.reruns).toEqual(['77']);
    expect(noticeOf(id)).toBeUndefined();
    expect(h.cards()).toEqual([]);

    // GitHub still lists the old cancellation for a moment: no second rerun, no notice.
    await round(w);
    expect(h.gh.reruns).toEqual(['77']);
    expect(noticeOf(id)).toBeUndefined();
  });

  it('runs a run once even when two of its jobs were cancelled', async () => {
    const { prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, cancelled('desktop', 'gate'));
    w.start();
    await w.idle();
    await round(w);
    expect(h.gh.reruns).toEqual(['77']);
  });

  it('does not rerun a cancellation that is gone by the next read (a newer push replaced it)', async () => {
    const { id, prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, cancelled('desktop'));
    w.start();
    await w.idle();
    h.gh.setRequiredChecks(prUrl, running('desktop'));
    await round(w);
    h.gh.setRequiredChecks(prUrl, cancelled('desktop'));
    await round(w);
    expect(h.gh.reruns).toEqual([]);
    expect(noticeOf(id)).toBeUndefined();
  });

  it('shows a notice naming the check and its link when it is cancelled again, and runs nothing more', async () => {
    const { id, prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, cancelled('desktop'));
    w.start();
    await w.idle();
    await round(w);
    expect(h.gh.reruns).toEqual(['77']);

    h.gh.setRequiredChecks(prUrl, running('desktop'));
    await round(w);
    expect(noticeOf(id)).toBeUndefined();
    h.gh.setRequiredChecks(prUrl, cancelled('desktop'));
    await round(w);

    const notice = noticeOf(id);
    expect(notice).toMatchObject({ tone: 'warning' });
    expect(notice?.line).toContain('desktop');
    expect(notice?.body).toContain(job('desktop').link);
    expect(h.gh.reruns).toEqual(['77']);
    expect(stored(id).prRequired?.state).toBe('cancelled');
    await round(w);
    expect(h.gh.reruns).toEqual(['77']);
    expect(h.cards()).toEqual([]);
  });

  it('shows the notice when the rerun never took, after the minutes a run gets to start', async () => {
    const { id, prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, cancelled('desktop'));
    w.start();
    await w.idle();
    await round(w);
    for (let i = 0; i < GRACE_ROUNDS - 1; i++) await round(w);
    expect(noticeOf(id)).toBeUndefined();
    await round(w);
    expect(noticeOf(id)?.line).toContain('desktop');
    expect(h.gh.reruns).toEqual(['77']);
  });

  it('takes the notice away once the check runs or passes', async () => {
    const { id, prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, cancelled('desktop'));
    w.start();
    await w.idle();
    await round(w);
    h.gh.setRequiredChecks(prUrl, running('desktop'));
    await round(w);
    h.gh.setRequiredChecks(prUrl, cancelled('desktop'));
    await round(w);
    expect(noticeOf(id)).toBeDefined();
    h.gh.setRequiredChecks(prUrl, passing);
    await round(w);
    expect(noticeOf(id)).toBeUndefined();
  });

  it('says so at once when the check has no Actions run to start again', async () => {
    const { id, prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, {
      state: 'cancelled',
      failing: [],
      pending: [],
      cancelled: [{ ...job('ci/other', null), link: 'https://ci.example.com/b/1', jobId: null }],
    });
    w.start();
    await w.idle();
    await round(w);
    expect(h.gh.reruns).toEqual([]);
    const notice = noticeOf(id);
    expect(notice?.line).toContain('ci/other');
    expect(notice?.body).toContain('https://ci.example.com/b/1');
  });

  it('says so when GitHub refuses the rerun', async () => {
    const { id, prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, cancelled('desktop'));
    w.start();
    await w.idle();
    h.gh.failNext.set('rerunFailed', new GhError('failed', 'HTTP 403: Resource not accessible'));
    await round(w);
    expect(h.gh.reruns).toEqual([]);
    expect(noticeOf(id)?.body).toContain('Resource not accessible');
    await round(w);
    expect(h.gh.reruns).toEqual([]);
  });

  it('waits while another job of the cancelled check’s run is still running, then runs it once', async () => {
    const { id, prUrl, w } = watching();
    const desktopCancelledGateRunning = {
      state: 'cancelled' as const,
      failing: [],
      pending: [job('gate')],
      cancelled: [job('desktop')],
    };
    h.gh.setRequiredChecks(prUrl, desktopCancelledGateRunning);
    w.start();
    await w.idle();
    for (let i = 0; i < GRACE_ROUNDS + 2; i++) await round(w);
    // GitHub refuses to rerun a run still in progress: 10db neither asks nor gives up.
    expect(h.gh.reruns).toEqual([]);
    expect(noticeOf(id)).toBeUndefined();
    expect(h.cards()).toEqual([]);

    h.gh.setRequiredChecks(prUrl, cancelled('desktop'));
    await round(w);
    await round(w);
    expect(h.gh.reruns).toEqual(['77']);
    await round(w);
    expect(h.gh.reruns).toEqual(['77']);
    expect(noticeOf(id)).toBeUndefined();
  });

  it('does not wait on a running job of another run', async () => {
    const { prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, {
      state: 'cancelled',
      failing: [],
      pending: [job('lint', '88')],
      cancelled: [job('desktop')],
    });
    w.start();
    await w.idle();
    await round(w);
    expect(h.gh.reruns).toEqual(['77']);
  });

  it('tries again later, with no notice, when GitHub says the run is still running', async () => {
    const { id, prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, cancelled('desktop'));
    w.start();
    await w.idle();
    h.gh.failNext.set(
      'rerunFailed',
      new GhError('failed', 'run 77 cannot be rerun; This workflow is already running'),
    );
    await round(w);
    expect(h.gh.reruns).toEqual([]);
    expect(noticeOf(id)).toBeUndefined();
    await round(w);
    expect(h.gh.reruns).toEqual(['77']);
    expect(noticeOf(id)).toBeUndefined();
  });

  it('runs the one run again only once when GitHub refuses the other, which is still running', async () => {
    const { id, prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, {
      state: 'cancelled',
      failing: [],
      pending: [],
      cancelled: [job('desktop', '77'), job('lint', '88')],
    });
    w.start();
    await w.idle();
    h.gh.failRerunOf.set('88', new GhError('failed', 'run 88 cannot be rerun; already running'));
    await round(w);
    // Run 77 was run again and the record says so; run 88 was refused, so 10db asks again.
    expect(h.gh.reruns).toEqual(['77']);
    expect(noticeOf(id)).toBeUndefined();
    expect(rerunNoticeOf(id)?.line).toContain('desktop');
    expect(rerunNoticeOf(id)?.line).not.toContain('lint');
    await round(w);
    await round(w);
    // Run 77 is not run a second time; run 88 is accepted once.
    expect(h.gh.reruns).toEqual(['77', '88']);
    await round(w);
    expect(h.gh.reruns).toEqual(['77', '88']);
    expect(noticeOf(id)).toBeUndefined();
    expect(rerunNoticeOf(id)?.line).toContain('desktop');
    expect(rerunNoticeOf(id)?.line).toContain('lint');
  });

  it('keeps naming a check it ran when a later round runs the other, once GitHub no longer lists it', async () => {
    const { id, prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, {
      state: 'cancelled',
      failing: [],
      pending: [],
      cancelled: [job('desktop', '77'), job('lint', '88')],
    });
    w.start();
    await w.idle();
    h.gh.failRerunOf.set('88', new GhError('failed', 'run 88 cannot be rerun; already running'));
    await round(w);
    // Run 77 is running now, so only lint is left cancelled.
    h.gh.setRequiredChecks(prUrl, {
      state: 'cancelled',
      failing: [],
      pending: [job('desktop', '77')],
      cancelled: [job('lint', '88')],
    });
    await round(w);
    expect(h.gh.reruns).toEqual(['77', '88']);
    expect(rerunNoticeOf(id)?.line).toContain('desktop');
    expect(rerunNoticeOf(id)?.line).toContain('lint');
  });

  it('after a restart, runs the run GitHub refused once and not the run it took', async () => {
    const { id, prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, {
      state: 'cancelled',
      failing: [],
      pending: [],
      cancelled: [job('desktop', '77'), job('lint', '88')],
    });
    w.start();
    await w.idle();
    h.gh.failRerunOf.set('88', new GhError('failed', 'run 88 cannot be rerun; already running'));
    await round(w);
    expect(h.gh.reruns).toEqual(['77']);
    await w.stop();

    const second = watcher();
    second.start();
    await second.idle();
    await round(second);
    await round(second);
    // Run 88 is run now; run 77 is never run a second time.
    expect(h.gh.reruns).toEqual(['77', '88']);
    expect(rerunNoticeOf(id)?.line).toContain('desktop');
    expect(rerunNoticeOf(id)?.line).toContain('lint');
    for (let i = 0; i < GRACE_ROUNDS + 2; i++) await round(second);
    expect(h.gh.reruns).toEqual(['77', '88']);
  });

  it('after a restart, says nothing ran for a check whose run 10db never ran', async () => {
    const { id, prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, {
      state: 'cancelled',
      failing: [],
      pending: [],
      cancelled: [job('desktop', '77'), job('lint', '88')],
    });
    w.start();
    await w.idle();
    h.gh.failRerunOf.set('88', new GhError('failed', 'run 88 cannot be rerun; already running'));
    await round(w);
    await w.stop();

    // Run 88 is refused again: the record names only desktop, and no 'again' notice is shown.
    h.gh.failRerunOf.set('88', new GhError('failed', 'run 88 cannot be rerun; already running'));
    const second = watcher();
    second.start();
    await second.idle();
    for (let i = 0; i < 3; i++) {
      if (i > 0) await round(second);
      if (i === 0) {
        expect(h.gh.reruns).toEqual(['77']);
        expect(rerunNoticeOf(id)?.line).toContain('desktop');
        expect(rerunNoticeOf(id)?.line).not.toContain('lint');
      }
      expect(noticeOf(id)).toBeUndefined();
    }
    // Run 88 was run in the end; only then is lint named, and no notice says it was cancelled again.
    expect(h.gh.reruns).toEqual(['77', '88']);
    expect(rerunNoticeOf(id)?.line).toContain('lint');
  });

  it('after a restart between an accepted and a refused run, never says 10db ran the refused check while it stays cancelled', async () => {
    const { id, prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, {
      state: 'cancelled',
      failing: [],
      pending: [],
      cancelled: [job('desktop', '77'), job('lint', '88')],
    });
    w.start();
    await w.idle();
    h.gh.failRerunOf.set('88', new GhError('failed', 'run 88 cannot be rerun; already running'));
    await round(w);
    expect(h.gh.reruns).toEqual(['77']);
    await w.stop();

    // After the restart GitHub still refuses run 88, and both checks stay cancelled for 10 minutes.
    const second = watcher();
    h.gh.failRerunOf.set('88', new GhError('failed', 'run 88 cannot be rerun; already running'));
    second.start();
    await second.idle();
    for (let i = 0; i < GRACE_ROUNDS + 2; i++) {
      h.gh.failRerunOf.set('88', new GhError('failed', 'run 88 cannot be rerun; already running'));
      await round(second);
      const notice = noticeOf(id);
      // A notice may name desktop (10db ran it) but never lint, which 10db did not run.
      if (notice !== undefined) expect(notice.line).not.toContain('lint');
    }
    expect(h.gh.reruns).toEqual(['77']);
  });

  it('after a restart between an accepted and a refused run, runs the refused one once and then names both when they stay cancelled', async () => {
    const { id, prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, {
      state: 'cancelled',
      failing: [],
      pending: [],
      cancelled: [job('desktop', '77'), job('lint', '88')],
    });
    w.start();
    await w.idle();
    h.gh.failRerunOf.set('88', new GhError('failed', 'run 88 cannot be rerun; already running'));
    await round(w);
    await w.stop();

    const second = watcher();
    second.start();
    await second.idle();
    for (let i = 0; i < GRACE_ROUNDS + 3; i++) await round(second);
    expect(h.gh.reruns).toEqual(['77', '88']);
    expect(noticeOf(id)?.line).toContain('cancelled again');
    expect(noticeOf(id)?.line).toContain('desktop');
    expect(noticeOf(id)?.line).toContain('lint');
  });

  it('does not run the first run again when the daemon stops between two reruns', async () => {
    const { id, prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, {
      state: 'cancelled',
      failing: [],
      pending: [],
      cancelled: [job('desktop', '77'), job('lint', '88')],
    });
    w.start();
    await w.idle();
    // What a killed daemon leaves behind is what is stored when the call for run 88 goes out.
    const rerun = h.gh.rerunFailed.bind(h.gh);
    let storedAtSecondRun: string | undefined;
    const spy = vi.spyOn(h.gh, 'rerunFailed').mockImplementation((input) => {
      if (input.runId === '88') storedAtSecondRun = rerunNoticeOf(id)?.line;
      return rerun(input);
    });
    h.gh.failRerunOf.set('88', new GhError('failed', 'run 88 cannot be rerun; already running'));
    await round(w);
    spy.mockRestore();
    expect(storedAtSecondRun).toContain('desktop');
    await w.stop();

    const second = watcher();
    second.start();
    await second.idle();
    await round(second);
    await round(second);
    // The run GitHub refused is run now; the run it took is not run a second time.
    expect(h.gh.reruns).toEqual(['77', '88']);
  });

  it('names only the check GitHub refused when it hard-refuses the second run', async () => {
    const { id, prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, {
      state: 'cancelled',
      failing: [],
      pending: [],
      cancelled: [job('desktop', '77'), job('lint', '88')],
    });
    w.start();
    await w.idle();
    h.gh.failRerunOf.set('88', new GhError('failed', 'HTTP 403: Resource not accessible'));
    await round(w);
    expect(h.gh.reruns).toEqual(['77']);
    expect(noticeOf(id)?.line).toContain('lint');
    expect(noticeOf(id)?.line).not.toContain('desktop');
    expect(noticeOf(id)?.body).toContain('Resource not accessible');
    expect(rerunNoticeOf(id)?.line).toContain('desktop');
    expect(rerunNoticeOf(id)?.line).not.toContain('lint');
    // The refused check is not one 10db will run, and the builder sees no record.
    expect(rerunNoticeOf(id)?.body).not.toContain('as soon as GitHub allows');
    expect(rerunNoticeOf(id)?.body).not.toContain('{');
    await round(w);
    expect(h.gh.reruns).toEqual(['77']);
  });

  it('shows no record in a rerun notice, and a restart still reads it', async () => {
    const { id, prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, {
      state: 'cancelled',
      failing: [],
      pending: [],
      cancelled: [job('desktop', '77'), job('lint', '88')],
    });
    w.start();
    await w.idle();
    h.gh.failRerunOf.set('88', new GhError('failed', 'run 88 cannot be rerun; already running'));
    await round(w);
    expect(h.gh.reruns).toEqual(['77']);
    const body = rerunNoticeOf(id)?.body ?? '';
    expect(body).toContain('as soon as GitHub allows');
    expect(body).not.toContain('{');
    expect(body).not.toContain('Runs 10db started');
    await w.stop();

    // A daemon that restarts reads the stored runs: 77 is not run again, 88 is asked for.
    h.gh.failRerunOf.delete('88');
    const second = watcher();
    second.start();
    await second.idle();
    await round(second);
    await round(second);
    expect(h.gh.reruns).toEqual(['77', '88']);
    expect(rerunNoticeOf(id)?.body).not.toContain('as soon as GitHub allows');
  });

  describe('a check cancelled after a rerun that did not include its run', () => {
    const desktopCancelledLintRunning = {
      state: 'cancelled' as const,
      failing: [],
      pending: [job('lint', '88')],
      cancelled: [job('desktop', '77')],
    };
    const lintCancelled = {
      state: 'cancelled' as const,
      failing: [],
      pending: [],
      cancelled: [job('lint', '88')],
    };
    const desktopAndLintCancelled = {
      ...lintCancelled,
      cancelled: [job('desktop', '77'), job('lint', '88')],
    };

    /** Runs run 77 only, while run 88 is a different run still going. */
    async function rerunOfDesktopOnly(w: PrWatch, prUrl: string): Promise<void> {
      h.gh.setRequiredChecks(prUrl, desktopCancelledLintRunning);
      w.start();
      await w.idle();
      await round(w);
      expect(h.gh.reruns).toEqual(['77']);
    }

    it.each([
      ['the same daemon', false],
      ['a daemon that restarted', true],
    ])('runs it once on %s, with no notice that 10db ran it', async (_, restart) => {
      const { id, prUrl, w } = watching();
      await rerunOfDesktopOnly(w, prUrl);
      let current = w;
      if (restart) {
        await w.stop();
        current = watcher();
      }
      h.gh.setRequiredChecks(prUrl, lintCancelled);
      if (restart) {
        current.start();
        await current.idle();
      } else await round(current);
      for (let i = 0; i < GRACE_ROUNDS + 1; i++) {
        expect(noticeOf(id)).toBeUndefined();
        await round(current);
        if (i === 0) expect(h.gh.reruns).toEqual(['77', '88']);
      }
      expect(h.gh.reruns).toEqual(['77', '88']);
      // Only now that 10db ran it does a notice say so.
      expect(noticeOf(id)?.line).toContain('lint');
      expect(rerunNoticeOf(id)?.line).toContain('lint');
    });

    it('waits for the second read in a row, as for any cancelled check', async () => {
      const { prUrl, w } = watching();
      await rerunOfDesktopOnly(w, prUrl);
      h.gh.setRequiredChecks(prUrl, running('desktop'));
      await round(w);
      h.gh.setRequiredChecks(prUrl, lintCancelled);
      await round(w);
      expect(h.gh.reruns).toEqual(['77']);
      await round(w);
      expect(h.gh.reruns).toEqual(['77', '88']);
    });

    it('runs it when the partial record was closed by a read that listed only the taken run', async () => {
      const { id, prUrl, w } = watching();
      h.gh.setRequiredChecks(prUrl, desktopAndLintCancelled);
      w.start();
      await w.idle();
      h.gh.failRerunOf.set('88', new GhError('failed', 'run 88 cannot be rerun; already running'));
      await round(w);
      expect(h.gh.reruns).toEqual(['77']);

      h.gh.setRequiredChecks(prUrl, desktopCancelledLintRunning);
      await round(w);
      h.gh.setRequiredChecks(prUrl, cancelled('desktop'));
      await round(w);
      h.gh.setRequiredChecks(prUrl, passing);
      await round(w);
      h.gh.setRequiredChecks(prUrl, lintCancelled);
      await round(w);
      expect(noticeOf(id)).toBeUndefined();
      await round(w);
      expect(h.gh.reruns).toEqual(['77', '88']);
      expect(noticeOf(id)).toBeUndefined();
    });

    it('names only the checks 10db ran when one is cancelled again and another is not run yet', async () => {
      const { id, prUrl, w } = watching();
      await rerunOfDesktopOnly(w, prUrl);
      for (let i = 0; i < GRACE_ROUNDS; i++) await round(w);
      expect(noticeOf(id)?.line).toContain('desktop');

      // The notice about desktop does not stop lint, which 10db has not run, from running.
      h.gh.setRequiredChecks(prUrl, desktopAndLintCancelled);
      await round(w);
      expect(noticeOf(id)?.line).not.toContain('lint');
      await round(w);
      expect(h.gh.reruns).toEqual(['77', '88']);
      for (let i = 0; i < GRACE_ROUNDS; i++) await round(w);
      expect(h.gh.reruns).toEqual(['77', '88']);
      expect(noticeOf(id)?.line).toContain('desktop');
      expect(noticeOf(id)?.line).toContain('lint');
    });

    it('after a restart, asks a run refused as still running even when an again notice is showing', async () => {
      const { id, prUrl, w } = watching();
      await rerunOfDesktopOnly(w, prUrl);
      for (let i = 0; i < GRACE_ROUNDS; i++) await round(w);
      expect(noticeOf(id)?.line).toContain('desktop');
      expect(noticeOf(id)?.line).toContain('cancelled again');

      // Runs 88 and 99 are cancelled now: GitHub takes 88 and says 99 is still running.
      h.gh.setRequiredChecks(prUrl, {
        state: 'cancelled',
        failing: [],
        pending: [],
        cancelled: [job('desktop', '77'), job('lint', '88'), job('docs', '99')],
      });
      h.gh.failRerunOf.set('99', new GhError('failed', 'run 99 cannot be rerun; already running'));
      await round(w);
      await round(w);
      expect(h.gh.reruns).toEqual(['77', '88']);
      expect(noticeOf(id)?.line).toContain('cancelled again');
      await w.stop();

      const second = watcher();
      second.start();
      await second.idle();
      for (let i = 0; i < 3; i++) await round(second);
      // Run 99 is asked after the restart; 77 and 88 are never run a second time.
      expect(h.gh.reruns).toEqual(['77', '88', '99']);
    });

    it('after a restart, does not ask a run GitHub hard-refused, while the checks stay cancelled', async () => {
      const { id, prUrl, w } = watching();
      await rerunOfDesktopOnly(w, prUrl);
      h.gh.setRequiredChecks(prUrl, desktopAndLintCancelled);
      await round(w);
      h.gh.failRerunOf.set('88', new GhError('failed', 'HTTP 403: Resource not accessible'));
      await round(w);
      expect(noticeOf(id)?.line).toContain('could not run');
      await w.stop();

      const second = watcher();
      second.start();
      await second.idle();
      for (let i = 0; i < GRACE_ROUNDS + 3; i++) await round(second);
      expect(h.gh.reruns).toEqual(['77']);
      expect(noticeOf(id)?.line).toContain('could not run');
      expect(noticeOf(id)?.body).not.toContain('10db ran');

      // Once the checks clear, the head is asked again like any other cancellation.
      h.gh.setRequiredChecks(prUrl, running('desktop'));
      await round(second);
      expect(noticeOf(id)).toBeUndefined();
      h.gh.setRequiredChecks(prUrl, lintCancelled);
      await round(second);
      await round(second);
      expect(h.gh.reruns).toEqual(['77', '88']);
    });

    it('says GitHub refused, and asks once, when GitHub hard-refuses it', async () => {
      const { id, prUrl, w } = watching();
      await rerunOfDesktopOnly(w, prUrl);
      h.gh.setRequiredChecks(prUrl, desktopAndLintCancelled);
      await round(w);
      h.gh.failRerunOf.set('88', new GhError('failed', 'HTTP 403: Resource not accessible'));
      await round(w);
      expect(h.gh.failRerunOf.has('88')).toBe(false);
      const notice = noticeOf(id);
      expect(notice?.line).toContain('could not run');
      expect(notice?.line).toContain('lint');
      expect(notice?.line).not.toContain('desktop');
      expect(notice?.body).not.toContain('10db ran');
      for (let i = 0; i < GRACE_ROUNDS + 1; i++) await round(w);
      expect(h.gh.reruns).toEqual(['77']);
      expect(noticeOf(id)?.line).toContain('could not run');
    });

    it('says it has no run when the check is a commit status', async () => {
      const { id, prUrl, w } = watching();
      await rerunOfDesktopOnly(w, prUrl);
      const status = { ...job('ci/other', null), jobId: null };
      h.gh.setRequiredChecks(prUrl, { ...lintCancelled, cancelled: [status] });
      await round(w);
      await round(w);
      expect(noticeOf(id)?.line).toContain("can't be run again");
      expect(noticeOf(id)?.body).not.toContain('10db ran');
      expect(h.gh.reruns).toEqual(['77']);
    });

    it('after a restart, does not ask a run listed beside a stopped notice stored with a done record', async () => {
      const { id, prUrl, w } = watching();
      await rerunOfDesktopOnly(w, prUrl);
      // Run 77 is rerun (a done record); then a check with no run is cancelled and 10db stops.
      const status = { ...job('ci/other', null), jobId: null };
      h.gh.setRequiredChecks(prUrl, { ...lintCancelled, cancelled: [status] });
      await round(w);
      await round(w);
      expect(noticeOf(id)?.line).toContain("can't be run again");
      await w.stop();

      // After the restart that check drops out and run 88 is cancelled while the notice still stands.
      // Only the stored 'stopped' kind keeps 10db from asking it: the record alone would say 'again'.
      const second = watcher();
      second.start();
      await second.idle();
      expect(noticeOf(id)?.line).toContain("can't be run again");
      h.gh.setRequiredChecks(prUrl, lintCancelled);
      for (let i = 0; i < GRACE_ROUNDS + 3; i++) await round(second);
      expect(h.gh.reruns).toEqual(['77']);
      expect(noticeOf(id)?.line).toContain("can't be run again");
    });

    describe('the rerun notice beside a notice that 10db stopped', () => {
      const status = { ...job('ci/other', null), jobId: null };
      const statusCancelled = { ...lintCancelled, cancelled: [status] };

      /** Run 77 is run and run 88 is refused as still running, then a check with no run is cancelled. */
      async function stoppedAtNoRun(w: PrWatch, prUrl: string, id: BatchId): Promise<void> {
        h.gh.setRequiredChecks(prUrl, desktopAndLintCancelled);
        w.start();
        await w.idle();
        h.gh.failRerunOf.set(
          '88',
          new GhError('failed', 'run 88 cannot be rerun; already running'),
        );
        await round(w);
        expect(rerunNoticeOf(id)?.body).toContain('as soon as GitHub allows');
        h.gh.setRequiredChecks(prUrl, statusCancelled);
        await round(w);
        await round(w);
        expect(noticeOf(id)?.line).toContain("can't be run again");
      }

      it('does not say 10db runs another check once it stopped at a check with no run', async () => {
        const { id, prUrl, w } = watching();
        await stoppedAtNoRun(w, prUrl, id);
        const body = rerunNoticeOf(id)?.body ?? '';
        expect(body).not.toContain('as soon as GitHub allows');
        expect(body).toContain('will not run another');
        for (let i = 0; i < GRACE_ROUNDS + 1; i++) await round(w);
        expect(h.gh.reruns).toEqual(['77']);
      });

      it('names no notice beside it once the check with no run clears', async () => {
        const { id, prUrl, w } = watching();
        await stoppedAtNoRun(w, prUrl, id);
        h.gh.setRequiredChecks(prUrl, running('desktop'));
        await round(w);
        expect(noticeOf(id)).toBeUndefined();
        const body = rerunNoticeOf(id)?.body ?? '';
        expect(body).toBeTruthy();
        expect(body).not.toContain('beside this one');
        expect(body).not.toContain('will not');
        expect(body).not.toContain('as soon as GitHub allows');
      });

      it('does not say 10db runs the other check once the run it waited for finishes by itself', async () => {
        const { id, prUrl, w } = watching();
        h.gh.setRequiredChecks(prUrl, desktopAndLintCancelled);
        w.start();
        await w.idle();
        h.gh.failRerunOf.set(
          '88',
          new GhError('failed', 'run 88 cannot be rerun; already running'),
        );
        await round(w);
        expect(rerunNoticeOf(id)?.body).toContain('as soon as GitHub allows');

        h.gh.setRequiredChecks(prUrl, running('desktop'));
        await round(w);
        expect(noticeOf(id)).toBeUndefined();
        const body = rerunNoticeOf(id)?.body ?? '';
        expect(body).toBeTruthy();
        expect(body).not.toContain('as soon as GitHub allows');
        expect(body).not.toContain('beside this one');
      });

      it('does the same when a restart came between', async () => {
        const { id, prUrl, w } = watching();
        h.gh.setRequiredChecks(prUrl, desktopAndLintCancelled);
        w.start();
        await w.idle();
        h.gh.failRerunOf.set(
          '88',
          new GhError('failed', 'run 88 cannot be rerun; already running'),
        );
        await round(w);
        await w.stop();

        const second = watcher();
        h.gh.setRequiredChecks(prUrl, running('desktop'));
        second.start();
        await second.idle();
        await round(second);
        const body = rerunNoticeOf(id)?.body ?? '';
        expect(body).toBeTruthy();
        expect(body).not.toContain('as soon as GitHub allows');
      });

      it('still asks for a run cancelled again on the head after the waiting check clears, also after a restart', async () => {
        const { id, prUrl, w } = watching();
        h.gh.setRequiredChecks(prUrl, desktopAndLintCancelled);
        w.start();
        await w.idle();
        h.gh.failRerunOf.set(
          '88',
          new GhError('failed', 'run 88 cannot be rerun; already running'),
        );
        await round(w);
        expect(h.gh.reruns).toEqual(['77']);
        h.gh.setRequiredChecks(prUrl, running('desktop'));
        await round(w);
        expect(rerunNoticeOf(id)?.body).not.toContain('as soon as GitHub allows');
        await w.stop();

        const second = watcher();
        second.start();
        await second.idle();
        h.gh.failRerunOf.clear();
        h.gh.setRequiredChecks(prUrl, lintCancelled);
        await round(second);
        await round(second);
        expect(h.gh.reruns).toEqual(['77', '88']);
      });

      it('names no notice beside it and does not say it will not ask again once the refused check clears', async () => {
        const { id, prUrl, w } = watching();
        await rerunOfDesktopOnly(w, prUrl);
        h.gh.setRequiredChecks(prUrl, desktopAndLintCancelled);
        await round(w);
        h.gh.failRerunOf.set('88', new GhError('failed', 'HTTP 403: Resource not accessible'));
        await round(w);
        expect(noticeOf(id)?.line).toContain('could not run');
        expect(rerunNoticeOf(id)?.body).toContain('will not ask again');

        // The builder runs it by hand: the check clears.
        h.gh.setRequiredChecks(prUrl, running('desktop'));
        await round(w);
        expect(noticeOf(id)).toBeUndefined();
        const body = rerunNoticeOf(id)?.body ?? '';
        expect(body).toBeTruthy();
        expect(body).not.toContain('beside this one');
        expect(body).not.toContain('will not ask again');

        // Cancelled again on the same head, 10db does ask again.
        h.gh.setRequiredChecks(prUrl, lintCancelled);
        await round(w);
        await round(w);
        expect(h.gh.reruns).toEqual(['77', '88']);
      });

      describe('when a required check fails and none is cancelled', () => {
        const failed = (...names: string[]) => ({
          state: 'failing' as const,
          failing: names.map((n) => job(n)),
          pending: [],
          cancelled: [],
        });

        it('does not say 10db runs another check once the run it waited for ends in a failure', async () => {
          const { id, prUrl, w } = watching();
          h.gh.setRequiredChecks(prUrl, desktopAndLintCancelled);
          w.start();
          await w.idle();
          h.gh.failRerunOf.set(
            '88',
            new GhError('failed', 'run 88 cannot be rerun; already running'),
          );
          await round(w);
          expect(rerunNoticeOf(id)?.body).toContain('as soon as GitHub allows');

          h.gh.setRequiredChecks(prUrl, failed('lint'));
          await round(w);
          const body = rerunNoticeOf(id)?.body ?? '';
          expect(body).toBeTruthy();
          expect(body).not.toContain('as soon as GitHub allows');
          expect(body).not.toContain('beside this one');
          // A failing check starts no rerun, and none follows it.
          for (let i = 0; i < GRACE_ROUNDS + 1; i++) await round(w);
          expect(h.gh.reruns).toEqual(['77']);
        });

        it('takes the cancelled-check notice off when the refused check fails instead', async () => {
          const { id, prUrl, w } = watching();
          await rerunOfDesktopOnly(w, prUrl);
          h.gh.setRequiredChecks(prUrl, desktopAndLintCancelled);
          await round(w);
          h.gh.failRerunOf.set('88', new GhError('failed', 'HTTP 403: Resource not accessible'));
          await round(w);
          expect(noticeOf(id)?.line).toContain('could not run');
          expect(rerunNoticeOf(id)?.body).toContain('will not ask again');

          h.gh.setRequiredChecks(prUrl, failed('lint'));
          await round(w);
          expect(noticeOf(id)).toBeUndefined();
          const body = rerunNoticeOf(id)?.body ?? '';
          expect(body).toBeTruthy();
          expect(body).not.toContain('beside this one');
          expect(body).not.toContain('will not ask again');
          expect(h.gh.reruns).toEqual(['77']);
        });

        it('still leaves a failing check with another one cancelled alone, and runs nothing', async () => {
          const { id, prUrl, w } = watching();
          h.gh.setRequiredChecks(prUrl, desktopAndLintCancelled);
          w.start();
          await w.idle();
          h.gh.failRerunOf.set(
            '88',
            new GhError('failed', 'run 88 cannot be rerun; already running'),
          );
          await round(w);
          const before = rerunNoticeOf(id)?.body;
          h.gh.setRequiredChecks(prUrl, { ...failed('build'), cancelled: [job('lint', '88')] });
          for (let i = 0; i < GRACE_ROUNDS + 1; i++) await round(w);
          expect(rerunNoticeOf(id)?.body).toBe(before);
          expect(h.gh.reruns).toEqual(['77']);
        });
      });
    });
  });

  it('does not run an old head again when its stored rerun notice carries no record', async () => {
    const { id, prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, cancelled('desktop'));
    w.start();
    await w.idle();
    await round(w);
    await w.stop();
    const notice = rerunNoticeOf(id);
    expect(notice).toBeDefined();
    // As an older daemon stored it: the head was asked, and which runs is not known.
    h.state.write((write) => {
      setBatchNotice(write, id, {
        tone: 'info',
        key: `checks-rerun:${HEAD_A}`,
        line: notice?.line ?? '',
        body: 'GitHub cancelled a check, so 10db ran it again once for this head.',
      });
    });

    const second = watcher();
    h.gh.setRequiredChecks(prUrl, {
      state: 'cancelled',
      failing: [],
      pending: [],
      cancelled: [job('lint', '88')],
    });
    second.start();
    await second.idle();
    for (let i = 0; i < GRACE_ROUNDS + 1; i++) await round(second);
    expect(h.gh.reruns).toEqual(['77']);
    expect(noticeOf(id)?.line).toContain('lint');
  });

  describe('a check 10db could not run, then a restart', () => {
    /** The check is cancelled, 10db stops with `line`, the daemon restarts and the check clears. */
    async function clearedAfterRestart(
      id: BatchId,
      prUrl: string,
      w: PrWatch,
      line: string,
    ): Promise<PrWatch> {
      w.start();
      await w.idle();
      await round(w);
      expect(noticeOf(id)?.line).toContain(line);
      await w.stop();

      const second = watcher();
      second.start();
      await second.idle();
      expect(noticeOf(id)?.line).toContain(line);
      h.gh.setRequiredChecks(prUrl, running('desktop'));
      await round(second);
      expect(noticeOf(id)).toBeUndefined();
      return second;
    }

    it('never says 10db ran a check GitHub refused', async () => {
      const { id, prUrl, w } = watching();
      h.gh.setRequiredChecks(prUrl, cancelled('desktop'));
      h.gh.failRerunOf.set('77', new GhError('failed', 'HTTP 403: Resource not accessible'));
      const second = await clearedAfterRestart(id, prUrl, w, 'could not run');

      h.gh.failRerunOf.set('77', new GhError('failed', 'HTTP 403: Resource not accessible'));
      h.gh.setRequiredChecks(prUrl, cancelled('desktop'));
      await round(second);
      await round(second);
      for (let i = 0; i < GRACE_ROUNDS + 1; i++) await round(second);
      expect(h.gh.reruns).toEqual([]);
      expect(noticeOf(id)?.line).toContain('could not run');
      expect(noticeOf(id)?.body).not.toContain('10db ran');
    });

    it('never says 10db ran a check with no Actions run', async () => {
      const { id, prUrl, w } = watching();
      const status = { ...job('ci/other', null), jobId: null };
      const statusCancelled = {
        state: 'cancelled' as const,
        failing: [],
        pending: [],
        cancelled: [status],
      };
      h.gh.setRequiredChecks(prUrl, statusCancelled);
      const second = await clearedAfterRestart(id, prUrl, w, "can't be run again");

      h.gh.setRequiredChecks(prUrl, statusCancelled);
      await round(second);
      await round(second);
      for (let i = 0; i < GRACE_ROUNDS + 1; i++) await round(second);
      expect(noticeOf(id)?.line).toContain("can't be run again");
      expect(noticeOf(id)?.body).not.toContain('10db ran');
    });
  });

  it('gives a new head its own rerun', async () => {
    const { id, prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, cancelled('desktop'));
    w.start();
    await w.idle();
    await round(w);
    expect(h.gh.reruns).toEqual(['77']);
    h.gh.setHead(prUrl, HEAD_B);
    await round(w);
    await round(w);
    expect(h.gh.reruns).toEqual(['77', '77']);
    expect(noticeOf(id)).toBeUndefined();
  });

  it('does not run the check a second time when the daemon restarts after the rerun, before any notice', async () => {
    const { id, prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, cancelled('desktop'));
    w.start();
    await w.idle();
    await round(w);
    expect(h.gh.reruns).toEqual(['77']);
    expect(noticeOf(id)).toBeUndefined();
    await w.stop();

    // The new daemon reads the same head cancelled again: the rerun already happened.
    const second = watcher();
    second.start();
    await second.idle();
    await round(second);
    await round(second);
    expect(h.gh.reruns).toEqual(['77']);
    // It leaves the check alone and says so once the minutes a rerun gets to start have passed.
    for (let i = 0; i < GRACE_ROUNDS; i++) await round(second);
    expect(h.gh.reruns).toEqual(['77']);
    expect(noticeOf(id)?.line).toContain('desktop');
  });

  it('runs the check once more on a new head after a restart', async () => {
    const { prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, cancelled('desktop'));
    w.start();
    await w.idle();
    await round(w);
    await w.stop();

    h.gh.setHead(prUrl, HEAD_B);
    const second = watcher();
    second.start();
    await second.idle();
    await round(second);
    expect(h.gh.reruns).toEqual(['77', '77']);
  });

  it('runs the check on a new head after a restart, though an older head has a stopped notice stored', async () => {
    const { id, prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, cancelled('desktop'));
    h.gh.failRerunOf.set('77', new GhError('failed', 'HTTP 403: Resource not accessible'));
    w.start();
    await w.idle();
    await round(w);
    expect(noticeOf(id)?.line).toContain('could not run');
    await w.stop();

    // A new commit moves the pull request to head B while the daemon is down.
    h.gh.failRerunOf.clear();
    h.gh.setHead(prUrl, HEAD_B);
    const second = watcher();
    second.start();
    await second.idle();
    await round(second);
    expect(h.gh.reruns).toEqual(['77']);
    // The notice about head A's checks is gone, not left standing for head B.
    expect(noticeOf(id)).toBeUndefined();
  });

  // A notice stored by a daemon from before the `record` field names no head. Nothing stored says
  // which head it was for (the batch holds no head of its pull request), so 10db cannot tell it from
  // one for the current head: it is read as 'stopped' and left to go when the checks clear. A rerun
  // on a guess would run a head's check twice.
  it('leaves a stored cancelled notice that names no head standing after a restart, and runs nothing', async () => {
    const { id, prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, cancelled('desktop'));
    h.state.write((write) => {
      setBatchNotice(write, id, {
        tone: 'warning',
        key: 'checks-cancelled',
        line: 'Required check "desktop" was cancelled and 10db could not run it again',
        body: 'GitHub cancelled a check that main requires.',
      });
    });
    w.start();
    await w.idle();
    for (let i = 0; i < GRACE_ROUNDS + 3; i++) await round(w);
    expect(h.gh.reruns).toEqual([]);
    expect(noticeOf(id)?.line).toContain('could not run');

    // Once the check clears, the notice goes with it.
    h.gh.setRequiredChecks(prUrl, running('desktop'));
    await round(w);
    expect(noticeOf(id)).toBeUndefined();
  });

  it('keeps a stopped notice of the same head after a restart', async () => {
    const { id, prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, cancelled('desktop'));
    h.gh.failRerunOf.set('77', new GhError('failed', 'HTTP 403: Resource not accessible'));
    w.start();
    await w.idle();
    await round(w);
    await w.stop();

    h.gh.failRerunOf.clear();
    const second = watcher();
    second.start();
    await second.idle();
    await round(second);
    await round(second);
    expect(h.gh.reruns).toEqual([]);
    expect(noticeOf(id)?.line).toContain('could not run');
  });

  it('leaves a check that is genuinely running pending, with nothing rerun', async () => {
    const { id, prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, running('desktop'));
    w.start();
    await w.idle();
    await round(w);
    await round(w);
    expect(stored(id).prRequired).toMatchObject({ state: 'pending', cancelled: [] });
    expect(h.gh.reruns).toEqual([]);
    expect(noticeOf(id)).toBeUndefined();
  });

  it('runs nothing on a pull request that conflicts with its base', async () => {
    const { prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, cancelled('desktop'));
    h.gh.setMergeBlocked(prUrl, 'conflicts');
    w.start();
    await w.idle();
    await round(w);
    await round(w);
    expect(h.gh.reruns).toEqual([]);
  });

  it('runs the check of a pull request held for the builder too', async () => {
    const { prUrl, w } = watching(false);
    h.gh.setRequiredChecks(prUrl, cancelled('desktop'));
    w.start();
    await w.idle();
    await round(w);
    expect(h.gh.reruns).toEqual(['77']);
  });
});
