import type { BatchId, ProjectId } from '@10db/contracts';
import { getBatch, insertBatch, listBatches, transitionBatch } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { ManualClock } from '../clock';
import { GhError, type RequiredChecks } from '../github';
import { createPrWatch, type PrWatch } from './index';

// A pull request in the base's merge queue (main is moving to one): a push to its branch takes it
// out of the queue, and a queued pull request reads BLOCKED with its checks pending, which the
// watch's own features could take for stuck. While it is queued 10db pushes nothing to it and starts
// no watchdog, rerun, catch-up or fix; the queue removing it is a failed required check.

const INTERVAL = 120_000;
const GRACE_ROUNDS = 5;
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

let h: DeliveryHarness;
let clock: ManualClock;
const watches: PrWatch[] = [];
beforeEach(() => {
  h = createDeliveryHarness();
  clock = new ManualClock();
});
afterEach(async () => {
  for (const w of watches.splice(0)) await w.stop();
  h.close();
});

/** The watch of the daemon: a spy for landing (what it was asked), and CI fixes on. */
function watching(): { asked: string[]; w: PrWatch } {
  const asked: string[] = [];
  const w = createPrWatch({
    ctx: h.ctx,
    clock,
    intervalMs: INTERVAL,
    ciFix: { dataDir: h.dataDir },
    landing: {
      catchUp: (id) => asked.push(`catch-up ${id}`),
      restartCi: (id) => {
        asked.push(`restart-ci ${id}`);
        return true;
      },
      retryMerge: (id) => asked.push(`retry ${id}`),
    },
  });
  watches.push(w);
  return { asked, w };
}

function shipped(projectId: ProjectId): { id: BatchId; prUrl: string } {
  const prUrl = h.gh.openPr('10db/Alpha');
  const id = h.state.write((ctx) =>
    insertBatch(ctx, {
      projectId,
      title: 'Alpha',
      baseBranch: 'main',
      autoMerge: true,
      worktreePath: '/tmp/wt/Alpha',
    }),
  ).id;
  for (const to of ['OPEN', 'SHIPPING'] as const)
    h.state.write((ctx) => transitionBatch(ctx, id, { to }));
  h.state.write((ctx) =>
    transitionBatch(ctx, id, {
      to: 'SHIPPED',
      patch: { repo: 'acme/widgets', prUrl, branch: '10db/Alpha' },
    }),
  );
  h.gh.setHead(prUrl, HEAD_A);
  return { id, prUrl };
}

const round = async (w: PrWatch): Promise<void> => {
  clock.advance(INTERVAL);
  await w.idle();
};
const rounds = async (w: PrWatch, n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await round(w);
};

const stored = (id: BatchId) => getBatch(h.store.db, id);
const job = (name: string, jobId: string | null = '77') => ({
  name,
  link: `https://github.com/acme/widgets/actions/runs/1/job/${name}`,
  jobId,
  runId: jobId === null ? null : '1',
  description: null,
});
const requiredOf = (
  state: RequiredChecks['state'],
  jobs: Partial<Pick<RequiredChecks, 'failing' | 'pending' | 'cancelled'>> = {},
): RequiredChecks => ({ state, failing: [], pending: [], cancelled: [], ...jobs });
const logReads = () => h.gh.calls.filter((c) => c.method === 'jobLog').length;
const fixes = () => listBatches(h.store.db, {}).filter((b) => b.ciFixOf !== null);

