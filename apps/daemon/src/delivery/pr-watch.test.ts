import {
  findOpenByFoldKey,
  getBatch,
  insertBatch,
  listEventsAfter,
  listWorkstreams,
  seedProject,
  transitionBatch,
} from '@10db/db';
import type { BatchId, ProjectId } from '@10db/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { waitFor } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { GhError, type CheckRollupItem, type Gh } from '../github';
import { createPrWatch, subscribePrWatch, type PrWatch } from './index';

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
): { id: BatchId; prUrl: string } {
  const prUrl = missing ?? h.gh.openPr(`10db/${title}`);
  const id = h.state.write((ctx) =>
    insertBatch(ctx, { projectId, title, baseBranch: 'main', worktreePath: `/tmp/wt/${title}` }),
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

/** h.gh, except that the prStatus call numbered `n` (from 1) fails with `error`. */
function failingCall(n: number, error: GhError): Gh {
  let count = 0;
  return {
    authStatus: () => h.gh.authStatus(),
    authLogin: () => h.gh.authLogin(),
    prView: (input) => h.gh.prView(input),
    prCreate: (input) => h.gh.prCreate(input),
    prStatus: (input) => {
      count += 1;
      return count === n ? Promise.reject(error) : h.gh.prStatus(input);
    },
  };
}
const polls = () => h.gh.calls.filter((c) => c.method === 'prStatus').length;
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
    expect(card.detail).toEqual({ batchId: id, prUrl, link: prUrl });
    expect(pr(id)).toMatchObject({ state: 'closed' });
    expect(findOpenByFoldKey(h.store.db, h.project.id, `pr-closed:${id}`)).toBeDefined();
    expect(findOpenByFoldKey(h.store.db, h.project.id, `pr-checks:${id}`)).toBeUndefined();

    const before = polls();
    await round(w, INTERVAL * 4);
    expect(polls()).toBe(before);
    expect(h.cards()).toHaveLength(1);
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
    expect(card.detail).toMatchObject({ batchId: a.id, prUrl: a.prUrl });

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

  it('keeps the gh card open after a round where one call answered and a later one failed', async () => {
    setup();
    const a = shipped(h.project.id, 'Alpha');
    const b = shipped(h.project.id, 'Beta');
    const w = watcher({ ...h.ctx, gh: failingCall(2, new GhError('failed', 'HTTP 502')) });
    w.start();
    await w.idle();
    expect(pr(a.id)).toMatchObject({ state: 'open' });
    expect(pr(b.id)).toMatchObject({ state: 'unknown', unknownReason: 'HTTP 502' });
    const card = h.only(h.cards());
    expect(card.body).toContain("gh couldn't reach GitHub: HTTP 502");

    // A later round where every call answers withdraws it.
    await round(w);
    expect(pr(b.id)).toMatchObject({ state: 'open' });
    expect(h.cards()).toEqual([]);
  });

  it('leaves an open gh card alone while a round half answers', async () => {
    setup();
    const a = shipped(h.project.id, 'Alpha');
    const b = shipped(h.project.id, 'Beta');
    h.gh.auth = 'signed_out';
    // Call 1 is signed out; call 3 (Beta in the second round) fails after Alpha answered.
    const w = watcher({ ...h.ctx, gh: failingCall(3, new GhError('failed', 'HTTP 502')) });
    w.start();
    await w.idle();
    expect(h.cards()).toHaveLength(1);

    h.gh.auth = 'ok';
    await round(w);
    expect(pr(a.id)).toMatchObject({ state: 'open' });
    expect(pr(b.id)).toMatchObject({ state: 'unknown' });
    expect(h.cards()).toHaveLength(1);
  });

  it('withdraws the gh card in its own project after that project has no pull request left to read', async () => {
    setup();
    const second = seedProject(h.store, { delivery: 'pull_request' });
    const a = shipped(h.project.id, 'Alpha');
    const b = shipped(second.id, 'Beta');
    h.gh.auth = 'signed_out';
    // Call 1 is Alpha signed out; call 3 is Beta in round 2, after Alpha answered merged.
    const w = watcher({ ...h.ctx, gh: failingCall(3, new GhError('failed', 'HTTP 502')) });
    w.start();
    await w.idle();
    expect(h.only(h.cards()).projectId).toBe(h.project.id);

    h.gh.auth = 'ok';
    h.gh.setState(a.prUrl, 'MERGED');
    await round(w);
    expect(pr(a.id)).toMatchObject({ state: 'merged' });
    expect(pr(b.id)).toMatchObject({ state: 'unknown', unknownReason: 'HTTP 502' });
    expect(h.cards()).toHaveLength(1);

    // Only Beta is read now, in the second project; gh answers, so the card in the first goes.
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
    h.gh.auth = 'signed_out';
    // Call 1 is Alpha signed out; in round 2 Alpha merges (2), Beta answers (3), Gamma fails (4).
    const w = watcher({ ...h.ctx, gh: failingCall(4, new GhError('failed', 'HTTP 502')) });
    w.start();
    await w.idle();
    expect(h.only(h.cards()).projectId).toBe(h.project.id);

    h.gh.auth = 'ok';
    h.gh.setState(a.prUrl, 'MERGED');
    await round(w);
    expect(pr(a.id)).toMatchObject({ state: 'merged' });
    expect(pr(b.id)).toMatchObject({ state: 'open' });
    expect(pr(c.id)).toMatchObject({ state: 'unknown' });
    expect(h.cards()).toHaveLength(1);

    // Only the second project is read now; Beta goes unknown, and the first project's card stays the one card.
    h.gh.failNext.set('prStatus', new GhError('failed', 'HTTP 503'));
    await round(w);
    expect(pr(b.id)).toMatchObject({ state: 'unknown', unknownReason: 'HTTP 503' });
    expect(h.only(h.cards()).projectId).toBe(h.project.id);
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

  it('stop aborts the call in flight, records nothing and leaves no timer', async () => {
    setup();
    const { id } = shipped(h.project.id, 'Alpha');
    let entered = false;
    const hanging: Gh = {
      authStatus: () => h.gh.authStatus(),
      authLogin: () => h.gh.authLogin(),
      prView: (input) => h.gh.prView(input),
      prCreate: (input) => h.gh.prCreate(input),
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
