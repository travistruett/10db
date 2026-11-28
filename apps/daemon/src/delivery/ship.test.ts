import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConflictError,
  EvidenceKind,
  GUARDRAIL_DIFF_DETAIL,
  GuardrailDiffDetail,
  InboxAnswerRefused,
  InboxKind,
  WatchpointLoudness,
  WatchpointReadVerdict,
  type BatchDto,
  type TaskDto,
  type WatchpointDetail,
  type WatchpointHit,
  type WorkstreamId,
} from '@10db/contracts';
import {
  activeClaims,
  acquireClaims,
  claimRequestsForTask,
  deleteAppSetting,
  findOpenByFoldKey,
  getAppSetting,
  getBatch,
  getBatchRow,
  getTask,
  getWorkstream,
  insertEvidence,
  listInbox,
  listTasks,
  listWorkstreams,
  transitionBatch,
  transitionWorkstream,
  updateInboxItem,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { committed, onOrigin, shipped } from '../../test/delivery-worlds';
import { waitFor } from '../../test/fixtures';
import { alive } from '../../test/orphan-gate';
import { writeHook } from '../../test/git-hooks';
import { hangingSsh } from '../../test/hanging-ssh';
import { GitNetworkError, GitNetworkFailure, type Git } from '../git';
import { GhError, PrMergeable } from '../github';
import {
  createInboxService,
  GUARDRAIL_HOLD_DETAIL,
  GuardrailHoldDetail,
  type InboxService,
} from '../inbox';
import { listNetworkHosts } from '../permissions';
import { guardrailHoldKey } from './guardrail-hold';
import { createGuardrailHoldAnswers, guardrailHoldCardKey } from './guardrail-hold-card';
import { createWatchpointHoldAnswers } from './watchpoint-hold';

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
    expect(onOrigin(h, batch.branch)).toBeNull();
    expect(h.gh.prCreates()).toEqual([]);
    expect(batchLines(batch.id)).toMatchObject([
      { msg: 'batch branch cut' },
      { msg: 'batch closed', reason: 'no commits beyond the base' },
      { msg: 'checkout switched back', branch: batch.branch, to: { branch: 'main' } },
    ]);
  });

  it('pushes the branch, opens one PR titled with the prefix and records its URL, logging the cut, each gate run, the push, the pull request and the ship result, in order', async () => {
    h = createDeliveryHarness();
    const base = h.git$('rev-parse', 'HEAD');
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
    expect(onOrigin(h, batch.branch)).toBe(tip);
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
    // With no pre-check set, the gate is what ran.
    expect(body).toContain('Checked on the Mac: true (gate).');
    expect(getBatchRow(h.store.db, batch.id)).toMatchObject({ gatePid: null, gatePidStart: null });
    const lines = batchLines(batch.id);
    expect(lines.map((line) => line['msg'])).toEqual([
      'batch branch cut',
      'gate started',
      'gate finished',
      'git push finished',
      'gh pr create finished',
      'auto-merge turned on',
      'batch shipped',
      'checkout switched back',
    ]);
    const [cut, started, finished, push, pr, , done] = lines;
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
    expect(String(push?.['output'])).toContain('[new branch]');
    expect(pr).toMatchObject({
      repo: 'acme/widgets',
      baseBranch: 'main',
      branch: batch.branch,
      prUrl: 'https://github.com/acme/widgets/pull/1',
    });
    expect(done).toMatchObject({ prUrl: shipped.prUrl });
  });

  it("never merges the base into the builder's own checkout: the branch ships as it is", async () => {
    h = createDeliveryHarness();
    const { batch } = await openBatch('Add greetings', 'Alpha');
    const head = h.commit('src/api/alpha.txt');
    h.teammatePush('main', 'src/ui/teammate.txt');
    const shipped = await finishAll(batch);
    expect(shipped.state).toBe('SHIPPED');
    expect(onOrigin(h, batch.branch)).toBe(head);
    expect(h.git$('rev-parse', `refs/heads/${batch.branch ?? ''}`)).toBe(head);
    expect(h.git$('status', '--porcelain', '--untracked-files=all')).toBe('');
  });

  it("runs the project's full gate before the push, never its changed-packages check, and says in a failed gate's fix task how far the builder's own checkout is behind the base", async () => {
    h = createDeliveryHarness({ gateCommand: 'false', changedCheckCommand: 'true' });
    const { batch } = await openBatch('Add greetings', 'Alpha');
    h.commit('src/api/alpha.txt');
    h.teammatePush('main', 'src/ui/teammate.txt');
    const failed = await finishAll(batch);
    expect(failed.state).toBe('OPEN');
    expect(onOrigin(h, batch.branch)).toBeNull();
    expect(batchLines(batch.id).find((line) => line['msg'] === 'gate started')).toMatchObject({
      command: 'false',
    });
    const fix = h.only(
      listTasks(h.store.db, h.project.id).filter((t) => t.title.startsWith('Fix the gate')),
    );
    expect(fix.description).toMatch(/^origin\/main has 1 commit this branch doesn't\./);
  });

  it('runs no gate on a broken install and fails the batch with a card that names the install, not the gate', async () => {
    h = createDeliveryHarness(
      // Run in the checkout, a gate would leave this file there.
      { gateCommand: 'touch gate-ran' },
      {
        shipBaseUpdates: (real) => ({
          ...real,
          beforeGate: () =>
            Promise.resolve({
              kind: 'install_broken',
              note: 'The install in this copy is broken: 614 of 787 dependencies do not resolve (.: tsx).',
            }),
        }),
      },
    );
    const { batch } = await openBatch('Add greetings', 'Alpha');
    h.commit('src/api/alpha.txt');

    const failed = await finishAll(batch);

    expect(existsSync(join(h.repo, 'gate-ran'))).toBe(false);
    expect(failed).toMatchObject({ state: 'FAILED', failure: 'install_broken' });
    expect(onOrigin(h, batch.branch)).toBeNull();
    const card = h.only(h.cards());
    expect(card.title).toContain('the install in its copy is broken');
    expect(card.title).not.toContain('the gate failed');
    expect(card.body).toContain('.: tsx');
    expect(card.body).toContain('Retry');
    expect(card.body).toContain('Retry removes the copy');
  });

  it('offers clearing the notice, or Abandon, when the list of lost migrations could not be read', async () => {
    h = createDeliveryHarness(
      { gateCommand: 'touch gate-ran' },
      {
        shipBaseUpdates: (real) => ({
          ...real,
          beforeGate: () =>
            Promise.resolve({
              kind: 'uncarried',
              head: 'abc',
              note: 'The list could not be read.',
              unreadable: true,
            }),
        }),
      },
    );
    const { batch } = await openBatch('Add greetings', 'Alpha');
    h.commit('src/api/alpha.txt');

    const failed = await finishAll(batch);

    expect(existsSync(join(h.repo, 'gate-ran'))).toBe(false);
    expect(failed).toMatchObject({ state: 'FAILED', failure: 'base_conflict' });
    const card = h.only(h.cards());
    expect(card.body).toContain('The list could not be read.');
    expect(card.body).not.toContain('Re-create');
    expect(card.options.map((o) => o.label)).toEqual(['Clear the notice']);
    expect(card.detail).toMatchObject({
      batchId: batch.id,
      actions: ['retry', 'abandon'],
      lostMigrations: { batchId: batch.id },
    });
  });

  it('raises one card per host the sandbox blocked the shipping gate from, naming the command', async () => {
    // The sandbox's runner reports the hosts its proxy refused; this one reports them for any failure.
    h = createDeliveryHarness(
      { gateCommand: 'cargo test; exit 101' },
      {
        shipGate: (gate) => ({
          run: async (request) => {
            const result = await gate.run(request);
            return { ...result, blockedHosts: ['index.crates.io', 'static.crates.io'] };
          },
        }),
      },
    );
    const { batch } = await openBatch('Add greetings', 'Alpha');
    h.commit('src/api/alpha.txt');

    const failed = await finishAll(batch);

    expect(failed.state).toBe('OPEN');
    const hostCards = h.cards().filter((c) => c.title.startsWith('Allow network access to'));
    expect(hostCards.map((c) => c.title)).toEqual([
      'Allow network access to index.crates.io?',
      'Allow network access to static.crates.io?',
    ]);
    expect(hostCards[0]?.body).toContain('cargo test; exit 101');
    expect(hostCards[0]?.options.map((o) => o.label)).toEqual(['Allow for the project', 'Not now']);
  });

  it("names the file and recommends Allow on a blocked shipping gate's card for a project added before readings", async () => {
    h = createDeliveryHarness(
      { gateCommand: 'cargo test; exit 101' },
      {
        shipGate: (gate) => ({
          run: async (request) => {
            const result = await gate.run(request);
            return { ...result, blockedHosts: ['index.crates.io'] };
          },
        }),
      },
    );
    // The default branch commits a Cargo.lock three folders down; no reading was ever kept.
    h.commit(
      'apps/desktop/src-tauri/Cargo.lock',
      'source = "registry+https://github.com/rust-lang/crates.io-index"\n',
    );
    // A reading takes only origin's copy of the default branch, which a lane can't move.
    h.git$('push', '-q', 'origin', 'main');
    h.state.write((ctx) => {
      deleteAppSetting(ctx, `network-hosts-found:${h.project.id}`);
    });
    const { batch } = await openBatch('Add greetings', 'Alpha');
    h.commit('src/api/alpha.txt');

    const failed = await finishAll(batch);

    expect(failed.state).toBe('OPEN');
    const card = h.only(
      h.cards().filter((c) => c.title === 'Allow network access to index.crates.io?'),
    );
    expect(card.body).toContain(
      "The project's apps/desktop/src-tauri/Cargo.lock needs index.crates.io",
    );
    expect(card.recommendation).toBe('Allow for the project');
    expect(listNetworkHosts(h.state.db, h.project.id)).toEqual([]);
  });

  it('runs the pre-check in place of the gate when the project sets one, and says so in the pull request', async () => {
    h = createDeliveryHarness({
      gateCommand: 'echo FULL-GATE-RAN; exit 1',
      changedCheckCommand: 'false',
      precheckCommand: 'true',
    });
    const { batch } = await openBatch('Add greetings', 'Alpha');
    h.commit('src/api/alpha.txt');
    const shipped = await finishAll(batch);
    expect(shipped.state).toBe('SHIPPED');
    const started = batchLines(batch.id).filter((line) => line['msg'] === 'gate started');
    expect(started).toMatchObject([{ command: 'true' }]);
    const body = h.gh.body(shipped.prUrl ?? '');
    expect(body).toContain(
      "Checked on the Mac: true (pre-check). GitHub's required checks decide.",
    );
    expect(body).not.toContain('FULL-GATE-RAN');
  });

  it('reopens the batch with a fix task naming the pre-check when it fails, and pushes nothing', async () => {
    h = createDeliveryHarness({ gateCommand: 'true', precheckCommand: 'echo LINT-BROKE; exit 3' });
    const { batch } = await openBatch('Add greetings', 'Alpha');
    h.commit('src/api/alpha.txt');
    const failed = await finishAll(batch);
    expect(failed).toMatchObject({ state: 'OPEN', failure: null });
    expect(onOrigin(h, batch.branch)).toBeNull();
    expect(h.gh.prCreates()).toEqual([]);
    const fix = h.only(
      listTasks(h.store.db, h.project.id).filter((t) => t.title.startsWith('Fix the pre-check')),
    );
    expect(fix.description).toContain('LINT-BROKE');
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
      'auto-merge turned on',
      'batch shipped',
      'checkout switched back',
    ]);
    expect(existsSync(join(h.dataDir, 'logs', 'gate'))).toBe(false);
    expect(onOrigin(h, batch.branch)).toBe(h.git$('rev-parse', `refs/heads/${batch.branch ?? ''}`));
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
    // The template's placeholder comments are gone; the only comments left are the For you markers a later
    // ship replaces between.
    expect(
      body.replace('<!-- 10db:for-you -->', '').replace('<!-- /10db:for-you -->', ''),
    ).not.toContain('<!--');
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
    const before = onOrigin(h, batch.branch);
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
      expect(onOrigin(h, batch.branch)).toBe(before);
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

describe('a waiting update that drains the factory', () => {
  it('starts no ship while it drains, and ships the batch once lanes may start again', async () => {
    let draining = true;
    h = createDeliveryHarness({}, { holdShips: () => draining });
    const { batch } = await openBatch('Held', 'Alpha');
    h.commit('src/api/alpha.txt');
    const held = await finishAll(batch);
    // Every member is done, yet the batch stays open: nothing is pushed or opened.
    expect(held.state).toBe('OPEN');
    expect(onOrigin(h, batch.branch)).toBeNull();
    expect(h.gh.prCreates()).toEqual([]);
    expect(h.jobs.pending()).toBe(0);

    draining = false;
    h.shipper.checkOpenBatches();
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id).state).toBe('SHIPPED');
    expect(h.gh.prCreates()).toHaveLength(1);
  });

  it('does not stop a ship that began before the drain', async () => {
    let draining = false;
    h = createDeliveryHarness({}, { holdShips: () => draining });
    const { batch } = await openBatch('Running', 'Alpha');
    h.commit('src/api/alpha.txt');
    for (const ws of listWorkstreams(h.store.db, { batchId: batch.id })) h.settle(ws.id, 'DONE');
    draining = true;
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id).state).toBe('SHIPPED');
  });

  describe('a ship the builder asks for', () => {
    const ASKS: readonly (readonly [string, (id: BatchDto['id']) => BatchDto])[] = [
      ['Ship anyway or Retry on the Board', (id) => h.shipper.ship(id)],
      ['Ship anyway on a failed task’s card', (id) => h.shipper.shipAnyway(id)],
    ];

    /** Refuses `ask` while it drains, leaves the batch as it was, and ships it once it ended. */
    async function refusedThenShipped(
      batch: BatchDto,
      state: BatchDto['state'],
      ask: (id: BatchDto['id']) => BatchDto,
      endDrain: () => void,
    ) {
      expect(() => ask(batch.id)).toThrow(ConflictError);
      expect(() => ask(batch.id)).toThrow(/waiting update/);
      expect(getBatch(h.store.db, batch.id).state).toBe(state);
      expect(h.jobs.pending()).toBe(0);
      expect(h.gh.prCreates()).toEqual([]);

      endDrain();
      expect(ask(batch.id).state).toBe('SHIPPING');
      await h.jobs.idle();
      expect(getBatch(h.store.db, batch.id).state).toBe('SHIPPED');
    }

    it.each(ASKS)('refuses %s for an open batch while it drains', async (_name, ask) => {
      let draining = true;
      h = createDeliveryHarness({}, { holdShips: () => draining });
      const { batch, workstreams } = await openBatch('Held', 'Alpha');
      h.commit('src/api/alpha.txt');
      h.settle(h.only(workstreams).id, 'FAILED');
      await refusedThenShipped(batch, 'OPEN', ask, () => {
        draining = false;
      });
    });

    it.each(ASKS)('refuses %s for a failed batch while it drains', async (_name, ask) => {
      let draining = true;
      h = createDeliveryHarness({}, { holdShips: () => draining });
      const { batch, workstreams } = await openBatch('Held', 'Alpha');
      h.commit('src/api/alpha.txt');
      h.settle(h.only(workstreams).id, 'DONE');
      h.state.write((c) =>
        transitionBatch(c, batch.id, { to: 'FAILED', patch: { failure: 'wrong_branch' } }),
      );
      await refusedThenShipped(batch, 'FAILED', ask, () => {
        draining = false;
      });
    });

    it('lets Retry reopen a failed batch with unfinished work: that ships nothing', async () => {
      h = createDeliveryHarness({}, { holdShips: () => true });
      const { batch } = await openBatch('Held', 'Alpha');
      h.commit('src/api/alpha.txt');
      h.state.write((c) =>
        transitionBatch(c, batch.id, { to: 'FAILED', patch: { failure: 'wrong_branch' } }),
      );
      expect(h.shipper.ship(batch.id)).toMatchObject({ state: 'OPEN', failure: null });
    });
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
      expect(onOrigin(h, batch.branch)).toBeNull();
      expect(h.gh.prCreates()).toEqual([]);
    } finally {
      ssh.cleanup();
    }
  });
});

