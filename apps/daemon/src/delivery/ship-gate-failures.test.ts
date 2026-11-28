import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BatchDto, ProjectInput } from '@10db/contracts';
import {
  findOpenByFoldKey,
  getBatch,
  getTask,
  insertEvidence,
  listTasks,
  listWorkstreams,
  transitionBatch,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { tempDir } from '../../test/fixtures';
import type { GateRunner } from '../verify';
import { shipFailureFoldKey } from './cards';
import { readGateFix } from './gate-fix';
import { DEFAULT_DELIVERY_LIMITS, openPass, type PutBackKeptWork } from './index';

const PAGES: Partial<ProjectInput> = {
  areas: [
    { name: 'api', globs: ['src/api/**'] },
    { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
  ],
};

const nothingKept: PutBackKeptWork = () => Promise.resolve({ applied: [], left: [] });

let h: DeliveryHarness;
afterEach(() => {
  h.close();
});

/**
 * A gate shaped like the repo's own: each run writes `.gate/test.log` and, for its first `fails` runs,
 * fails `tests` in vitest's words with a FAILED line naming the step. It counts its runs in `.gate/runs`.
 */
function fakeGate(fails: number, tests: readonly string[]): string {
  const script = join(tempDir('fake-gate').path, 'gate.sh');
  const failLines = tests.map((t) => ` FAIL  daemon  ${t}`).join('\n');
  writeFileSync(
    script,
    [
      'mkdir -p .gate',
      'n=$(cat .gate/runs 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > .gate/runs',
      `if [ "$n" -le ${String(fails)} ]; then`,
      `  printf '%s\\n' '${failLines}' 'AssertionError: expected 1 to be 2' > .gate/test.log`,
      "  echo 'FAILED test: pnpm test (log .gate/test.log)'",
      "  echo 'GATE FAIL: test — logs in .gate/; test 1s (1s)'",
      '  exit 1',
      'fi',
      'echo ok > .gate/test.log',
      "echo 'GATE PASS test 1s (1s)'",
    ].join('\n'),
  );
  return `sh ${script}`;
}

function gateRuns(): number {
  return Number(readFileSync(join(h.repo, '.gate', 'runs'), 'utf8').trim());
}

/** Opens a one-task batch whose task commits `src/api/alpha.txt` (and `.gitignore`, keeping `.gate/` out). */
async function openBatch(): Promise<BatchDto> {
  const task = h.addTask('Alpha', { areas: ['api'] });
  const started = h.only(
    h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: [task.id] }),
  );
  await h.jobs.idle();
  h.commit('.gitignore', '.gate/\n');
  h.commit('src/api/alpha.txt');
  return getBatch(h.store.db, started.id);
}

/** Every member DONE, as the runner leaves them, with its own gate's verdict when `ownGate` is given. */
async function finish(batch: BatchDto, ownGate: number | null): Promise<BatchDto> {
  for (const ws of listWorkstreams(h.store.db, { batchId: batch.id })) {
    if (ownGate !== null)
      h.state.write((ctx) =>
        insertEvidence(ctx, {
          workstreamId: ws.id,
          kind: 'gate',
          command: 'make gate',
          exitCode: ownGate,
          summary: ownGate === 0 ? 'GATE PASS' : 'GATE FAIL: test',
          logPath: null,
          commitShas: [],
        }),
      );
    h.settle(ws.id, 'DONE');
  }
  await h.jobs.idle();
  return getBatch(h.store.db, batch.id);
}

