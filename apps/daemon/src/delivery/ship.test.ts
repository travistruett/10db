import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictError, type BatchDto, type TaskDto } from '@10db/contracts';
import {
  activeClaims,
  acquireClaims,
  claimRequestsForTask,
  getBatch,
  getBatchRow,
  getTask,
  getWorkstream,
  listWorkstreams,
  transitionBatch,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { waitFor } from '../../test/fixtures';
import { alive } from '../../test/orphan-gate';
import { installPrePushHook, writePrePushHook } from '../../test/pre-push-hook';
import { GhError } from '../github';

/** The repo's template, as a repository commits it at `.github/pull_request_template.md`. */
const PR_TEMPLATE = [
  '## What and why',
  '',
  '<!-- What this changes and why. -->',
  '',
  '## How it was checked',
  '',
  '<!-- Commands you ran and what they printed. -->',
  '',
  '## Checklist',
  '',
  '- [ ] `make gate` prints `GATE PASS`.',
  '',
].join('\n');

let h: DeliveryHarness;
afterEach(() => {
  h.close();
});

/** Opens a batch of `titles`, one task per area, and returns it with its workstreams. */
async function openBatch(title: string, ...titles: string[]) {
  const areas = ['api', 'ui'];
  const tasks: TaskDto[] = titles.map((t, i) => h.addTask(t, { areas: [areas[i % 2] ?? 'api'] }));
  const started = h.starter.startBatch(h.project.id, { title, taskIds: tasks.map((t) => t.id) });
  await h.jobs.idle();
  const batch = getBatch(h.store.db, started.id);
  return { batch, workstreams: listWorkstreams(h.store.db, { batchId: batch.id }) };
}

/** The SHA of `branch` on origin, or null when origin doesn't have it. */
function onOrigin(branch: string | null): string | null {
  try {
    return h.origin$('rev-parse', '--verify', '-q', `refs/heads/${branch ?? ''}`);
  } catch {
    return null;
  }
}

/** Every workstream DONE, as the runner would leave them; the trigger then ships the batch. */
async function finishAll(batch: BatchDto) {
  for (const ws of listWorkstreams(h.store.db, { batchId: batch.id })) h.settle(ws.id, 'DONE');
  await h.jobs.idle();
  return getBatch(h.store.db, batch.id);
}

/** The batch's lines in daemon.log, oldest first. */
function batchLines(batchId: string) {
  return h.logs.lines().filter((line) => line['batchId'] === batchId);
}

describe('shipping', () => {
  it('closes a batch with no commits beyond its base, pushing nothing', async () => {
    h = createDeliveryHarness();
    const { batch } = await openBatch('Nothing', 'Alpha');
    const shipped = await finishAll(batch);
    expect(shipped.state).toBe('CLOSED');
    expect(onOrigin(batch.branch)).toBeNull();
    expect(h.gh.prCreates()).toEqual([]);
    expect(batchLines(batch.id)).toMatchObject([
      { msg: 'batch branch cut' },
      { msg: 'batch closed', reason: 'no commits beyond the base' },
    ]);
  });

  it('logs the cut, each gate run, the push, the pull request and the ship result, in order', async () => {
    h = createDeliveryHarness();
    const base = h.git$('rev-parse', 'HEAD');
    const { batch } = await openBatch('Add greetings', 'Alpha', 'Beta');
    h.commit('src/api/alpha.txt');
    h.commit('src/ui/beta.txt');
    const shipped = await finishAll(batch);
    const lines = batchLines(batch.id);
    expect(lines.map((line) => line['msg'])).toEqual([
      'batch branch cut',
      'gate started',
      'gate finished',
      'git push finished',
      'gh pr create finished',
      'batch shipped',
    ]);
    const [cut, started, finished, push, pr, done] = lines;
    expect(cut).toMatchObject({ branch: batch.branch, baseSha: base });
    expect(started).toMatchObject({ command: 'true' });
    expect(String(started?.['logPath'])).toContain(join(h.dataDir, 'logs', 'gate'));
    expect(finished).toMatchObject({
      exitCode: 0,
      timedOut: false,
      aborted: false,
      logPath: started?.['logPath'],
    });
    expect(typeof finished?.['durationMs']).toBe('number');
    expect(push).toMatchObject({ branch: batch.branch });
    expect(typeof push?.['durationMs']).toBe('number');
    expect(pr).toMatchObject({
      repo: 'acme/widgets',
      baseBranch: 'main',
      branch: batch.branch,
      prUrl: 'https://github.com/acme/widgets/pull/1',
    });
    expect(done).toMatchObject({ prUrl: shipped.prUrl });
  });

  it("logs the pre-push hook's output with the push's duration", async () => {
    h = createDeliveryHarness();
    const { batch } = await openBatch('Greetings', 'Alpha');
    h.commit('src/api/alpha.txt');
    writePrePushHook(h.repo, 'echo "hook: 3 checks passed"; echo "hook: lint warns" >&2');
    await finishAll(batch);
    const push = batchLines(batch.id).find((line) => line['msg'] === 'git push finished');
    expect(typeof push?.['durationMs']).toBe('number');
    expect(String(push?.['output'])).toContain('hook: 3 checks passed');
    expect(String(push?.['output'])).toContain('hook: lint warns');
  });

  it('logs a failed push with its duration, kind and output, then the batch as not shipped', async () => {
    h = createDeliveryHarness();
    const { batch } = await openBatch('Greetings', 'Alpha');
    h.commit('src/api/alpha.txt');
    h.teammatePush(batch.branch ?? '', 'src/api/theirs.txt');
    const ended = await finishAll(batch);
    expect(ended.state).toBe('FAILED');
    const lines = batchLines(batch.id);
    expect(lines.map((line) => line['msg'])).toEqual([
      'batch branch cut',
      'gate started',
      'gate finished',
      'git push failed',
      'batch not shipped',
    ]);
    const [, , , push, notShipped] = lines;
    expect(push).toMatchObject({ branch: batch.branch, kind: 'rejected' });
    expect(typeof push?.['durationMs']).toBe('number');
    expect(String(push?.['output'])).toContain('rejected');
    expect(notShipped).toMatchObject({ failure: 'push_rejected' });
  });

  it('pushes the branch, opens one PR titled with the prefix and records its URL', async () => {
    h = createDeliveryHarness();
    const { batch } = await openBatch('Add greetings', 'Alpha', 'Beta');
    h.commit('src/api/alpha.txt');
    h.commit('src/ui/beta.txt');
    const shipped = await finishAll(batch);
    expect(shipped).toMatchObject({
      state: 'SHIPPED',
      prUrl: 'https://github.com/acme/widgets/pull/1',
      gateExitCode: 0,
      failure: null,
    });
    expect(onOrigin(batch.branch)).toBe(h.git$('rev-parse', 'HEAD'));
    expect(h.git$('rev-parse', '--abbrev-ref', '@{u}')).toBe(`origin/${batch.branch ?? ''}`);
    expect(h.gh.prCreates()).toEqual([
      { repo: 'acme/widgets', base: 'main', head: batch.branch, title: 'feat(app): add greetings' },
    ]);
    const body = h.gh.body(shipped.prUrl ?? '');
    expect(body).toContain('### Alpha');
    expect(body).toContain('### Beta');
    expect(body).toContain(`Shipped by 10db, batch ${batch.id}`);
    expect(getBatchRow(h.store.db, batch.id)).toMatchObject({ gatePid: null, gatePidStart: null });
  });

  it('fills the repo pull request template, with each task and CI for the pushed head', async () => {
    h = createDeliveryHarness();
    const alpha = h.addTask('Alpha', {
      description: 'Greets the builder, per decision 36.',
      acceptanceCriteria: ['It greets.'],
    });
    const started = h.starter.startBatch(h.project.id, {
      title: 'Add greetings',
      taskIds: [alpha.id],
    });
    await h.jobs.idle();
    const batch = getBatch(h.store.db, started.id);
    h.commit('.github/pull_request_template.md', PR_TEMPLATE);
    h.commit('src/api/alpha.txt');
    const shipped = await finishAll(batch);
    const body = h.gh.body(shipped.prUrl ?? '');
    expect(body).toContain('## What and why\n\n### Alpha\n\nGreets the builder, per decision 36.');
    expect(body).toContain('- It greets.');
    expect(body).toContain('## How it was checked');
    expect(body).toContain(
      `https://github.com/acme/widgets/commit/${h.git$('rev-parse', 'HEAD')}/checks`,
    );
    expect(body).toContain('## Checklist\n\n- [ ] `make gate` prints `GATE PASS`.');
    expect(body).not.toContain('<!--');
    expect(body).not.toContain('Exited');
  });

  it('passes a title with quotes and $() through as one argument', async () => {
    h = createDeliveryHarness();
    const { batch } = await openBatch(`Say "hi" and $(whoami)`, 'Alpha');
    h.commit('src/api/alpha.txt');
    await finishAll(batch);
    expect(h.gh.prCreates().map((c) => c.title)).toEqual([`feat(app): say "hi" and $(whoami)`]);
  });

  it('records an existing PR for the branch instead of opening a second one', async () => {
    h = createDeliveryHarness();
    const { batch } = await openBatch('Greetings', 'Alpha');
    h.commit('src/api/alpha.txt');
    const url = h.gh.openPr(batch.branch ?? '', 'CLOSED');
    const shipped = await finishAll(batch);
    expect(shipped).toMatchObject({ state: 'SHIPPED', prUrl: url });
    expect(h.gh.prCreates()).toEqual([]);
  });

  it.each<{
    name: string;
    gate?: string;
    gateTimeoutMs?: number;
    arrange?: (x: DeliveryHarness, batch: BatchDto) => void;
    failure: string;
    title: string;
  }>([
    {
      name: 'a dirty checkout',
      arrange: (x) => {
        writeFileSync(join(x.repo, 'scratch.txt'), 'uncommitted\n');
      },
      failure: 'dirty_checkout',
      title: 'the checkout has uncommitted changes',
    },
    {
      name: 'the checkout on another branch',
      arrange: (x) => {
        x.git$('switch', '-q', 'main');
      },
      failure: 'wrong_branch',
      title: 'checkout is on main, the batch branch is',
    },
    {
      name: 'a failing gate',
      gate: 'echo broken >&2; exit 3',
      failure: 'gate_failed',
      title: 'the gate failed (exit 3)',
    },
    {
      name: 'a gate that times out',
      gate: 'sleep 5',
      gateTimeoutMs: 300,
      failure: 'gate_timed_out',
      title: 'the gate timed out after 0.3 s',
    },
    {
      name: 'a rejected push',
      arrange: (x, batch) => {
        x.teammatePush(batch.branch ?? '', 'src/api/theirs.txt');
      },
      failure: 'push_rejected',
      title: 'git push was rejected',
    },
    {
      name: 'gh signed out',
      arrange: (x) => {
        x.gh.failNext.set('prView', new GhError('signed_out', 'gh is not signed in'));
      },
      failure: 'gh_unavailable',
      title: 'gh is signed out',
    },
    {
      name: 'gh failing',
      arrange: (x) => {
        x.gh.failNext.set('prCreate', new GhError('failed', 'HTTP 502'));
      },
      failure: 'network',
      title: 'gh pr create failed',
    },
  ])('fails on $name with a card, and opens no PR', async (row) => {
    h = createDeliveryHarness(
      row.gate ? { gateCommand: row.gate } : {},
      row.gateTimeoutMs ? { gateTimeoutMs: row.gateTimeoutMs } : {},
    );
    const { batch } = await openBatch('Greetings', 'Alpha');
    h.commit('src/api/alpha.txt');
    const before = onOrigin(batch.branch);
    row.arrange?.(h, batch);
    const ended = await finishAll(batch);
    expect(ended).toMatchObject({ state: 'FAILED', failure: row.failure });
    expect(h.only(h.cards()).title).toContain(row.title);
    expect(h.gh.prCreates()).toEqual([]);
    expect(batchLines(batch.id).at(-1)).toMatchObject({
      msg: 'batch not shipped',
      failure: row.failure,
    });
    if (
      row.failure !== 'push_rejected' &&
      row.failure !== 'gh_unavailable' &&
      row.failure !== 'network'
    )
      expect(onOrigin(batch.branch)).toBe(before);
  });

  it.each<{
    name: string;
    steps: readonly (readonly ['alpha' | 'beta', 'DONE' | 'FAILED' | 'WAITING_HUMAN'])[];
  }>([
    {
      name: 'one waits and then fails after the other is done',
      steps: [
        ['alpha', 'DONE'],
        ['beta', 'WAITING_HUMAN'],
        ['beta', 'FAILED'],
      ],
    },
    {
      // The last DONE fires the trigger, which finds a failed member and must hold the batch.
      name: 'one fails before the other is the last to be done',
      steps: [
        ['beta', 'FAILED'],
        ['alpha', 'DONE'],
      ],
    },
  ])('holds the batch open when $name', async ({ steps }) => {
    h = createDeliveryHarness();
    const { batch, workstreams } = await openBatch('Greetings', 'Alpha', 'Beta');
    const [alpha, beta] = workstreams;
    if (!alpha || !beta) throw new Error('two workstreams expected');
    h.commit('src/api/alpha.txt');
    for (const [who, to] of steps) {
      h.settle((who === 'alpha' ? alpha : beta).id, to);
      await h.jobs.idle();
      expect(getBatch(h.store.db, batch.id).state).toBe('OPEN');
    }
    expect(h.gh.prCreates()).toEqual([]);
  });
});

describe("the clone's pre-push hook", () => {
  it('ships when the hook takes longer than a network call may, but less than the push may', async () => {
    h = createDeliveryHarness({}, { networkTimeoutMs: 1_000, pushTimeoutMs: 4_000 });
    const { batch } = await openBatch('Greetings', 'Alpha');
    h.commit('src/api/alpha.txt');
    const hook = installPrePushHook(h.repo, 2);
    try {
      const shipped = await finishAll(batch);
      expect(shipped.state).toBe('SHIPPED');
      expect(onOrigin(batch.branch)).toBe(h.git$('rev-parse', 'HEAD'));
    } finally {
      hook.cleanup();
    }
  });

  it('stops a hook that runs past the push timeout with every process it started, and fails the batch saying so', async () => {
    h = createDeliveryHarness({}, { pushTimeoutMs: 1_000 });
    const { batch } = await openBatch('Greetings', 'Alpha');
    h.commit('src/api/alpha.txt');
    const hook = installPrePushHook(h.repo, 30);
    try {
      const ended = await finishAll(batch);
      expect(ended).toMatchObject({ state: 'FAILED', failure: 'network' });
      const card = h.only(h.cards());
      expect(card.title).toBe('Batch "Greetings" not shipped: git push ran past 1.0 s');
      expect(card.body).toContain('pre-push hook');
      const child = await hook.childPid();
      await waitFor(() => !alive(child), 2_000);
      expect(onOrigin(batch.branch)).toBeNull();
      expect(h.gh.prCreates()).toEqual([]);
    } finally {
      hook.cleanup();
    }
  });
});

describe('Ship anyway, Retry and Abandon', () => {
  it('ships anyway only when every workstream is done, cancelled or failed, listing the failed one', async () => {
    h = createDeliveryHarness();
    const { batch, workstreams } = await openBatch('Greetings', 'Alpha', 'Beta');
    const [alpha, beta] = workstreams;
    if (!alpha || !beta) throw new Error('two workstreams expected');
    h.commit('src/api/alpha.txt');
    h.settle(alpha.id, 'DONE');
    h.settle(beta.id, 'WAITING_HUMAN');
    expect(() => h.shipper.ship(batch.id)).toThrow(ConflictError);
    expect(() => h.shipper.ship(batch.id)).toThrow(/Beta \(waiting_human\)/);
    h.settle(beta.id, 'FAILED');
    expect(h.shipper.ship(batch.id).state).toBe('SHIPPING');
    await h.jobs.idle();
    const shipped = getBatch(h.store.db, batch.id);
    expect(shipped.state).toBe('SHIPPED');
    expect(h.gh.body(shipped.prUrl ?? '')).toContain('- Beta (failed)');
  });

  it('retries a failed batch: ships it when its work is settled, reopens it when work is unfinished', async () => {
    h = createDeliveryHarness();
    const { batch, workstreams } = await openBatch('Greetings', 'Alpha');
    const ws = h.only(workstreams);
    h.commit('src/api/alpha.txt');
    // Failed at startup for the wrong branch while its work was still queued.
    h.state.write((c) =>
      transitionBatch(c, batch.id, { to: 'FAILED', patch: { failure: 'wrong_branch' } }),
    );
    expect(h.shipper.ship(batch.id)).toMatchObject({ state: 'OPEN', failure: null });
    expect(getWorkstream(h.store.db, ws.id).state).toBe('QUEUED');
    // Now its gate failed after the work finished: Retry ships.
    h.state.write((c) =>
      transitionBatch(c, batch.id, { to: 'FAILED', patch: { failure: 'gate_failed' } }),
    );
    h.settle(ws.id, 'DONE');
    expect(h.shipper.ship(batch.id).state).toBe('SHIPPING');
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id).state).toBe('SHIPPED');
  });

  it('refuses to abandon while a lane runs, then cancels the waiting work, releases its claims and keeps the branch', async () => {
    h = createDeliveryHarness();
    const { batch, workstreams } = await openBatch('Greetings', 'Alpha', 'Beta');
    const [alpha, beta] = workstreams;
    if (!alpha || !beta) throw new Error('two workstreams expected');
    h.commit('src/api/alpha.txt');
    h.settle(alpha.id, 'DONE');
    h.state.write((c) =>
      acquireClaims(c, {
        projectId: h.project.id,
        workstreamId: beta.id,
        requests: claimRequestsForTask(getTask(c.tx, beta.taskId), h.project),
        leaseExpiresAt: '2999-01-01T00:00:00.000Z',
      }),
    );
    h.settle(beta.id, 'RUNNING');
    expect(() => h.shipper.abandon(batch.id)).toThrow(/running/);
    h.settle(beta.id, 'WAITING_HUMAN');
    const abandoned = h.shipper.abandon(batch.id);
    expect(abandoned.state).toBe('ABANDONED');
    expect(getWorkstream(h.store.db, beta.id).state).toBe('CANCELLED');
    expect(getWorkstream(h.store.db, alpha.id).state).toBe('DONE');
    expect(activeClaims(h.store.db, beta.id)).toEqual([]);
    expect(h.git$('branch', '--list', batch.branch ?? '')).toContain(batch.branch ?? '');
    expect(h.only(h.cards()).body).toContain('Alpha');
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id).state).toBe('ABANDONED');
  });

  it.each(['SHIPPED', 'CLOSED', 'ABANDONED'] as const)(
    'refuses Ship and Abandon from %s',
    async (state) => {
      h = createDeliveryHarness();
      const { batch } = await openBatch('Greetings', 'Alpha');
      h.state.write((c) => {
        if (state === 'ABANDONED') transitionBatch(c, batch.id, { to: 'ABANDONED' });
        else {
          transitionBatch(c, batch.id, { to: 'SHIPPING' });
          transitionBatch(c, batch.id, {
            to: state,
            ...(state === 'SHIPPED'
              ? { patch: { prUrl: 'https://github.com/acme/widgets/pull/9' } }
              : {}),
          });
        }
      });
      expect(() => h.shipper.ship(batch.id)).toThrow(ConflictError);
      expect(() => h.shipper.abandon(batch.id)).toThrow(ConflictError);
    },
  );
});