describe('a push the server fails', () => {
  const SERVER_REASON =
    ' ! [remote rejected] 10db/x -> 10db/x (fatal error in commit_refs_rules)\nerror: failed to push some refs to github.com';

  /** A git whose push throws GitHub's server error `failures` times before it pushes for real. */
  function failingPushes(failures: number) {
    const calls = { count: 0 };
    const wrapGit = (git: Git): Git => ({
      ...git,
      push: (repo, branch, net) => {
        calls.count += 1;
        if (calls.count <= failures)
          return Promise.reject(
            new GitNetworkError(GitNetworkFailure.ServerError, ['push'], SERVER_REASON, {
              durationMs: 1,
              output: SERVER_REASON,
            }),
          );
        return git.push(repo, branch, net);
      },
    });
    return { calls, wrapGit };
  }

  it('is retried by itself, and ships with no card when a retry lands', async () => {
    const pushes = failingPushes(2);
    h = createDeliveryHarness({}, { wrapGit: pushes.wrapGit });
    const { batch } = await openBatch('Greetings', 'Alpha');
    h.commit('src/api/alpha.txt');
    const shipped = await finishAll(batch);
    expect(shipped.state).toBe('SHIPPED');
    expect(pushes.calls.count).toBe(3);
    expect(h.cards()).toEqual([]);
    expect(onOrigin(h, batch.branch)).toBe(h.git$('rev-parse', `refs/heads/${batch.branch ?? ''}`));
  });

  it("quotes the remote's reason, and never says the branch diverged, when it keeps failing", async () => {
    const pushes = failingPushes(100);
    h = createDeliveryHarness({}, { wrapGit: pushes.wrapGit });
    const { batch } = await openBatch('Greetings', 'Alpha');
    h.commit('src/api/alpha.txt');
    const ended = await finishAll(batch);
    expect(ended).toMatchObject({ state: 'FAILED', failure: 'network' });
    // The first push and two retries, no more.
    expect(pushes.calls.count).toBe(3);
    const card = h.only(h.cards());
    expect(card.title).toContain('GitHub failed the push');
    expect(card.body).toContain('fatal error in commit_refs_rules');
    expect(card.body).not.toContain("has commits this checkout doesn't");
    expect(card.body).not.toMatch(/reconcile/i);
    expect(h.gh.prCreates()).toEqual([]);
  });

  it('is not retried when it is a real non-fast-forward, which still asks for a reconcile by hand', async () => {
    const pushes = failingPushes(0);
    h = createDeliveryHarness({}, { wrapGit: pushes.wrapGit });
    const { batch } = await openBatch('Greetings', 'Alpha');
    h.commit('src/api/alpha.txt');
    h.teammatePush(batch.branch ?? '', 'src/api/theirs.txt');
    const ended = await finishAll(batch);
    expect(ended).toMatchObject({ state: 'FAILED', failure: 'push_rejected' });
    expect(pushes.calls.count).toBe(1);
    expect(h.only(h.cards()).body).toContain("has commits this checkout doesn't");
  });
});