describe('a shipping gate that fails', () => {
  it('files one fix task in the batch and reopens it, with no card, when a failing test is in a file the batch changed', async () => {
    h = createDeliveryHarness({ gateCommand: fakeGate(1, ['src/api/alpha.test.ts > works']) });
    const batch = await openBatch();
    h.commit('src/api/alpha.test.ts');
    const tasks = listTasks(h.store.db, h.project.id).length;
    const before = new Set(listWorkstreams(h.store.db, { batchId: batch.id }).map((ws) => ws.id));
    const ticks = h.ticks.count;
    const ended = await finish(batch, 0);
    expect(ended).toMatchObject({ state: 'OPEN', failure: null });
    expect(gateRuns()).toBe(1);
    expect(findOpenByFoldKey(h.store.db, h.project.id, shipFailureFoldKey(batch.id))).toBe(
      undefined,
    );
    expect(h.cards()).toEqual([]);
    const fix = h.only(
      listWorkstreams(h.store.db, { batchId: batch.id }).filter((ws) => !before.has(ws.id)),
    );
    expect(fix.state).toBe('QUEUED');
    const task = getTask(h.store.db, fix.taskId);
    expect(task.title).toMatch(/^Fix the gate/);
    expect(listTasks(h.store.db, h.project.id)).toHaveLength(tasks + 1);
    expect(task.description).toContain('src/api/alpha.test.ts > works');
    expect(task.description).toContain('AssertionError');
    expect(task.description).toContain(join(h.repo, '.gate', 'test.log'));
    expect(readGateFix(h.store.db, batch.id, DEFAULT_DELIVERY_LIMITS.maxFixAttempts).count).toBe(1);
    expect(h.ticks.count).toBeGreaterThan(ticks);
  });

  it("keeps today's card for a Workbench pass's batch, and files no fix", async () => {
    h = createDeliveryHarness({
      ...PAGES,
      gateCommand: fakeGate(1, ['src/settings/page.test.ts > works']),
    });
    const settings = h.addTask('Settings page', { areas: ['settings'] });
    const opened = await openPass(
      h.ctx,
      { projectId: h.project.id, name: 'Polish pages', taskIds: [settings.id] },
      { leaseMs: 60_000, putBack: nothingKept },
    );
    const batchId = opened.batch.id;
    h.commit('.gitignore', '.gate/\n');
    h.commit('src/settings/page.test.ts');
    const tasks = listTasks(h.store.db, h.project.id).length;
    // A pass's batch is never shipped by `checkBatch`: its runs are settled, then it is sent to ship.
    for (const ws of listWorkstreams(h.store.db, { batchId })) h.settle(ws.id, 'DONE');
    await h.jobs.idle();
    h.state.write((w) =>
      transitionBatch(w, batchId, { to: 'SHIPPING', patch: { failure: null }, reason: 'test' }),
    );
    h.shipper.resume(batchId);
    await h.jobs.idle();
    expect(getBatch(h.store.db, batchId)).toMatchObject({
      state: 'FAILED',
      failure: 'gate_failed',
    });
    expect(h.only(h.cards()).body).toContain('Start a fix task');
    expect(listTasks(h.store.db, h.project.id)).toHaveLength(tasks);
    expect(readGateFix(h.store.db, batchId, DEFAULT_DELIVERY_LIMITS.maxFixAttempts).count).toBe(0);
  });
});

