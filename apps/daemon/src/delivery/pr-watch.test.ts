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
import { GhError, type CheckRollupItem, type Gh } from '../github';
import { prCardKey } from './cards';
import { raiseIn } from './context';
import { createPrWatch, subscribePrWatch, type PrWatch } from './index';
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

const notices = (id: BatchId) => getBatch(h.store.db, id).notices.map((n) => n.key);
const noticeEvents = (id: BatchId) =>
  listEventsAfter(h.store.db, 0, 10_000).filter(
    (e) =>
      e.type === 'batch.updated' &&
      e.entityId === id &&
      JSON.stringify(e.data) === JSON.stringify({ changed: ['notices'] }),
  ).length;

const polls = () => h.gh.calls.filter((c) => c.method === 'prStatus').length;
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
          tier: 'ask',
          urgency: 'high',
          closesWhen: { by: 'answer' },
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
    expect(card.body).toContain('Settings › Integrations');
    expect(card.body).toContain('unknown');
    // No link: the desktop's Open on GitHub would open one pull request, which says nothing about gh.
    expect(card.detail).toEqual({
      batchId: a.id,
      prUrl: a.prUrl,
      ghCheck: true,
      openIntegrations: 'github',
    });

    await round(w);
    expect(polls()).toBe(2);
    expect(h.cards()).toHaveLength(1);

    h.gh.auth = 'ok';
    await round(w);
    expect(pr(a.id)).toMatchObject({ state: 'open', checks: 'none', unknownReason: null });
    expect(pr(b.id)).toMatchObject({ state: 'open' });
    expect(h.cards()).toEqual([]);
  });

  it('keeps shipping while prStatus fails', async () => {
    setup();
    const offline: Gh = {
      authStatus: () => h.gh.authStatus(),
      authLogin: () => h.gh.authLogin(),
      noreplyEmail: () => h.gh.noreplyEmail(),
      prView: (input) => h.gh.prView(input),
      prBranches: (input) => h.gh.prBranches(input),
      prCreate: (input) => h.gh.prCreate(input),
      repoAllowsAutoMerge: () => h.gh.repoAllowsAutoMerge(),
      prAutoMerge: (input) => h.gh.prAutoMerge(input),
      prMerge: (input) => h.gh.prMerge(input),
      prRequiredChecks: (input) => h.gh.prRequiredChecks(input),
      jobLog: (input) => h.gh.jobLog(input),
      rerunFailed: (input) => h.gh.rerunFailed(input),
      jobHadNoRunner: (input) => h.gh.jobHadNoRunner(input),
      prInMergeQueue: (input) => h.gh.prInMergeQueue(input),
      prReady: (input) => h.gh.prReady(input),
      prEditBase: (input) => h.gh.prEditBase(input),
      prEditBody: (input) => h.gh.prEditBody(input),
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

  it('stop aborts the call in flight, records nothing and leaves no timer', async () => {
    setup();
    const { id } = shipped(h.project.id, 'Alpha');
    let entered = false;
    const hanging: Gh = {
      authStatus: () => h.gh.authStatus(),
      authLogin: () => h.gh.authLogin(),
      noreplyEmail: () => h.gh.noreplyEmail(),
      prView: (input) => h.gh.prView(input),
      prBranches: (input) => h.gh.prBranches(input),
      prCreate: (input) => h.gh.prCreate(input),
      repoAllowsAutoMerge: () => h.gh.repoAllowsAutoMerge(),
      prAutoMerge: (input) => h.gh.prAutoMerge(input),
      prMerge: (input) => h.gh.prMerge(input),
      prRequiredChecks: (input) => h.gh.prRequiredChecks(input),
      jobLog: (input) => h.gh.jobLog(input),
      rerunFailed: (input) => h.gh.rerunFailed(input),
      jobHadNoRunner: (input) => h.gh.jobHadNoRunner(input),
      prInMergeQueue: (input) => h.gh.prInMergeQueue(input),
      prReady: (input) => h.gh.prReady(input),
      prEditBase: (input) => h.gh.prEditBase(input),
      prEditBody: (input) => h.gh.prEditBody(input),
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

    it.each([['a daemon that restarted', true]])(
      'runs it once on %s, with no notice that 10db ran it',
      async (_, restart) => {
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
      },
    );

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
});

describe('a required job GitHub cancelled because no runner picked it up', () => {
  const HEAD_A = 'a'.repeat(40);

  /** The `attempt`th run of the `desktop` job: a rerun makes a new job, so a new job id. */
  const desktop = (attempt: number, runId: string | null = '77') => ({
    name: 'desktop',
    link: `https://github.com/acme/widgets/actions/runs/${runId ?? 'x'}/job/${String(900 + attempt)}`,
    jobId: String(900 + attempt),
    runId,
    description: null,
  });
  const cancelledJobs = (...jobs: ReturnType<typeof desktop>[]) => ({
    state: 'cancelled' as const,
    failing: [],
    pending: [],
    cancelled: jobs,
  });
  /** GitHub cancelled this attempt of `desktop` with the not-acquired annotation. */
  const noRunner = (attempt: number) => {
    h.gh.noRunnerJobs.add(String(900 + attempt));
    return desktop(attempt);
  };

  const stored = (id: BatchId) => getBatch(h.store.db, id);
  const noticeOf = (id: BatchId, head = HEAD_A) =>
    stored(id).notices.find((n) => n.key === `checks-no-runner:${head}`);

  function watching(): { id: BatchId; prUrl: string; w: PrWatch } {
    setup();
    const made = shipped(h.project.id, 'Alpha');
    h.gh.setHead(made.prUrl, HEAD_A);
    return { ...made, w: watcher() };
  }

  it('runs its failed jobs again at the first read, with a notice and no card', async () => {
    const { id, prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, cancelledJobs(noRunner(1)));
    w.start();
    await w.idle();
    expect(h.gh.reruns).toEqual(['77']);
    expect(h.cards()).toEqual([]);
    const notice = noticeOf(id);
    expect(notice?.tone).toBe('info');
    expect(notice?.line).toContain('desktop');
    expect(notice?.line).toContain('no runner');
    expect(notice?.body).toContain('runner shortage');
    expect(notice?.body).toContain('not a test failure');
    // The ordinary cancelled-check path has nothing to say about it.
    expect(stored(id).notices.map((n) => n.key)).toEqual([`checks-no-runner:${HEAD_A}`]);
  });

  it('keeps the count through a restart', async () => {
    const { prUrl, w } = watching();
    h.gh.setRequiredChecks(prUrl, cancelledJobs(noRunner(1)));
    w.start();
    await w.idle();
    h.gh.setRequiredChecks(prUrl, cancelledJobs(noRunner(2)));
    await round(w);
    expect(h.gh.reruns).toHaveLength(2);
    await w.stop();

    const second = watcher();
    second.start();
    await second.idle();
    expect(h.gh.reruns).toHaveLength(2);
    h.gh.setRequiredChecks(prUrl, cancelledJobs(noRunner(3)));
    await round(second);
    expect(h.gh.reruns).toHaveLength(3);
    h.gh.setRequiredChecks(prUrl, cancelledJobs(noRunner(4)));
    await round(second);
    expect(h.gh.reruns).toHaveLength(3);
    expect(h.only(h.cards()).title).toContain('no runner');
  });
});
