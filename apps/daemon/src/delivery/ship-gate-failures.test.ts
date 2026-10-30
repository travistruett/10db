import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BatchDto } from '@10db/contracts';
import { getBatch, insertEvidence, listWorkstreams } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { tempDir } from '../../test/fixtures';

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
      `  printf '%s\\n' '${failLines}' > .gate/test.log`,
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

const SEVEN = [1, 2, 3, 4, 5, 6, 7].map((n) => `src/api/alpha.test.ts > case ${String(n)}`);

describe('a shipping gate that fails', () => {
  it('names the failing step and up to 5 failing tests, with a link to the step log', async () => {
    h = createDeliveryHarness({ gateCommand: fakeGate(9, SEVEN) });
    const batch = await openBatch();
    h.commit('src/api/alpha.test.ts');
    const ended = await finish(batch, 0);
    expect(ended).toMatchObject({ state: 'FAILED', failure: 'gate_failed' });
    const card = h.only(h.cards());
    expect(card.title).toBe('Batch "Greetings" not shipped: the gate failed (exit 1) in test');
    for (const test of SEVEN.slice(0, 5)) expect(card.body).toContain(`- ${test}`);
    expect(card.body).not.toContain('case 6');
    expect(card.body).toContain('- and 2 more');
    const log = join(h.repo, '.gate', 'test.log');
    expect(card.body).toContain(`Full test log: ${log}`);
    expect(card.detail).toMatchObject({ batchId: batch.id, logPath: log });
  });

  it("doesn't run it again when a failing test is in a file the batch changed", async () => {
    h = createDeliveryHarness({ gateCommand: fakeGate(1, ['src/api/alpha.test.ts > works']) });
    const batch = await openBatch();
    h.commit('src/api/alpha.test.ts');
    const ended = await finish(batch, 0);
    expect(ended.state).toBe('FAILED');
    expect(gateRuns()).toBe(1);
    const card = h.only(h.cards());
    expect(card.body).toContain('Start a fix task');
    expect(card.detail?.['actions']).toBeUndefined();
  });

  it("doesn't run it again when the task's own gate didn't pass", async () => {
    h = createDeliveryHarness({ gateCommand: fakeGate(1, ['src/ui/other.test.ts > works']) });
    const batch = await openBatch();
    expect((await finish(batch, null)).state).toBe('FAILED');
    expect(gateRuns()).toBe(1);
  });

  it("doesn't run it again when a step other than the tests failed", async () => {
    h = createDeliveryHarness({
      gateCommand: 'echo "FAILED lint: pnpm lint (log .gate/lint.log)"; exit 1',
    });
    const batch = await openBatch();
    const ended = await finish(batch, 0);
    expect(ended.state).toBe('FAILED');
    expect(h.only(h.cards()).title).toContain('the gate failed (exit 1) in lint');
    expect(h.logs.lines().filter((l) => l['msg'] === 'gate started')).toHaveLength(1);
  });
});

describe('a shipping gate that fails only in tests the batch could not have caused', () => {
  it('runs once more by itself and ships when that passes, saying so on a card', async () => {
    h = createDeliveryHarness({ gateCommand: fakeGate(1, ['src/ui/other.test.ts > flakes']) });
    const batch = await openBatch();
    const ended = await finish(batch, 0);
    expect(ended.state).toBe('SHIPPED');
    expect(gateRuns()).toBe(2);
    const card = h.only(h.cards());
    expect(card.title).toBe('Batch "Greetings": the gate passed when 10db ran it again');
    expect(card.body).toContain('- src/ui/other.test.ts > flakes');
    expect(h.logs.lines().map((l) => l['msg'])).toContain(
      'ship gate failed only in tests the batch did not change; running it again',
    );
  });

  it('says the failure looks unrelated when the second run fails too, offers Retry and Abandon, and starts no fix', async () => {
    h = createDeliveryHarness({ gateCommand: fakeGate(9, ['src/ui/other.test.ts > flakes']) });
    const batch = await openBatch();
    const workstreams = listWorkstreams(h.store.db, {}).length;
    const ticks = h.ticks.count;
    const ended = await finish(batch, 0);
    expect(ended).toMatchObject({ state: 'FAILED', failure: 'gate_failed' });
    expect(gateRuns()).toBe(2);
    const card = h.only(h.cards());
    expect(card.title).toBe(
      'Batch "Greetings" not shipped: the gate failed twice, in tests the batch didn\'t change',
    );
    expect(card.body).toContain('looks unrelated to the batch');
    expect(card.body).toContain('10db ran the gate again by itself');
    expect(card.body).toContain('- src/ui/other.test.ts > flakes');
    expect(card.body).not.toContain('Start a fix task');
    expect(card.detail).toMatchObject({
      batchId: batch.id,
      logPath: join(h.repo, '.gate', 'test.log'),
      actions: ['retry', 'abandon'],
    });
    expect(listWorkstreams(h.store.db, {})).toHaveLength(workstreams);
    expect(h.ticks.count).toBe(ticks);
  });
});
