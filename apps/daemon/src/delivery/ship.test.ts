import { existsSync, writeFileSync } from 'node:fs';
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
  schema,
  transitionBatch,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { waitFor } from '../../test/fixtures';
import { alive } from '../../test/orphan-gate';
import { writeHook } from '../../test/git-hooks';
import { hangingSsh } from '../../test/hanging-ssh';
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
  const started = h.only(
    h.starter.startBatch(h.project.id, { title, taskIds: tasks.map((t) => t.id) }),
  );
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
      { msg: 'checkout switched back', branch: batch.branch, to: { branch: 'main' } },
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
      'checkout switched back',
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

  it("logs the push's output with its duration", async () => {
    h = createDeliveryHarness();
    const { batch } = await openBatch('Greetings', 'Alpha');
    h.commit('src/api/alpha.txt');
    await finishAll(batch);
    const push = batchLines(batch.id).find((line) => line['msg'] === 'git push finished');
    expect(typeof push?.['durationMs']).toBe('number');
    expect(String(push?.['output'])).toContain('[new branch]');
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
    const tip = h.git$('rev-parse', `refs/heads/${batch.branch ?? ''}`);
    expect(onOrigin(batch.branch)).toBe(tip);
    expect(h.git$('rev-parse', '--abbrev-ref', `${batch.branch ?? ''}@{u}`)).toBe(
      `origin/${batch.branch ?? ''}`,
    );
    expect(h.gh.prCreates()).toEqual([
      { repo: 'acme/widgets', base: 'main', head: batch.branch, title: 'feat(app): add greetings' },
    ]);
    const body = h.gh.body(shipped.prUrl ?? '');
    expect(body).toContain('### Alpha');
    expect(body).toContain('### Beta');
    expect(body).toContain(`Shipped by 10db, batch ${batch.id}`);
    expect(getBatchRow(h.store.db, batch.id)).toMatchObject({ gatePid: null, gatePidStart: null });
  });

  it("never merges the base into the builder's own checkout: the branch ships as it is", async () => {
    h = createDeliveryHarness();
    const { batch } = await openBatch('Add greetings', 'Alpha');
    const head = h.commit('src/api/alpha.txt');
    h.teammatePush('main', 'src/ui/teammate.txt');
    const shipped = await finishAll(batch);
    expect(shipped.state).toBe('SHIPPED');
    expect(onOrigin(batch.branch)).toBe(head);
    expect(h.git$('rev-parse', `refs/heads/${batch.branch ?? ''}`)).toBe(head);
    expect(h.git$('status', '--porcelain', '--untracked-files=all')).toBe('');
  });

  it("says in a failed gate's card how far the builder's own checkout is behind the base", async () => {
    h = createDeliveryHarness({ gateCommand: 'false' });
    const { batch } = await openBatch('Add greetings', 'Alpha');
    h.commit('src/api/alpha.txt');
    h.teammatePush('main', 'src/ui/teammate.txt');
    const failed = await finishAll(batch);
    expect(failed.state).toBe('FAILED');
    const card = h.only(h.cards().filter((c) => c.title.includes('the gate failed')));
    expect(card.body).toMatch(/^origin\/main has 1 commit this branch doesn't\./);
  });

  it('ships a batch without a gate step when the project has none', async () => {
    h = createDeliveryHarness({ gateCommand: null });
    const { batch } = await openBatch('Add greetings', 'Alpha');
    h.commit('src/api/alpha.txt');
    const shipped = await finishAll(batch);
    expect(shipped).toMatchObject({
      state: 'SHIPPED',
      prUrl: 'https://github.com/acme/widgets/pull/1',
      gateExitCode: null,
      gateLogPath: null,
      failure: null,
    });
    expect(batchLines(batch.id).map((line) => line['msg'])).toEqual([
      'batch branch cut',
      'git push finished',
      'gh pr create finished',
      'batch shipped',
      'checkout switched back',
    ]);
    expect(existsSync(join(h.dataDir, 'logs', 'gate'))).toBe(false);
    expect(onOrigin(batch.branch)).toBe(h.git$('rev-parse', `refs/heads/${batch.branch ?? ''}`));
    const body = h.gh.body(shipped.prUrl ?? '');
    expect(body).toContain('No gate command: each task was approved in 10db.');
    expect(body).not.toContain('Gate, run on the branch before the push:');
  });

  it('fills the repo pull request template, with each task and CI for the pushed head', async () => {
    h = createDeliveryHarness();
    const alpha = h.addTask('Alpha', {
      description: 'Greets the builder, per decision 36.',
      acceptanceCriteria: ['It greets.'],
    });
    const started = h.only(
      h.starter.startBatch(h.project.id, {
        title: 'Add greetings',
        taskIds: [alpha.id],
      }),
    );
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
      `https://github.com/acme/widgets/commit/${h.git$('rev-parse', `refs/heads/${batch.branch ?? ''}`)}/checks`,
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

  const SCOPES = '{"scopes":{"api":["src/api"],"ui":["src/ui"]}}\n';

  it.each<{
    name: string;
    title: string;
    tasks: string[];
    paths: string[];
    expected: string;
    /** The list on origin's main before the batch starts; the valid one when absent. */
    scopes?: string;
    /** Tasks cancelled rather than done. */
    cancelled?: string[];
  }>([
    {
      name: 'one scope, a feature',
      title: 'Add greetings',
      tasks: ['Alpha'],
      paths: ['src/api/alpha.txt', 'src/api/beta.txt'],
      expected: 'feat(api): add greetings',
    },
    {
      name: 'two scopes, so none',
      title: 'Add greetings',
      tasks: ['Alpha', 'Beta'],
      paths: ['src/api/alpha.txt', 'src/ui/beta.txt'],
      expected: 'feat: add greetings',
    },
    {
      name: 'a path no scope covers, so none',
      title: 'Add greetings',
      tasks: ['Alpha'],
      paths: ['src/api/alpha.txt', 'notes.txt'],
      expected: 'feat: add greetings',
    },
    {
      name: 'one scope, a fix',
      title: 'Fix the greeting',
      tasks: ['Fix the greeting'],
      paths: ['src/ui/beta.txt'],
      expected: 'fix(ui): fix the greeting',
    },
    {
      name: 'a cancelled feature beside a finished fix, a fix',
      title: 'Fix the greeting',
      tasks: ['Add farewells', 'Fix the greeting'],
      cancelled: ['Add farewells'],
      paths: ['src/ui/beta.txt'],
      expected: 'fix(ui): fix the greeting',
    },
    {
      name: 'an invalid list, so none',
      title: 'Add greetings',
      tasks: ['Alpha'],
      scopes: '{"scopes":{"API":["src/api"]}}\n',
      paths: ['src/api/alpha.txt'],
      expected: 'feat: add greetings',
    },
    {
      name: 'a list the batch itself rewrites, read from the base',
      title: 'Add greetings',
      tasks: ['Alpha'],
      paths: ['src/ui/beta.txt', '.10db/pr-scopes.json'],
      expected: 'feat: add greetings',
    },
  ])('titles the PR from the work with no project prefix: $name', async (row) => {
    h = createDeliveryHarness();
    // Pull request delivery still requires a prefix when a project is saved; the title is derived
    // once a project has none.
    h.store.write((ctx) => ctx.tx.update(schema.projects).set({ prTitlePrefix: null }).run());
    h.teammatePush('main', '.10db/pr-scopes.json', row.scopes ?? SCOPES);
    const { workstreams } = await openBatch(row.title, ...row.tasks);
    for (const path of row.paths)
      h.commit(
        path,
        path === '.10db/pr-scopes.json' ? '{"scopes":{"ui":["src/ui", ".10db"]}}\n' : undefined,
      );
    for (const ws of workstreams)
      h.settle(ws.id, row.cancelled?.includes(ws.taskTitle) === true ? 'CANCELLED' : 'DONE');
    await h.jobs.idle();
    expect(h.gh.prCreates().map((c) => c.title)).toEqual([row.expected]);
  });

  it('titles the PR with no scope when the repo lists none and the project has no prefix', async () => {
    h = createDeliveryHarness();
    h.store.write((ctx) => ctx.tx.update(schema.projects).set({ prTitlePrefix: null }).run());
    const { batch } = await openBatch('Add greetings', 'Alpha');
    h.commit('src/api/alpha.txt');
    await finishAll(batch);
    expect(h.gh.prCreates().map((c) => c.title)).toEqual(['feat: add greetings']);
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

describe('the push', () => {
  it("ships without running the clone's pre-push hook, which a lane can write", async () => {
    h = createDeliveryHarness();
    const { batch } = await openBatch('Greetings', 'Alpha');
    h.commit('src/api/alpha.txt');
    const ran = join(h.repo, '.git', 'pre-push.ran');
    const hook = join(h.repo, '.git', 'refuse-push.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch '${ran}'\nexit 1\n`, { mode: 0o755 });
    writeHook(join(h.repo, '.git', 'hooks'), ['pre-push'], hook);
    const shipped = await finishAll(batch);
    expect(shipped.state).toBe('SHIPPED');
    expect(existsSync(ran)).toBe(false);
  });

  it('stops a push that runs past its timeout with every process it started, and fails the batch saying so', async () => {
    const ssh = hangingSsh(30);
    h = createDeliveryHarness({}, { pushTimeoutMs: 1_000, networkEnv: ssh.env });
    // Before the daemon first sees the checkout, which records origin's URLs.
    // A github.com push URL over ssh, whose ssh is the hanging stand-in.
    h.git$('remote', 'set-url', '--push', 'origin', 'git@github.com:acme/widgets.git');
    const { batch } = await openBatch('Greetings', 'Alpha');
    h.commit('src/api/alpha.txt');
    try {
      const ended = await finishAll(batch);
      expect(ended).toMatchObject({ state: 'FAILED', failure: 'network' });
      const card = h.only(h.cards());
      expect(card.title).toBe('Batch "Greetings" not shipped: git push ran past 1.0 s');
      expect(card.body).toContain('git push was still running after 1.0 s');
      const child = await ssh.childPid();
      await waitFor(() => !alive(child), 2_000);
      expect(onOrigin(batch.branch)).toBeNull();
      expect(h.gh.prCreates()).toEqual([]);
    } finally {
      ssh.cleanup();
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
