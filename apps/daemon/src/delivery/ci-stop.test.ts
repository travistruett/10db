import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BoardStatus,
  type BatchDto,
  type InboxItemDto,
  type RequiredCheckJobDto,
  type WorkstreamId,
} from '@10db/contracts';
import { findOpenByFoldKey, getBatch, listBatches, listTasks, listWorkstreams } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { ManualClock } from '../clock';
import { GhError } from '../github';
import { createCiStopAnswers, createPrWatch, type PrWatch } from './index';

const INTERVAL = 120_000;

let h: DeliveryHarness;
let clock: ManualClock;
const watches: PrWatch[] = [];
/** The workstreams the fake runner was asked to cancel, in order. */
let cancelled: WorkstreamId[];
beforeEach(() => {
  h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
  clock = new ManualClock();
  cancelled = [];
});
afterEach(async () => {
  for (const w of watches.splice(0)) await w.stop();
  h.close();
});

/** A watch that fixes and ends fixes as the daemon's does; the runner is a fake that ends a session. */
function watcher(): PrWatch {
  const w = createPrWatch({
    ctx: h.ctx,
    clock,
    intervalMs: INTERVAL,
    ciFix: { dataDir: h.dataDir },
    endFixes: {
      cancel: (id) => {
        cancelled.push(id);
        h.running.delete(id);
        h.settle(id, 'CANCELLED');
        return Promise.resolve();
      },
      abandon: (id) => h.shipper.abandon(id),
    },
  });
  watches.push(w);
  return w;
}

const round = async (w: PrWatch): Promise<void> => {
  clock.advance(INTERVAL);
  await w.idle();
  await h.jobs.idle();
};

async function begin(w: PrWatch): Promise<void> {
  w.start();
  await w.idle();
  await h.jobs.idle();
}

function pathOf(batch: BatchDto): string {
  if (batch.worktreePath === null) throw new Error(`batch ${batch.title} has no worktree path`);
  return batch.worktreePath;
}

/** A root batch shipped as a pull request: its branch on origin at `head`, the PR open at `head`. */
async function shippedRoot(): Promise<{ root: BatchDto; head: string; prUrl: string }> {
  const started = h.starter.startTask(h.addTask('Alpha').id);
  await h.jobs.idle();
  const batch = getBatch(h.store.db, started.id);
  const ws = h.only(listWorkstreams(h.store.db, { batchId: batch.id }));
  const file = join(pathOf(batch), 'src/api/alpha.txt');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'alpha\n');
  const { sha } = await h.git.commit({
    repo: pathOf(batch),
    paths: ['src/api/alpha.txt'],
    message: 'Add alpha',
    opId: 'op-alpha',
    branch: batch.branch ?? '',
  });
  h.settle(ws.id, 'DONE');
  h.shipper.checkBatch(batch.id);
  await h.jobs.idle();
  const root = getBatch(h.store.db, batch.id);
  expect(root.state).toBe('SHIPPED');
  h.gh.setHead(root.prUrl ?? '', sha);
  return { root, head: sha, prUrl: root.prUrl ?? '' };
}

const job = (name: string, jobId: string | null = '77'): RequiredCheckJobDto => ({
  name,
  link:
    jobId === null
      ? 'https://ci.example.com/build/1'
      : `https://github.com/acme/widgets/actions/runs/1/job/${jobId}`,
  jobId,
  runId: jobId === null ? null : '1',
  description: null,
});

function fails(prUrl: string, ...jobs: RequiredCheckJobDto[]): void {
  h.gh.setRequiredChecks(prUrl, { state: 'failing', failing: jobs, pending: [] });
}

const fixBatches = (root: BatchDto): BatchDto[] =>
  listBatches(h.store.db, {}).filter((b) => b.ciFixOf === root.id);
const stopCards = (): InboxItemDto[] =>
  h.cards().filter((c) => c.title.startsWith('CI still failing on'));
/** Whether the open card folds under `ci-stopped:<root>`. */
const hasStopKey = (root: BatchDto): boolean =>
  findOpenByFoldKey(h.store.db, h.project.id, `ci-stopped:${root.id}`) !== undefined;
const alphaStatus = (): string | undefined =>
  listTasks(h.store.db, h.project.id).find((t) => t.title === 'Alpha')?.boardStatus;