describe('a shipping gate that fails only in tests that pass when their files are rerun', () => {
  /** Answers the rerun of test files (`pnpm exec vitest run …`) as `exitCode` says; the gate itself runs for real. */
  function rerunning(exitCode: number, commands: string[]) {
    return {
      shipGate: (gate: GateRunner): GateRunner => ({
        run: (request) => {
          if (!request.command.startsWith('pnpm exec vitest run')) return gate.run(request);
          commands.push(request.command);
          return Promise.resolve({
            exitCode,
            durationMs: 1,
            tail: exitCode === 0 ? 'ok' : 'still red',
            logPath: request.logPath,
            timedOut: false,
            aborted: false,
            blockedHosts: [],
          });
        },
      }),
    };
  }

  it("ships with no card even for a test in a file the batch changed, names the flake on the batch's tasks and files one Icebox task", async () => {
    const commands: string[] = [];
    h = createDeliveryHarness(
      { gateCommand: fakeGate(1, ['src/api/alpha.test.ts > works']) },
      rerunning(0, commands),
    );
    const batch = await openBatch();
    h.commit('src/api/alpha.test.ts');
    const ended = await finish(batch, 0);
    expect(ended.state).toBe('SHIPPED');
    expect(commands).toEqual(['pnpm exec vitest run src/api/alpha.test.ts']);
    // The gate itself ran once: the rerun is of the failing file, not of the gate.
    expect(gateRuns()).toBe(1);
    expect(h.cards()).toEqual([]);
    const notice = h.only(ended.notices.filter((n) => n.key === 'gate-flaky'));
    expect(notice.body).toContain('src/api/alpha.test.ts > works');
    const filed = listTasks(h.store.db, h.project.id).filter(
      (t) => t.title === 'Fix flaky test file src/api/alpha.test.ts',
    );
    expect(h.only(filed).description).toContain('works');
  });

  it('is the failure it was when the rerun fails too: a fix task in the batch, no card', async () => {
    const commands: string[] = [];
    h = createDeliveryHarness(
      { gateCommand: fakeGate(1, ['src/api/alpha.test.ts > works']) },
      rerunning(1, commands),
    );
    const batch = await openBatch();
    h.commit('src/api/alpha.test.ts');
    const ended = await finish(batch, 0);
    expect(ended).toMatchObject({ state: 'OPEN', failure: null });
    expect(commands).toHaveLength(1);
    expect(h.cards()).toEqual([]);
    expect(
      listTasks(h.store.db, h.project.id).filter((t) => t.title.startsWith('Fix the gate')),
    ).toHaveLength(1);
    expect(
      listTasks(h.store.db, h.project.id).filter((t) => t.title.startsWith('Fix flaky')),
    ).toEqual([]);
  });
});

describe('a shipping gate that fails only in tests the batch could not have caused', () => {
  it("runs once more by itself and ships when that passes, saying so as a notice on the batch's tasks, not a card", async () => {
    h = createDeliveryHarness({ gateCommand: fakeGate(1, ['src/ui/other.test.ts > flakes']) });
    const batch = await openBatch();
    const ended = await finish(batch, 0);
    expect(ended.state).toBe('SHIPPED');
    expect(gateRuns()).toBe(2);
    expect(h.cards()).toEqual([]);
    const notice = h.only(ended.notices.filter((n) => n.key === 'gate-rerun'));
    expect(notice.tone).toBe('info');
    expect(notice.line).toBe('The gate passed when 10db ran it again');
    expect(notice.body).toContain('- src/ui/other.test.ts > flakes');
    expect(h.logs.lines().map((l) => l['msg'])).toContain(
      'ship gate failed only in tests the batch did not change; running it again',
    );
  });

  it('raises the out-of-moves card when the second run fails too, with no Retry or Abandon, and starts no fix', async () => {
    h = createDeliveryHarness({ gateCommand: fakeGate(9, ['src/ui/other.test.ts > flakes']) });
    const batch = await openBatch();
    const workstreams = listWorkstreams(h.store.db, {}).length;
    const ticks = h.ticks.count;
    const ended = await finish(batch, 0);
    expect(ended).toMatchObject({ state: 'FAILED', failure: 'gate_failed' });
    expect(gateRuns()).toBe(2);
    const card = h.only(h.cards());
    expect(card.title).toBe('Out of moves: 1 test fails in test · Greetings');
    expect(card.body).toMatch(
      /^The gate fails in files the batch did not change, and 10db ran it twice\./,
    );
    expect(card.body).toContain('- src/ui/other.test.ts > flakes');
    expect(card.options.map((o) => o.label)).toEqual([
      'Spend More Attempts',
      'Change the Task',
      'Drop It',
    ]);
    expect(card.detail).toMatchObject({
      logPath: join(h.repo, '.gate', 'test.log'),
      outOfMoves: { kind: 'gate', batchId: batch.id, outside: true },
    });
    expect(card.detail).not.toHaveProperty('actions');
    expect(listWorkstreams(h.store.db, {})).toHaveLength(workstreams);
    expect(h.ticks.count).toBe(ticks);
  });
});
