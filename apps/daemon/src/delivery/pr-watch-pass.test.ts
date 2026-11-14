import {
  PassNoticeKind,
  PassState,
  type BatchId,
  type PassId,
  type ProjectInput,
  type TaskDto,
} from '@10db/contracts';
import {
  closePass,
  getBatch,
  getPass,
  getPassProgress,
  listBatches,
  setClosePlan,
  setPassPullRequest,
  transitionBatch,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { ManualClock } from '../clock';
import { PrMergeable, PrState, type CheckRollupItem } from '../github';
import { createPrWatch, openPass, type PrWatch, type PutBackKeptWork } from './index';
import type { PullRequestLanding } from './pr-watch';

// Workbench spec §5.5, D19, D22: the watch reads a pass's pull request from the moment Open Pull
// Request makes one, for merged and closed only while the pass is open. Failing checks are one header
// notice offered with Send to Agent; no fix, catch-up, merge, rerun or card is started for it. On a
// `local` project the same holds after the close, since a fix needs a copy the project has none of.

const PAGES: Partial<ProjectInput> = {
  areas: [
    { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
    { name: 'people', globs: ['src/people/**'], role: 'page', route: '/people' },
  ],
};

const nothingKept: PutBackKeptWork = () => Promise.resolve({ applied: [], left: [] });

const job = (name: string) => ({
  name,
  link: `https://github.com/acme/widgets/actions/runs/7/job/${name}`,
  jobId: name,
  runId: '7',
  description: null,
});

const failedRun = (name: string): CheckRollupItem => ({
  __typename: 'CheckRun',
  name,
  status: 'COMPLETED',
  conclusion: 'FAILURE',
  detailsUrl: `https://github.com/acme/widgets/actions/runs/7/job/${name}`,
});

let h: DeliveryHarness;
let w: PrWatch | null = null;
afterEach(async () => {
  await w?.stop();
  w = null;
  h.close();
});

/** What the watch asked of the shipper: none of it may be asked for a pass's pull request. */
function landing(): PullRequestLanding & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    catchUp: (id) => asked.push(`catchUp ${id}`),
    restartCi: (id) => asked.push(`restartCi ${id}`) > 0,
    retryMerge: (id) => asked.push(`retryMerge ${id}`),
  };
}

/** An open pass whose draft pull request Open Pull Request has made. */
async function passWithPr(
  project: Partial<ProjectInput> = {},
): Promise<{ passId: PassId; batchId: BatchId; url: string; task: TaskDto }> {
  h = createDeliveryHarness({ ...PAGES, ...project });
  const task = h.addTask('Settings page', { areas: ['settings'] });
  const opened = await openPass(
    h.ctx,
    { projectId: h.project.id, name: 'Polish pages', taskIds: [task.id] },
    { leaseMs: 60_000, putBack: nothingKept },
  );
  const branch = opened.batch.branch ?? '';
  const url = h.gh.openPr(branch, PrState.Open, 'main');
  h.state.write((ctx) => {
    setPassPullRequest(ctx, opened.pass.id, { url, draft: true });
  });
  return { passId: opened.pass.id, batchId: opened.batch.id, url, task };
}

/** The pass closed and settled as a `local` project's close leaves it: its batch shipped. */
function closedLocally(passId: PassId, batchId: BatchId): void {
  h.state.write((ctx) => {
    setClosePlan(ctx, passId, { token: 't', pages: [], files: [], shared: [] });
    transitionBatch(ctx, batchId, { to: 'SHIPPING' });
    transitionBatch(ctx, batchId, { to: 'SHIPPED' });
    closePass(ctx, passId, { settled: true });
  });
}

async function watch(asked: PullRequestLanding): Promise<void> {
  w = createPrWatch({
    ctx: h.ctx,
    clock: new ManualClock(),
    intervalMs: 120_000,
    ciFix: { dataDir: h.dataDir },
    landing: asked,
  });
  w.start();
  await w.idle();
}

const notices = (passId: PassId) => getPassProgress(h.store.db, passId).notices;
const batchCount = () => listBatches(h.store.db, { projectId: h.project.id }).length;

describe("the watch on a pass's pull request", () => {
  it.each([
    { name: 'on a pull request project, while the pass is open', project: {}, closed: false },
    { name: 'on a local project, after the close', project: { delivery: 'local' }, closed: true },
  ] as const)(
    'turns failing checks into one header notice offered to an agent, and starts no fix: $name',
    async ({ project, closed }) => {
      const { passId, batchId, url } = await passWithPr(project);
      if (closed) closedLocally(passId, batchId);
      h.gh.setChecks(url, [failedRun('lint')]);
      h.gh.setRequiredChecks(url, {
        state: 'failing',
        failing: [job('lint')],
        pending: [],
        cancelled: [],
      });
      const before = batchCount();
      const asked = landing();

      await watch(asked);
      await h.jobs.idle();

      expect(notices(passId)).toEqual([
        expect.objectContaining({
          kind: PassNoticeKind.Checks,
          sendable: true,
          text: expect.stringContaining('lint') as unknown,
        }),
      ]);
      expect(batchCount()).toBe(before);
      expect(asked.asked).toEqual([]);
      expect(h.cards()).toEqual([]);
      expect(getBatch(h.store.db, batchId).pr).toMatchObject({ state: 'open', checks: 'failing' });
    },
  );

  it('asks for no catch-up of a pull request that conflicts', async () => {
    const { url } = await passWithPr();
    h.gh.setMergeable(url, PrMergeable.Conflicting);
    const asked = landing();

    await watch(asked);

    expect(asked.asked).toEqual([]);
    expect(h.cards()).toEqual([]);
  });

  it('reruns no job GitHub cancelled for want of a runner', async () => {
    const { url } = await passWithPr();
    h.gh.noRunnerJobs.add('desktop');
    h.gh.setRequiredChecks(url, {
      state: 'cancelled',
      failing: [],
      pending: [],
      cancelled: [job('desktop')],
    });

    await watch(landing());

    expect(h.gh.reruns).toEqual([]);
    expect(h.cards()).toEqual([]);
  });

  it('records a merge of the open pass, and raises no card', async () => {
    const { passId, batchId, url } = await passWithPr();
    h.gh.setState(url, PrState.Merged);

    await watch(landing());

    expect(getBatch(h.store.db, batchId).pr).toMatchObject({ state: 'merged' });
    expect(getPass(h.store.db, passId).state).toBe(PassState.Open);
    expect(h.cards()).toEqual([]);
  });

  it('forgets a pull request closed unmerged while the pass is open, saying so in the header and nowhere else', async () => {
    const { passId, batchId, url } = await passWithPr();
    h.gh.setState(url, PrState.Closed);

    await watch(landing());

    expect(getBatch(h.store.db, batchId)).toMatchObject({ prUrl: null, pr: null });
    expect(notices(passId)).toEqual([
      expect.objectContaining({
        kind: PassNoticeKind.PrClosed,
        sendable: false,
        text: expect.stringContaining(url) as unknown,
      }),
    ]);
    expect(h.cards()).toEqual([]);
  });

  it("says in a local project's closed pass that its pull request closed, with no card", async () => {
    const { passId, batchId, url } = await passWithPr({ delivery: 'local' });
    closedLocally(passId, batchId);
    h.gh.setState(url, PrState.Closed);

    await watch(landing());

    expect(getBatch(h.store.db, batchId).pr).toMatchObject({ state: 'closed' });
    expect(notices(passId)).toEqual([expect.objectContaining({ kind: PassNoticeKind.PrClosed })]);
    expect(h.cards()).toEqual([]);
  });
});