/** The fix ends having changed nothing, as a session that found nothing to fix does. */
async function finishFix(fix: BatchDto): Promise<void> {
  const ws = h.only(listWorkstreams(h.store.db, { batchId: fix.id }));
  h.settle(ws.id, 'DONE');
  h.shipper.checkBatch(fix.id);
  await h.jobs.idle();
  expect(getBatch(h.store.db, fix.id).state).toBe('CLOSED');
}

/** A commit someone pushed on top of the pull request's branch: a new head for CI to fail on. */
function pushedHead(root: BatchDto, message: string): string {
  const branch = root.branch ?? '';
  const parent = h.origin$('rev-parse', branch);
  const sha = h.git$('commit-tree', `${parent}^{tree}`, '-p', parent, '-m', message);
  h.git$('push', '-q', 'origin', `${sha}:refs/heads/${branch}`);
  h.gh.setHead(root.prUrl ?? '', sha);
  return sha;
}

describe('stopping after fixes that did not help', () => {
  it('stops after two fixes: Blocked, and one card naming the job, its link and a Retry', async () => {
    const { root } = await shippedRoot();
    const prUrl = root.prUrl ?? '';
    fails(prUrl, job('build'));
    h.gh.setJobLog('77', { kind: 'ready', log: 'boom\n' });
    const w = watcher();
    await begin(w);
    await finishFix(h.only(fixBatches(root)));
    pushedHead(root, 'one.txt');
    await round(w);
    expect(fixBatches(root)).toHaveLength(2);
    await finishFix(fixBatches(root).find((b) => b.state === 'OPEN') ?? root);
    pushedHead(root, 'two.txt');
    expect(getBatch(h.store.db, root.id).ciStopped).toBeNull();
    expect(stopCards()).toEqual([]);

    await round(w);

    expect(fixBatches(root)).toHaveLength(2);
    expect(getBatch(h.store.db, root.id).ciStopped).toBe('limit');
    expect(alphaStatus()).toBe(BoardStatus.Blocked);
    const card = h.only(stopCards());
    expect(hasStopKey(root)).toBe(true);
    expect(card.title).toContain('Alpha');
    expect(card.title).toContain('build');
    expect(card.body).toContain('https://github.com/acme/widgets/actions/runs/1/job/77');
    expect(card.body).toContain('2 fixes');
    expect(card.options.map((o) => o.label)).toEqual(['Retry']);
  });

  it('stops when a fix changed nothing, and starts no more however many rounds pass', async () => {
    const { root } = await shippedRoot();
    fails(root.prUrl ?? '', job('build'));
    h.gh.setJobLog('77', { kind: 'ready', log: 'boom\n' });
    const w = watcher();
    await begin(w);
    await finishFix(h.only(fixBatches(root)));

    await round(w);
    await round(w);
    await round(w);

    expect(fixBatches(root)).toHaveLength(1);
    expect(getBatch(h.store.db, root.id).ciStopped).toBe('no_change');
    expect(alphaStatus()).toBe(BoardStatus.Blocked);
    expect(h.only(stopCards()).body).toContain('1 fix ');
  });

  it('stops with no fix when no failing check is an Actions job', async () => {
    const { root } = await shippedRoot();
    fails(root.prUrl ?? '', job('ci/circle', null));

    await begin(watcher());

    expect(fixBatches(root)).toEqual([]);
    expect(getBatch(h.store.db, root.id).ciStopped).toBe('no_log');
    expect(alphaStatus()).toBe(BoardStatus.Blocked);
    const card = h.only(stopCards());
    expect(card.body).toContain('https://ci.example.com/build/1');
    // No GitHub Actions run to rerun, so no Retry to offer.
    expect(card.options).toEqual([]);
  });

  it('stops with no fix when the failing job has no log to read', async () => {
    const { root } = await shippedRoot();
    fails(root.prUrl ?? '', job('build'));
    h.gh.failNext.set('jobLog', new GhError('failed', 'log has expired'));

    await begin(watcher());

    expect(fixBatches(root)).toEqual([]);
    expect(getBatch(h.store.db, root.id).ciStopped).toBe('no_log');
    expect(h.only(stopCards()).options.map((o) => o.label)).toEqual(['Retry']);
  });

  it('does not stop while the failing job’s run is still in progress', async () => {
    const { root } = await shippedRoot();
    fails(root.prUrl ?? '', job('build'));

    await begin(watcher());

    expect(getBatch(h.store.db, root.id).ciStopped).toBeNull();
    expect(stopCards()).toEqual([]);
  });

  it('raises the card once, and leaves it dismissed when the checks go on failing', async () => {
    const { root } = await shippedRoot();
    fails(root.prUrl ?? '', job('ci/circle', null));
    const w = watcher();
    await begin(w);
    const card = h.only(stopCards());
    h.inbox.answer(card.id, { choice: 'dismissed' });

    await round(w);
    await round(w);

    expect(stopCards()).toEqual([]);
    expect(getBatch(h.store.db, root.id).ciStopped).toBe('no_log');
  });

  it('names the cut’s reason when a fix cut is refused', async () => {
    const { root } = await shippedRoot();
    h.git$('switch', '-q', root.branch ?? '');
    fails(root.prUrl ?? '', job('build'));
    h.gh.setJobLog('77', { kind: 'ready', log: 'boom\n' });

    await begin(watcher());

    expect(getBatch(h.store.db, root.id).ciStopped).toBe('no_cut');
    const card = h.only(stopCards());
    expect(hasStopKey(root)).toBe(true);
    expect(card.options.map((o) => o.label)).toEqual(['Retry']);
    expect(alphaStatus()).toBe(BoardStatus.Blocked);
  });
});