describe('a push the remote declines by repository rule or hook', () => {
  it.each([
    [
      'a rule violation',
      'remote: error: GH013: Repository rule violations found for refs/heads/10db/x.\n ! [remote rejected] 10db/x -> 10db/x (push declined due to repository rule violations)\nerror: failed to push some refs',
      'push declined due to repository rule violations',
    ],
    [
      'a hook decline',
      ' ! [remote rejected] 10db/x -> 10db/x (pre-receive hook declined)\nerror: failed to push some refs',
      'pre-receive hook declined',
    ],
  ])(
    '%s: one push, a card quoting the reason, no claim of divergence',
    async (_n, stderr, reason) => {
      const calls = { count: 0 };
      h = createDeliveryHarness(
        {},
        {
          wrapGit: (git: Git): Git => ({
            ...git,
            push: () => {
              calls.count += 1;
              return Promise.reject(
                new GitNetworkError(GitNetworkFailure.Declined, ['push'], stderr, {
                  durationMs: 1,
                  output: stderr,
                }),
              );
            },
          }),
        },
      );
      const { batch } = await openBatch('Greetings', 'Alpha');
      h.commit('src/api/alpha.txt');
      const ended = await finishAll(batch);
      expect(ended).toMatchObject({ state: 'FAILED', failure: 'network' });
      expect(calls.count).toBe(1);
      const card = h.only(h.cards());
      expect(card.body).toContain(reason);
      expect(card.body).toMatch(/repository rule or hook/);
      expect(card.body).not.toContain("has commits this checkout doesn't");
      expect(card.body).not.toMatch(/reconcile/i);
      expect(h.gh.prCreates()).toEqual([]);
    },
  );
});

