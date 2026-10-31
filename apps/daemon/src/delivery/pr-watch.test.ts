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
import { GhError, UNREADABLE_CHECK, type CheckRollupItem, type Gh } from '../github';
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
    expect(card.detail).toEqual({ batchId: a.id, prUrl: a.prUrl });

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