describe('a pull request in the merge queue', () => {
  it('gets no catch-up while queued or while the queue cannot be read, though it reads as conflicting', async () => {
    const { id, prUrl } = shipped(h.project.id);
    h.gh.setMergeable(prUrl, 'CONFLICTING');
    h.gh.setMergeBlocked(prUrl, 'conflicts');
    // Taken for queued by neither guess nor default when the queue cannot be read: nothing is pushed.
    h.gh.failQueueRead.set(prUrl, new GhError('failed', 'HTTP 502'));
    const { asked, w } = watching();
    w.start();
    await w.idle();
    await rounds(w, 2);
    expect(asked).toEqual([]);
    expect(stored(id).state).toBe('SHIPPED');

    h.gh.failQueueRead.delete(prUrl);
    h.gh.setInMergeQueue(prUrl, true);
    await rounds(w, 2);
    expect(asked).toEqual([]);
    // Queued, not "conflicts with main": the card line follows the queue.
    expect(stored(id).prMergeBlocked).toBe('queued');

    // The same pull request out of the queue is caught up, so the guard is the queue and nothing else.
    h.gh.setInMergeQueue(prUrl, false);
    await round(w);
    expect(asked).toContain(`catch-up ${id}`);
  });

  it('gets no retried merge and no CI fix while queued, though it reads clean with a failing required check', async () => {
    const { prUrl } = shipped(h.project.id);
    h.gh.setRequiredChecks(prUrl, requiredOf('failing', { failing: [job('build')] }));
    h.gh.setJobLog('77', { kind: 'ready', log: 'boom\n' });
    h.gh.setInMergeQueue(prUrl, true);
    const { asked, w } = watching();
    w.start();
    await w.idle();
    await rounds(w, 2);
    expect(asked).toEqual([]);
    expect(logReads()).toBe(0);
    expect(fixes()).toEqual([]);

    h.gh.setRequiredChecks(prUrl, requiredOf('passing'));
    h.gh.setInMergeQueue(prUrl, false);
    await round(w);
    expect(asked.some((a) => a.startsWith('retry'))).toBe(true);
  });

  it('is not taken for stuck, and its queued minutes do not count toward the no-CI watchdog', async () => {
    const { id, prUrl } = shipped(h.project.id);
    h.gh.setBlockedOnChecks(prUrl, true);
    const { asked, w } = watching();
    w.start();
    await w.idle();
    await rounds(w, GRACE_ROUNDS - 2);
    // Out of the queue a clean pull request is asked to merge each round; queued, nothing is asked.
    const beforeQueue = asked.length;
    h.gh.setInMergeQueue(prUrl, true);
    await rounds(w, GRACE_ROUNDS * 3);
    expect(asked.slice(beforeQueue)).toEqual([]);
    expect(stored(id).notices).toEqual([]);

    h.gh.setInMergeQueue(prUrl, false);
    await round(w);
    expect(asked.filter((a) => a.startsWith('restart-ci'))).toEqual([]);
    expect(stored(id).notices).toEqual([]);

    // A push took it out of the queue; the new head is BLOCKED with no checks: now the watchdog's
    // minutes count.
    h.gh.setHead(prUrl, HEAD_B);
    await rounds(w, GRACE_ROUNDS + 1);
    expect(asked.filter((a) => a.startsWith('restart-ci'))).toEqual([`restart-ci ${id}`]);
  });
});

describe('a pull request the merge queue removed', () => {
  /** Queued at HEAD_A with its checks passing, as the queue holds it. */
  async function queued(): Promise<{ id: BatchId; prUrl: string; w: PrWatch; asked: string[] }> {
    const { id, prUrl } = shipped(h.project.id);
    h.gh.setRequiredChecks(prUrl, requiredOf('passing'));
    h.gh.setInMergeQueue(prUrl, true);
    const { asked, w } = watching();
    w.start();
    await w.idle();
    expect(stored(id).prMergeBlocked).toBe('queued');
    return { id, prUrl, w, asked };
  }

  it('is a failed required check: stored failing, fixing stopped with its card, the task Blocked', async () => {
    const { id, prUrl, w } = await queued();
    // The group failed: the queue let go, the head is unchanged and the pull request's own checks pass.
    h.gh.setInMergeQueue(prUrl, false);
    await round(w);

    const root = stored(id);
    expect(root.prMergeBlocked).toBeNull();
    expect(root.prRequired).toMatchObject({
      state: 'failing',
      failing: [{ name: 'Merge queue', jobId: null, runId: null }],
    });
    // No log to read for it, so no fix and no push: the one card names it.
    expect(root.ciStopped).toBe('no_log');
    expect(fixes()).toEqual([]);
    const card = h.only(h.cards());
    expect(card.title).toContain('CI still failing on Alpha: Merge queue');
    expect(card.body).toContain('- Merge queue: https://github.com/acme/widgets/pull/1');
  });

  it('is a failure after a restart too: the stored queued mark is the memory', async () => {
    const { id, prUrl, w } = await queued();
    await w.stop();
    h.gh.setInMergeQueue(prUrl, false);
    const { w: next } = watching();
    next.start();
    await next.idle();
    expect(stored(id).prRequired?.state).toBe('failing');
    expect(stored(id).ciStopped).toBe('no_log');
  });
});