describe('Ship anyway, Retry and Abandon', () => {
  it('refuses Ship anyway from the Board and the card alike until work a reviewer rejected is reviewed again', async () => {
    h = createDeliveryHarness();
    const { batch, workstreams } = await openBatch('Greetings', 'Alpha', 'Beta');
    const [alpha, beta] = workstreams;
    if (!alpha || !beta) throw new Error('two workstreams expected');
    h.commit('src/api/alpha.txt');
    h.settle(alpha.id, 'DONE');
    h.settle(beta.id, 'RUNNING');
    h.state.write((c) =>
      transitionWorkstream(c, beta.id, {
        to: 'FAILED',
        fence: null,
        patch: { failureKind: 'rejected_at_limit' },
      }),
    );
    for (const ask of [() => h.shipper.ship(batch.id), () => h.shipper.shipAnyway(batch.id)])
      expect(ask).toThrow(/Beta failed review, and 10db reviews it again/);
    expect(getBatch(h.store.db, batch.id).state).toBe('OPEN');
    expect(h.jobs.pending()).toBe(0);
  });

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
    // The builder just asked for this: no "abandoned" card, only the offer to delete the branch.
    expect(h.cards()).toEqual([]);
    await h.jobs.idle();
    expect(h.only(h.cards()).title).toContain(`Delete ${batch.branch ?? ''}?`);
    expect(getBatch(h.store.db, batch.id).state).toBe('ABANDONED');
  });

  it('deletes a shared batch abandoned before any commit, and its notice names no worktree', async () => {
    h = createDeliveryHarness();
    const { batch } = await openBatch('Greetings', 'Alpha');
    expect(batch.worktreePath).toBeNull();
    expect(h.shipper.abandon(batch.id).state).toBe('ABANDONED');
    await h.jobs.idle();
    expect(h.git$('branch', '--list', batch.branch ?? '')).toBe('');
    expect(h.cards()).toEqual([]);
    const notice = h.only(h.notices());
    expect(notice.line).toContain(`${batch.branch ?? ''} deleted`);
    expect(notice.body).toContain('held no commits beyond');
    expect(notice.body).not.toMatch(/worktree/i);
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

describe('a pull request that touches a guardrail path', () => {
  const WORKFLOW = '.github/workflows/x.yml';
  const GIT_GUARD = '.claude/hooks/git-guard.mjs';

  /** The inbox the builder answers through, with the held pull request's answers wired to `h`. */
  function answering(): InboxService {
    const answers = createGuardrailHoldAnswers(h.ctx, h.shipper);
    return createInboxService({
      state: h.state,
      onParkedAnswer: () => undefined,
      onFlagAnswerInWrite: (ctx, item, answer) => answers.onAnswerInWrite(ctx, item, answer),
    });
  }

  const holdCardOf = (batch: BatchDto) =>
    findOpenByFoldKey(h.store.db, h.project.id, guardrailHoldCardKey(batch.id));

  function openHoldCard(batch: BatchDto) {
    const card = holdCardOf(batch);
    if (card === undefined) throw new Error('the pull request has no open hold card');
    return card;
  }

  it('opens with no auto-merge and no merge, and raises one card with the diff, Merge and Close', async () => {
    h = createDeliveryHarness();
    const { batch } = await openBatch('Add CI', 'Alpha');
    h.commit(WORKFLOW);
    const shipped = await finishAll(batch);
    expect(shipped).toMatchObject({
      state: 'SHIPPED',
      prUrl: 'https://github.com/acme/widgets/pull/1',
    });
    expect(h.gh.autoMerged).toEqual([]);
    expect(h.gh.merged).toEqual([]);
    const card = holdCardOf(batch);
    expect(card).toMatchObject({
      title: 'A change to your CI workflows is ready',
      options: [{ label: 'Merge' }, { label: 'Close' }],
    });
    expect(card?.body).toContain(WORKFLOW);
    const diff = GuardrailDiffDetail.parse(card?.detail?.[GUARDRAIL_DIFF_DETAIL]);
    expect(diff).toMatchObject({ shown: 'text' });
    expect(diff.shown === 'text' ? diff.text : '').toContain(`+${WORKFLOW}`);
    expect(h.cards()).toHaveLength(1);
  });

  it('arms auto-merge for exactly the diff the builder merged', async () => {
    h = createDeliveryHarness();
    const { batch } = await openBatch('Add CI', 'Alpha');
    h.commit(WORKFLOW);
    const shipped = await finishAll(batch);
    const card = openHoldCard(batch);
    const hash = GuardrailHoldDetail.parse(card.detail?.[GUARDRAIL_HOLD_DETAIL]).hash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    answering().answer(card.id, { choice: 'Merge' });
    await h.jobs.idle();

    expect(h.gh.autoMerged).toEqual([shipped.prUrl]);
    expect(getAppSetting(h.store.db, guardrailHoldKey(batch.id))).toEqual({ approved: hash });
    expect(holdCardOf(batch)).toBeUndefined();
  });

  it('holds a pull request whose diff changed since the builder merged, and asks again', async () => {
    h = createDeliveryHarness();
    const { batch } = await openBatch('Add CI', 'Alpha');
    h.commit(WORKFLOW);
    const shipped = await finishAll(batch);
    answering().answer(openHoldCard(batch).id, { choice: 'Merge' });
    await h.jobs.idle();
    expect(h.gh.autoMerged).toEqual([shipped.prUrl]);

    // The approved diff moves on: a retry reads the pull request again and arms nothing.
    h.commit(WORKFLOW, 'name: changed\n');
    h.git$('push', '-q', 'origin', batch.branch ?? '');
    h.gh.setHead(shipped.prUrl ?? '', h.git$('rev-parse', 'HEAD'));
    h.shipper.retryMerge(batch.id, { catchUpCardWasOpen: true });
    await h.jobs.idle();

    expect(h.gh.autoMerged).toEqual([shipped.prUrl]);
    expect(holdCardOf(batch)).toMatchObject({ title: 'A change to your CI workflows is ready' });
  });

  it('turns auto-merge off before it pushes, and pushes nothing when it cannot', async () => {
    h = createDeliveryHarness();
    const { batch } = await openBatch('Add CI', 'Alpha');
    h.commit(WORKFLOW);
    // An earlier ship armed the pull request and failed before it recorded it: the batch has no URL.
    const url = h.gh.openPr(batch.branch ?? '');
    h.gh.failNext.set('prDisableAutoMerge', new GhError('failed', 'GitHub refused'));

    const failed = await finishAll(batch);

    expect(failed.state).toBe('FAILED');
    expect(onOrigin(h, batch.branch)).toBeNull();
    expect(h.gh.autoMerged).toEqual([]);

    h.shipper.ship(batch.id);
    await h.jobs.idle();

    expect(getBatch(h.store.db, batch.id)).toMatchObject({ state: 'SHIPPED', prUrl: url });
    expect(h.gh.autoMergeOff).toEqual([url]);
    expect(onOrigin(h, batch.branch)).toBe(h.git$('rev-parse', `refs/heads/${batch.branch ?? ''}`));
    expect(h.gh.autoMerged).toEqual([]);
  });

  it('holds a change that moves a guardrail file out of its folder', async () => {
    h = createDeliveryHarness();
    h.commit(GIT_GUARD, 'guard\n');
    h.git$('push', '-q', 'origin', 'main');
    const { batch } = await openBatch('Move the guard', 'Alpha');
    h.commit('tools/git-guard.mjs', 'guard\n');
    h.git$('rm', '-q', GIT_GUARD);
    h.git$('commit', '-q', '-m', 'Move the git guard');
    await finishAll(batch);
    expect(h.gh.autoMerged).toEqual([]);
    expect(holdCardOf(batch)).toMatchObject({ title: 'A change to your git guard is ready' });
  });
});

describe('a pull request whose change hit a watchpoint set to Hold', () => {
  const WATCHED = 'src/api/watched.txt';

  /** A hit on the watchpoint; null for a hash means its diff could not be read in full. */
  const hitOf = (
    hash: string | null = 'hash-1',
    loudness: WatchpointLoudness = WatchpointLoudness.Hold,
  ): WatchpointHit => ({
    watchpoint: {
      key: 'migrations',
      label: 'Migrations',
      why: 'A revert cannot undo one',
      guidance: 'Check it runs on existing data',
      loudness,
    },
    files: [{ path: WATCHED, status: 'A', added: 1, removed: 0, patch: '', clipped: false }],
    ...(hash === null ? {} : { hash }),
  });

  /** Stores a run's reading as the runner's write does, for the run's workstream. */
  function readingOf(workstreamId: WorkstreamId, detail: Partial<WatchpointDetail> = {}): void {
    h.state.write((w) => {
      insertEvidence(w, {
        workstreamId,
        kind: EvidenceKind.Watchpoint,
        command: null,
        exitCode: null,
        summary: 'A watchpoint file changed.',
        logPath: null,
        commitShas: [],
        detail: { hits: [hitOf()], head: 'head', skipped: null, ...detail },
      });
    });
  }

  const lookCards = () =>
    listInbox(h.store.db, { states: ['OPEN'] }).filter((i) => i.kind === InboxKind.Watchpoint);

  function openLookCard() {
    const [card] = lookCards();
    if (card === undefined || lookCards().length !== 1)
      throw new Error('the pull request has no single open Look card');
    return card;
  }

  /** The inbox the builder answers through, with a Look card's answers wired to `h` as the daemon does. */
  function answering(): InboxService {
    const answers = createWatchpointHoldAnswers(h.ctx, h.shipper);
    return createInboxService({
      state: h.state,
      onParkedAnswer: () => undefined,
      onWatchpointAnswer: (ctx, item, answer) => answers.onAnswerInWrite(ctx, item, answer),
    });
  }

  /** A batch of one task with a reading that hits the watchpoint, shipped and held. */
  async function heldPullRequest(detail: Partial<WatchpointDetail> = {}) {
    h = createDeliveryHarness();
    const { batch, workstreams } = await openBatch('Add a migration', 'Alpha');
    h.commit(WATCHED);
    const workstreamId = h.only(workstreams).id;
    readingOf(workstreamId, detail);
    const shipped = await finishAll(batch);
    return { batch, workstreamId, prUrl: shipped.prUrl ?? '' };
  }

  it('opens with no auto-merge and raises one Look card with Merge on it', async () => {
    h = createDeliveryHarness();
    const { batch, workstreams } = await openBatch('Add a migration', 'Alpha');
    h.commit(WATCHED);
    readingOf(h.only(workstreams).id);
    const shipped = await finishAll(batch);
    expect(shipped).toMatchObject({
      state: 'SHIPPED',
      prUrl: 'https://github.com/acme/widgets/pull/1',
    });
    expect(h.gh.autoMerged).toEqual([]);
    expect(h.gh.merged).toEqual([]);
    expect(lookCards()).toHaveLength(1);
    expect(lookCards()[0]?.options.map((o) => o.label)).toEqual(['merge', 'send_back']);
    expect(lookCards()[0]?.detail).toMatchObject({
      held: { batchId: batch.id, prUrl: shipped.prUrl },
    });
  });

  it('arms auto-merge when the builder answers Merge, and holds again for a later change to the files', async () => {
    const { batch, workstreamId, prUrl } = await heldPullRequest();

    answering().answer(openLookCard().id, { choice: 'merge' });
    await h.jobs.idle();
    expect(h.gh.autoMerged).toEqual([prUrl]);
    expect(lookCards()).toEqual([]);

    // The files change again: a new hash, which no Merge covers.
    readingOf(workstreamId, { hits: [hitOf('hash-2')] });
    h.shipper.retryMerge(batch.id, { catchUpCardWasOpen: true });
    await h.jobs.idle();
    expect(h.gh.autoMerged).toEqual([prUrl]);
    expect(lookCards()).toHaveLength(1);
  });

  it('refuses Merge for a diff 10db could not read in full, and arms nothing', async () => {
    await heldPullRequest({ hits: [hitOf(null)] });
    const card = openLookCard();
    expect(card.body).toContain("10db could not read this whole diff, so it can't approve it");

    expect(() => answering().answer(card.id, { choice: 'merge' })).toThrow(InboxAnswerRefused);
    await h.jobs.idle();
    expect(h.gh.autoMerged).toEqual([]);
    expect(openLookCard().id).toBe(card.id);
  });

  it('holds nothing for the base files a catch-up merges into the branch', async () => {
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
    h.commit('src/index.ts', 'export {};\n');
    h.git$('push', '-q', 'origin', 'main');
    // The run changed no watched file, so its reading has no hit.
    const world = await committed(h, { path: 'src/api/alpha.txt' });
    readingOf(world.ws.id, { hits: [] });
    const { batch, prUrl } = await shipped(h, { from: world });
    expect(h.gh.autoMerged).toEqual([prUrl]);

    h.teammatePush('main', WATCHED);
    h.gh.setHead(prUrl, h.origin$('rev-parse', `refs/heads/${batch.branch ?? ''}`));
    h.gh.setMergeBlocked(prUrl, 'conflicts');
    h.gh.setMergeable(prUrl, PrMergeable.Conflicting);
    h.shipper.catchUp(batch.id);
    await h.jobs.idle();

    expect(h.origin$('ls-tree', '-r', '--name-only', `refs/heads/${batch.branch ?? ''}`)).toContain(
      WATCHED,
    );
    expect(h.gh.autoMergeOff).toEqual([]);
    expect(lookCards()).toEqual([]);
  });

  it('holds nothing for a reading with a judge answer or a question and no hit', async () => {
    h = createDeliveryHarness();
    const { batch, workstreams } = await openBatch('Add a migration', 'Alpha');
    h.commit(WATCHED);
    readingOf(h.only(workstreams).id, {
      hits: [],
      reads: [{ key: 'migrations', verdict: 'finding', meets: 0, destructive: 0, acted: true }],
      shadow: [{ key: 'migrations', label: 'Migrations', asked: [WATCHED], more: 0, yes: 0 }],
    });
    const shipped = await finishAll(batch);
    expect(h.gh.autoMerged).toEqual([shipped.prUrl]);
    expect(lookCards()).toEqual([]);
  });

  it.each([
    { verdict: WatchpointReadVerdict.Finding, acted: true, held: true },
    { verdict: WatchpointReadVerdict.Doubt, acted: true, held: true },
    { verdict: WatchpointReadVerdict.Clean, acted: true, held: false },
    // A read kept in shadow acts on nothing: the Ask hit is today's card and holds nothing.
    { verdict: WatchpointReadVerdict.Finding, acted: false, held: false },
  ])(
    'ships an Ask hit read as $verdict (acted: $acted) held: $held',
    async ({ verdict, acted, held }) => {
      h = createDeliveryHarness();
      const { batch, workstreams } = await openBatch('Add a migration', 'Alpha');
      h.commit(WATCHED);
      readingOf(h.only(workstreams).id, {
        hits: [hitOf('hash-1', WatchpointLoudness.Ask)],
        reads: [{ key: 'migrations', verdict, meets: 0.1, destructive: 0.1, acted }],
      });
      const shipped = await finishAll(batch);
      if (held) {
        expect(h.gh.autoMerged).toEqual([]);
        expect(lookCards()).toHaveLength(1);
        expect(lookCards()[0]?.options.map((o) => o.label)).toEqual(['merge', 'send_back']);
        expect(lookCards()[0]?.detail).toMatchObject({
          held: { batchId: batch.id, prUrl: shipped.prUrl },
          watchpoints: [{ key: 'migrations', verdict }],
        });
      } else {
        expect(h.gh.autoMerged).toEqual([shipped.prUrl]);
        // The run raises the Look card when it records the reading, not the ship, so a read that holds nothing
        // leaves no held card here.
        expect(lookCards()).toEqual([]);
      }
    },
  );

  it('is still held after a restart: a retry arms nothing and the card stays open', async () => {
    const { batch } = await heldPullRequest();
    const card = openLookCard();

    h.restartShipper();
    h.shipper.retryMerge(batch.id, { catchUpCardWasOpen: true });
    await h.jobs.idle();

    expect(h.gh.autoMerged).toEqual([]);
    expect(openLookCard().id).toBe(card.id);
  });

  it('closes the pull request and files a task naming it when the builder sends it back', async () => {
    const { prUrl } = await heldPullRequest();

    answering().answer(openLookCard().id, { choice: 'send_back', note: 'Make it reversible' });
    await waitFor(() => h.gh.closed.length > 0);

    expect(h.gh.closed).toEqual([prUrl]);
    expect(h.gh.autoMerged).toEqual([]);
    const followUp = h.only(
      listTasks(h.store.db, h.project.id).filter((t) => t.title.startsWith('Revisit')),
    );
    expect(followUp.description).toContain('Make it reversible');
    expect(followUp.description).toContain(prUrl);
  });

  it('raises the card again when it was resolved by hand and the pull request is still held', async () => {
    const { batch, prUrl } = await heldPullRequest();
    const card = openLookCard();
    h.state.write((w) => updateInboxItem(w, card.id, { state: 'RESOLVED' }));
    expect(lookCards()).toEqual([]);

    h.shipper.retryMerge(batch.id, { catchUpCardWasOpen: true });
    await h.jobs.idle();

    expect(h.gh.autoMerged).toEqual([]);
    expect(openLookCard()).toMatchObject({ detail: { held: { prUrl } } });
  });

  it('is not released by a later reading that could not be read', async () => {
    const { batch, workstreamId } = await heldPullRequest();

    readingOf(workstreamId, { hits: [], skipped: 'the changes could not be read' });
    h.shipper.retryMerge(batch.id, { catchUpCardWasOpen: true });
    await h.jobs.idle();

    expect(h.gh.autoMerged).toEqual([]);
    expect(lookCards()).toHaveLength(1);
  });
});
