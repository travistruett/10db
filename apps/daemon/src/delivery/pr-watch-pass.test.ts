import {
  PassNoticeKind,
  type BatchId,
  type PassId,
  type ProjectInput,
  type TaskDto,
} from '@10db/contracts';
import {
  closePass,
  getBatch,
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
  it('turns failing checks into one header notice offered to an agent, and starts no fix or catch-up of a conflict, open or closed locally', async () => {
    const rows = [
      { name: 'a pull request project, while the pass is open', project: {}, closed: false },
      { name: 'a local project, after the close', project: { delivery: 'local' }, closed: true },
    ] as const;
    for (const [i, { name, project, closed }] of rows.entries()) {
      if (i > 0) {
        await w?.stop();
        w = null;
        h.close();
      }
      const { passId, batchId, url } = await passWithPr(project);
      if (closed) closedLocally(passId, batchId);
      h.gh.setChecks(url, [failedRun('lint')]);
      h.gh.setRequiredChecks(url, {
        state: 'failing',
        failing: [job('lint')],
        pending: [],
        cancelled: [],
      });
      // A conflict asks for no catch-up of a pass's pull request either.
      h.gh.setMergeable(url, PrMergeable.Conflicting);
      const before = batchCount();
      const asked = landing();

      await watch(asked);
      await h.jobs.idle();

      expect.soft(notices(passId), name).toEqual([
        expect.objectContaining({
          kind: PassNoticeKind.Checks,
          sendable: true,
          text: expect.stringContaining('lint') as unknown,
        }),
      ]);
      expect.soft(batchCount(), name).toBe(before);
      expect.soft(asked.asked, name).toEqual([]);
      expect.soft(h.cards(), name).toEqual([]);
      expect
        .soft(getBatch(h.store.db, batchId).pr, name)
        .toMatchObject({ state: 'open', checks: 'failing' });
    }
  });
});