describe('the stop card’s Retry', () => {
  it('reruns the failed jobs of each failing Actions run on GitHub, once per run', async () => {
    const { root } = await shippedRoot();
    // Stopped for want of a log (no job id), with runs GitHub can still rerun.
    const run = (name: string, runId: string): RequiredCheckJobDto => ({
      ...job(name, null),
      runId,
    });
    fails(
      root.prUrl ?? '',
      run('build', '1'),
      run('lint', '2'),
      run('test', '1'),
      job('ci/x', null),
    );
    await begin(watcher());
    const card = h.only(stopCards());

    createCiStopAnswers(h.ctx)(card, { choice: 'Retry' });
    await h.jobs.idle();
    await new Promise((resolve) => setImmediate(resolve));

    expect(h.gh.reruns).toEqual(['1', '2']);
  });

  it('does nothing for any other answer', async () => {
    const { root } = await shippedRoot();
    fails(root.prUrl ?? '', job('ci/circle', null));
    await begin(watcher());

    createCiStopAnswers(h.ctx)(h.only(stopCards()), { choice: 'Later' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(h.gh.reruns).toEqual([]);
  });

  it('says so in a card when GitHub refuses the rerun', async () => {
    const { root } = await shippedRoot();
    fails(root.prUrl ?? '', job('build'));
    h.gh.failNext.set('jobLog', new GhError('failed', 'log has expired'));
    await begin(watcher());
    const card = h.only(stopCards());
    h.gh.failNext.set('rerunFailed', new GhError('failed', 'run 1 cannot be rerun'));

    createCiStopAnswers(h.ctx)(card, { choice: 'Retry' });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(h.cards().some((c) => c.body.includes('run 1 cannot be rerun'))).toBe(true);
  });
});

describe('clearing a stop', () => {
  async function stopped(): Promise<{ root: BatchDto; w: PrWatch }> {
    const { root } = await shippedRoot();
    fails(root.prUrl ?? '', job('ci/circle', null));
    const w = watcher();
    await begin(w);
    expect(getBatch(h.store.db, root.id).ciStopped).toBe('no_log');
    expect(h.only(stopCards()).state).toBe('OPEN');
    return { root, w };
  }

  it.each([
    ['passing', { state: 'passing', failing: [], pending: [] }],
    ['pending', { state: 'pending', failing: [], pending: [job('build')] }],
  ] as const)(
    'clears the stop and the card, and returns the task to In review, when the checks are %s',
    async (_name, required) => {
      const { root, w } = await stopped();
      h.gh.setRequiredChecks(root.prUrl ?? '', {
        ...required,
        failing: [...required.failing],
        pending: [...required.pending],
      });

      await round(w);

      expect(getBatch(h.store.db, root.id).ciStopped).toBeNull();
      expect(stopCards()).toEqual([]);
      expect(alphaStatus()).toBe(BoardStatus.InReview);
    },
  );

  it('keeps the stop while the checks still fail', async () => {
    const { root, w } = await stopped();

    await round(w);

    expect(getBatch(h.store.db, root.id).ciStopped).toBe('no_log');
    expect(h.only(stopCards()).state).toBe('OPEN');
    expect(alphaStatus()).toBe(BoardStatus.Blocked);
  });

  it('keeps the stop when the required read fails', async () => {
    const { root, w } = await stopped();
    h.gh.failNext.set('prRequiredChecks', new GhError('failed', 'HTTP 502'));

    await round(w);

    expect(getBatch(h.store.db, root.id).ciStopped).toBe('no_log');
    expect(stopCards()).toHaveLength(1);
  });

  it.each(['MERGED', 'CLOSED'] as const)(
    'clears the stop and the card when the pull request is %s',
    async (state) => {
      const { root, w } = await stopped();
      h.gh.setState(root.prUrl ?? '', state);

      await round(w);

      expect(getBatch(h.store.db, root.id).ciStopped).toBeNull();
      expect(stopCards()).toEqual([]);
    },
  );

  it('stops again when the rerun fails the same way, with a new card', async () => {
    const { root, w } = await stopped();
    h.gh.setRequiredChecks(root.prUrl ?? '', { state: 'pending', failing: [], pending: [] });
    await round(w);
    expect(stopCards()).toEqual([]);

    fails(root.prUrl ?? '', job('ci/circle', null));
    await round(w);

    expect(getBatch(h.store.db, root.id).ciStopped).toBe('no_log');
    expect(h.only(stopCards()).state).toBe('OPEN');
  });
});

describe('a pull request that merges or closes while a fix runs', () => {
  async function fixing(): Promise<{ root: BatchDto; fix: BatchDto; w: PrWatch }> {
    const { root } = await shippedRoot();
    fails(root.prUrl ?? '', job('build'));
    h.gh.setJobLog('77', { kind: 'ready', log: 'boom\n' });
    const w = watcher();
    await begin(w);
    const fix = h.only(fixBatches(root));
    const ws = h.only(listWorkstreams(h.store.db, { batchId: fix.id }));
    h.running.add(ws.id);
    return { root, fix, w };
  }

  it.each(['MERGED', 'CLOSED'] as const)(
    'stops the session and abandons the batch when the pull request is %s',
    async (state) => {
      const { root, fix, w } = await fixing();
      const ws = h.only(listWorkstreams(h.store.db, { batchId: fix.id }));
      h.gh.setState(root.prUrl ?? '', state);

      await round(w);

      expect(cancelled).toEqual([ws.id]);
      expect(getBatch(h.store.db, fix.id).state).toBe('ABANDONED');
      expect(h.only(listWorkstreams(h.store.db, { batchId: fix.id })).state).toBe('CANCELLED');
    },
  );

  it('ends a failed fix batch too', async () => {
    const { root, fix, w } = await fixing();
    const ws = h.only(listWorkstreams(h.store.db, { batchId: fix.id }));
    h.running.delete(ws.id);
    h.settle(ws.id, 'FAILED');
    h.gh.setState(root.prUrl ?? '', 'MERGED');

    await round(w);

    expect(getBatch(h.store.db, fix.id).state).toBe('ABANDONED');
  });

  it('leaves the fix alone while the pull request is open', async () => {
    const { fix, w } = await fixing();

    await round(w);
    await round(w);

    expect(cancelled).toEqual([]);
    expect(getBatch(h.store.db, fix.id).state).toBe('OPEN');
  });

  it('ends the fix in a later round when gh failed in the round that read the merge', async () => {
    const { root, fix, w } = await fixing();
    const failing = new GhError('failed', 'boom');
    h.gh.setState(root.prUrl ?? '', 'MERGED');
    // Recorded, but the fix could not be ended: the abandon fails once.
    let first = true;
    const stubborn = createPrWatch({
      ctx: h.ctx,
      clock,
      intervalMs: INTERVAL,
      ciFix: { dataDir: h.dataDir },
      endFixes: {
        cancel: (id) => {
          h.running.delete(id);
          h.settle(id, 'CANCELLED');
          return Promise.resolve();
        },
        abandon: (id) => {
          if (first) {
            first = false;
            throw failing;
          }
          return h.shipper.abandon(id);
        },
      },
    });
    watches.push(stubborn);
    await w.stop();

    await begin(stubborn);
    expect(getBatch(h.store.db, fix.id).state).toBe('OPEN');
    expect(getBatch(h.store.db, root.id).pr?.state).toBe('merged');

    await round(stubborn);

    expect(getBatch(h.store.db, fix.id).state).toBe('ABANDONED');
  });
});
