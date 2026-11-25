import { createDeliveryJobs, workstreamChanges } from '../delivery';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ConflictError,
  InboxAnswerRefused,
  LEFT_OUT_NOTICE_KEY,
  mintId,
  MIGRATIONS_RENUMBERED_NOTICE_KEY,
  MIGRATIONS_UNCARRIED_NOTICE_KEY,
  PARK_TASK_CHOICE,
  PARKED_NOTICE_KEY,
  REVERT_COMMIT_LINE,
  ToolAccess,
  TRUST_DEFAULTS,
  YourMcpSource,
  yourMcpServerKey,
  AccountCardChoice,
  MCP_APPROVAL_DETAIL,
  ReviewCardDetail,
  reviewRounds,
  type AccountId,
  type Rigor,
  type WorkstreamId,
} from '@10db/contracts';
import {
  acquireLease,
  activeClaims,
  countLanes,
  deleteAppSetting,
  findDocument,
  getAccount,
  getAttachmentRevision,
  getProject,
  getTask,
  getWorkstream,
  getWorkstreamRow,
  insertBatch,
  insertInboxItem,
  insertKind,
  insertPrinciple,
  insertSource,
  laneTimesOf,
  listEventsAfter,
  listBoardColumns,
  listEvidence,
  listTasks,
  listInbox,
  listSessions,
  listSkipsForWorkstream,
  listTaskThread,
  listWorkstreams,
  patchAccount,
  replaceAccountModels,
  patchProject,
  patchTask,
  patchWorkstream,
  schema,
  seedAccount,
  setPlaybook,
  setAppSetting,
  setBatchNotice,
  setWorkstreamNotice,
  transitionBatch,
  transitionWorkstream,
  updateInboxItem,
  upsertTaskContext,
  listJudgeCalls,
} from '@10db/db';
import { readSkillBody } from '@10db/harness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_DONE_NUDGE,
  BACKGROUND_DONE_NUDGE_READ_ONLY,
  HANDOFF_NUDGE,
  HANDOFF_NUDGE_ACCOUNT,
  RESULT_NUDGE,
} from '../briefing';
import { createLauncher } from '../environment';
import { setProjectLiveSystems } from '../trust';
import { recoverOnStartup, systemProcesses } from '../recovery';
import { DEFAULT_RUNNER_LIMITS } from '../runner';
import { createGit, type Git } from '../git';
import { silentLogger } from '../log';
import { ManualClock } from '../clock';
import {
  createGateRunner,
  createGateSlots,
  limitGates,
  type GateRequest,
  type GateResult,
  type GateRunner,
  type GateSlots,
  type Hold,
} from '../verify';
import type {
  BaseUpdate,
  BaseUpdates,
  BeforeGateOptions,
  MigrationsBase,
  MigrationsBaseTake,
} from '../delivery';
import {
  allowedToolsFor,
  approveMcpServer,
  listNetworkHosts,
  setAppTrustSwitches,
  setLaneAutoMode,
  setProjectTrustOverrides,
} from '../permissions';
import { readYourMcpConfig } from '../session-setup';
import {
  createLaneSandbox,
  EMPTY_SETUP,
  SandboxedMcpServer,
  SandboxProfileError,
  SandboxTempDirError,
  type LaneProcessSetup,
  type LaneSandbox,
  type LaneSession,
  type LaneSessionInput,
} from '../sandbox';
import type {
  FakeScriptBook,
  JudgedCallRequest,
  SessionEvent,
  SessionHandle,
  LaneSessionSpec,
} from '../sessions';
import {
  createMemoryKeychain,
  FAKE_SRT,
  handoffArgs,
  homeOutsideTemp,
  isolatedGitEnv,
  SANDBOXED,
  tempDir,
  waitFor,
  type TempDir,
} from '../../test/fixtures';
import {
  createTestEngine,
  routeQuestionsAway,
  triageHeld,
  type TestEngine,
} from '../../test/engine';
import { bundleJson, inlineBodies, parseBundle } from '../../test/plan-bundle-fixture';
import { importBundle, planImportChanges } from '../plan-record';
import { failedRepoCheck } from '../../test/fixtures';
import { captureLogs } from '../../test/log-capture';
import { noticesPosted } from '../../test/notices-posted';

let engine: TestEngine;

/** A launcher whose project env is `base` less its billing switches. */
const launcherOver = (base: Record<string, string>) => ({
  launcher: createLauncher({ base, clientApp: 'test', keychain: createMemoryKeychain() }),
});
afterEach(async () => {
  await engine.close();
});

const write = (path: string, content = 'x') => ({
  do: 'tool' as const,
  toolName: 'Write',
  input: { file_path: path, content },
});
const commit = (opId: string, paths: string[]) => ({
  do: 'mcp' as const,
  tool: 'commit',
  args: { opId, paths, message: `Commit ${opId}` },
});
const turn = { do: 'turn_complete' as const };
const askShip = {
  do: 'tool' as const,
  toolName: 'AskUserQuestion',
  input: {
    questions: [
      {
        question: 'Ship it?',
        header: 'Ship',
        options: [
          { label: 'Yes', description: '' },
          { label: 'No', description: '' },
        ],
        multiSelect: false,
      },
    ],
  },
};

const curl = {
  do: 'tool' as const,
  toolName: 'Bash',
  input: { command: 'curl -s https://example.com' },
};
const shell = (command: string) => ({ do: 'tool' as const, toolName: 'Bash', input: { command } });

/**
 * A hold the test opens and closes, as the load guard and an update's drain do: it holds from the
 * start unless told otherwise. `asked` lists every wait on it, and `parked` those still waiting.
 */
function fakeHold(holdingAtFirst = true) {
  let holding = holdingAtFirst;
  const waiting = new Set<() => void>();
  const asked: (AbortSignal | undefined)[] = [];
  return {
    asked,
    parked: () => waiting.size,
    begin: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const open of [...waiting]) open();
    },
    hold: {
      holding: () => holding,
      untilClear: (signal?: AbortSignal) => {
        asked.push(signal);
        if (!holding) return Promise.resolve(true);
        return new Promise<boolean>((resolve) => {
          const open = (): void => {
            waiting.delete(open);
            resolve(true);
          };
          waiting.add(open);
          signal?.addEventListener('abort', () => {
            waiting.delete(open);
            resolve(false);
          });
        });
      },
    },
  };
}

/** Gates that began: a gate held back, or stopped before its command, records none. */
const gatesStarted = () =>
  listEventsAfter(engine.store.db, 0, 10_000).filter((e) => e.type === 'gate.started').length;

let current: Parameters<typeof getWorkstream>[1];
const ws0 = () => current;
const ws = (id: Parameters<typeof getWorkstream>[1]) => getWorkstream(engine.store.db, id);
const openCard = () => listInbox(engine.store.db, { states: ['OPEN'] })[0];
/** What a run skipped, oldest first, by the fields the builder is shown. */
const skipsOf = (id: Parameters<typeof getWorkstream>[1]) =>
  listSkipsForWorkstream(engine.store.db, id).map(({ toolName, summary, kind, source }) => ({
    toolName,
    summary,
    kind,
    source,
  }));
/** Whether the run ever waited on the builder. */
const everWaited = (id: Parameters<typeof getWorkstream>[1]) =>
  transitions(id).some((t) => t.endsWith('->WAITING_HUMAN'));
const transitions = (id: Parameters<typeof getWorkstream>[1]) =>
  listEventsAfter(engine.store.db, 0, 1000)
    .filter((e) => e.type === 'workstream.changed' && e.entityId === id)
    .map((e) =>
      [e.data['from'], e.data['to']].map((s) => (typeof s === 'string' ? s : '?')).join('->'),
    );

/** An account judged by 10db's rules floor and 10db's judge rather than auto mode: a ChatGPT plan. */
const RULES_FLOOR_ACCOUNT: Parameters<typeof createTestEngine>[3] = {
  account: { kind: 'codex_signin', label: 'ChatGPT plan' },
};

/** Confirms the ChatGPT sign-in a lane on `RULES_FLOOR_ACCOUNT` needs before it starts. */
function confirmRulesFloorIdentity(): void {
  engine.state.write((ctx) =>
    patchAccount(ctx, engine.project.accountId, { expectedIdentity: 'chatgpt@example.com · ws-1' }),
  );
}

describe('runner', () => {
  it('runs a one-commit task with no stored steps to DONE with gate evidence from the session environment, logs and records the gate, and blocks an out-of-claim write', async () => {
    const gateCommand = 'test -z "$TENDB_PROBE" && test "$GATE_MARK" = yes';
    const logs = captureLogs();
    const afterSession: string[] = [];
    process.env['TENDB_PROBE'] = 'leaked';
    try {
      engine = await createTestEngine(
        {
          Alpha: [
            [
              write('src/ui/nope.txt'),
              write('src/api/a.txt'),
              commit('op-alpha-001', ['src/api/a.txt']),
              turn,
            ],
          ],
        },
        { gateCommand },
        {
          ...launcherOver({ GATE_MARK: 'yes' }),
          logger: logs.logger,
          afterSession: (id) => {
            afterSession.push(id);
            return Promise.reject(new Error('watcher broke'));
          },
        },
      );
      const { task, workstream } = engine.addTask('Alpha');
      expect(ws(workstream.id).steps).toEqual([]);
      engine.launch(workstream.id);
      await engine.runner.idle();

      // The gate saw the session's environment, never the daemon process's, and the after-session
      // check ran once for the session and was survived although it threw.
      expect(afterSession).toEqual([workstream.id]);
      expect(ws(workstream.id).state).toBe('DONE');
      expect(getTask(engine.store.db, task.id).status).toBe('done');
      const [gate] = listEvidence(engine.store.db, workstream.id);
      expect(gate).toMatchObject({ kind: 'gate', exitCode: 0 });
      expect(gate?.commitShas).toHaveLength(1);
      expect(activeClaims(engine.store.db, workstream.id)).toEqual([]);
      expect(listInbox(engine.store.db, { states: ['OPEN'] })).toEqual([]);
      expect(
        engine.adapter.observations.find((o) => o.kind === 'denied_by_guard')?.detail['reason'],
      ).toContain('request_claim');

      // Each gate run logs its start and end, with its exit code, duration and log path.
      const gateLines = logs.lines().filter((line) => String(line['msg']).startsWith('gate '));
      expect(gateLines.map((line) => line['msg'])).toEqual(['gate started', 'gate finished']);
      const [started, finished] = gateLines;
      expect(started).toMatchObject({
        workstreamId: workstream.id,
        command: gateCommand,
        logPath: gate?.logPath,
      });
      expect(finished).toMatchObject({
        workstreamId: workstream.id,
        exitCode: 0,
        logPath: gate?.logPath,
        timedOut: false,
        aborted: false,
      });
      expect(typeof finished?.['durationMs']).toBe('number');

      // The gate's events and the lane time stored when the task finished.
      const gateEvents = listEventsAfter(engine.store.db, 0, 1000).filter(
        (e) => e.entityId === workstream.id && e.type.startsWith('gate.'),
      );
      expect(gateEvents.map((e) => [e.type, e.data['exitCode'] ?? null])).toEqual([
        ['gate.started', null],
        ['gate.finished', 0],
      ]);
      expect(laneTimesOf(engine.store.db, [task.id]).get(task.id)).toMatchObject({
        sessionsOnly: false,
      });
    } finally {
      delete process.env['TENDB_PROBE'];
    }
  });

  describe('a session that ends its turn while a command it started runs in the background', () => {
    const rehearsal = 'pnpm exec vitest run src/shape/rehearsal.test.ts';

    it('is not counted as a finished step: it is told when the command finishes and goes on to commit', async () => {
      engine = await createTestEngine({
        Alpha: [
          [
            write('src/api/a.txt'),
            { do: 'background', tasks: [rehearsal] },
            turn,
            // The command finishes: the session is woken by 10db, then commits what it meant to.
            { do: 'background', tasks: [] },
            { do: 'await_message', contains: BACKGROUND_DONE_NUDGE },
            commit('op-bg-001', ['src/api/a.txt']),
            turn,
          ],
        ],
      });
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await engine.runner.idle();

      expect(ws(workstream.id)).toMatchObject({ state: 'DONE' });
      expect(listSessions(engine.store.db, workstream.id).map((s) => s.exitReason)).toEqual([
        'step_done',
      ]);
      expect(engine.adapter.sent.map((m) => m.text)).toContain(BACKGROUND_DONE_NUDGE);
      expect(BACKGROUND_DONE_NUDGE).toContain('mcp__10db__commit');
      expect(engine.adapter.sent.map((m) => m.text)).not.toContain(BACKGROUND_DONE_NUDGE_READ_ONLY);
    });

    it('ends an implement step that committed everything as done, without waiting on the command', async () => {
      engine = await createTestEngine({
        Alpha: [
          [
            write('src/api/a.txt'),
            commit('op-bg-004', ['src/api/a.txt']),
            { do: 'background', tasks: ['pnpm dev'] },
            turn,
            { do: 'hang' },
          ],
        ],
      });
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await engine.runner.idle();

      expect(ws(workstream.id)).toMatchObject({ state: 'DONE' });
      expect(listSessions(engine.store.db, workstream.id).map((s) => s.exitReason)).toEqual([
        'step_done',
      ]);
      expect(engine.adapter.sent.map((m) => m.text)).not.toContain(BACKGROUND_DONE_NUDGE);
    });

    it('fails the step naming the command when it never finishes, instead of sending the step back for uncommitted changes', async () => {
      const logs = captureLogs();
      engine = await createTestEngine(
        {
          Alpha: [
            [
              write('src/api/a.txt'),
              { do: 'background', tasks: [rehearsal] },
              turn,
              { do: 'hang' },
            ],
          ],
        },
        {},
        { logger: logs.logger },
      );
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      // The turn has ended and the runner is waiting on the command.
      await waitFor(() =>
        logs.lines().some((line) => line['msg'] === 'step held open for background commands'),
      );
      expect(ws(workstream.id).state).toBe('RUNNING');

      engine.clock.advance(DEFAULT_RUNNER_LIMITS.backgroundMs);
      await engine.runner.idle();

      const failed = ws(workstream.id);
      expect(failed).toMatchObject({ state: 'FAILED', failureKind: 'session_failed' });
      expect(failed.failureReason).toContain(rehearsal);
      expect(failed.failureReason).toContain('still running');
      expect(failed.failureReason).not.toContain('uncommitted');
      // No retry was spent on it.
      expect(listSessions(engine.store.db, workstream.id)).toHaveLength(1);
    });

    it('does not fail a session that is working again, even with the command still running', async () => {
      engine = await createTestEngine({
        Alpha: [
          [
            write('src/api/a.txt'),
            { do: 'background', tasks: [rehearsal] },
            turn,
            { do: 'await_message', contains: 'go on' },
            { do: 'activity', summary: 'back at work' },
            { do: 'await_message', contains: 'finish' },
            { do: 'background', tasks: [] },
            commit('op-bg-003', ['src/api/a.txt']),
            turn,
          ],
        ],
      });
      const start = vi.spyOn(engine.adapter, 'open');
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await waitFor(() => listSessions(engine.store.db, workstream.id)[0]?.inputTokens === 1000);
      const session = start.mock.results[0]?.value as { send(text: string): void } | undefined;
      if (!session) throw new Error('no session started');
      session.send('go on');
      await waitFor(() =>
        listEventsAfter(engine.store.db, 0, 1000).some(
          (e) => e.type === 'session.activity' && e.data['summary'] === 'back at work',
        ),
      );

      engine.clock.advance(DEFAULT_RUNNER_LIMITS.backgroundMs + 1);
      session.send('finish');
      await engine.runner.idle();

      expect(ws(workstream.id).state).toBe('DONE');
    });
  });

  it('hands off at the threshold, nudges firmly near the limit, and continues in a fresh session that is not told a skipped call was denied', async () => {
    engine = await createTestEngine(
      {
        Alpha: [
          [
            // A skip is listed for the builder, not a denial: nobody answered it.
            shell('pnpm lint'),
            { do: 'context', percentage: 75 },
            { do: 'await_message', contains: 'write_handoff' },
            { do: 'context', percentage: 88 },
            { do: 'await_message', contains: 'almost full' },
            {
              do: 'mcp',
              tool: 'write_handoff',
              args: handoffArgs('op-handoff-1', 'Write the second file'),
            },
            turn,
          ],
          [write('src/api/b.txt'), commit('op-alpha-002', ['src/api/b.txt']), turn],
        ],
      },
      { allowedCommands: ['pnpm exec prettier'] },
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(ws(workstream.id).state).toBe('DONE');
    expect(listSessions(engine.store.db, workstream.id).map((s) => s.exitReason)).toEqual([
      'handoff',
      'step_done',
    ]);
    expect(engine.adapter.prompts[1]?.prompt).toContain('Next action: Write the second file');
    expect(engine.adapter.prompts[1]?.prompt).not.toContain('The builder denied');
    expect(skipsOf(workstream.id)).toMatchObject([
      { summary: 'pnpm lint', kind: 'default_mode_card' },
    ]);
    const states = listEventsAfter(engine.store.db, 0, 1000)
      .filter((e) => e.type === 'workstream.changed')
      .map((e) => e.data['to']);
    expect(states).toContain('HANDING_OFF');
  });

  it('checks a step with the pre-check in pull request delivery, never the gate or the changed-packages check, and sends a failed pre-check back as a fix with its output', async () => {
    const precheck = 'test -f src/api/fixed.txt || { echo PRECHECK-MISSING; exit 2; }';
    engine = await createTestEngine(
      {
        Alpha: [
          [turn],
          [write('src/api/fixed.txt'), commit('op-pre-fix-1', ['src/api/fixed.txt']), turn],
        ],
      },
      {
        delivery: 'pull_request',
        gateCommand: 'echo FULL-GATE-RAN; exit 3',
        changedCheckCommand: 'echo CHANGED-RAN; exit 4',
        precheckCommand: precheck,
      },
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({ state: 'QUEUED', nextAction: { kind: 'fix' } });

    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(engine.adapter.prompts[1]?.prompt).toContain('PRECHECK-MISSING');
    const checks = listEvidence(engine.store.db, workstream.id);
    expect(checks.map((check) => [check.kind, check.command, check.exitCode])).toEqual([
      ['gate', precheck, 2],
      ['gate', precheck, 0],
    ]);
  });

  it('keeps checking a step with the gate in local delivery, whatever the pre-check', async () => {
    engine = await createTestEngine(
      { Alpha: [[write('src/api/a.txt'), commit('op-alpha-pre-2', ['src/api/a.txt']), turn]] },
      { delivery: 'local', gateCommand: 'true', precheckCommand: 'exit 9' },
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(ws(workstream.id).state).toBe('DONE');
    const [check] = listEvidence(engine.store.db, workstream.id);
    expect(check).toMatchObject({ kind: 'gate', command: 'true', exitCode: 0 });
  });

  it('runs the full gate once after the last implement step of a Commit Directly task, before its review or Done, and a failing gate sends it back as a fix', async () => {
    const gate = 'test -f src/api/fixed.txt || { echo FULL-GATE-MISSING; exit 2; }';
    engine = await createTestEngine(
      {
        Alpha: [
          [write('src/api/a.txt'), commit('op-full-1', ['src/api/a.txt']), turn],
          [write('src/api/fixed.txt'), commit('op-full-2', ['src/api/fixed.txt']), turn],
          [
            {
              do: 'mcp' as const,
              tool: 'complete_step',
              args: { opId: 'op-full-3', summary: 'Looks right.', verdict: 'approve' },
            },
            turn,
          ],
        ],
      },
      { delivery: 'local', gateCommand: gate, changedCheckCommand: 'true' },
    );
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({ state: 'QUEUED', nextAction: { kind: 'fix' } });

    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({ state: 'QUEUED', stepIndex: 1 });
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(engine.adapter.prompts[1]?.prompt).toContain('FULL-GATE-MISSING');
    const checks = listEvidence(engine.store.db, workstream.id);
    expect(checks.map((check) => [check.command, check.exitCode])).toEqual([
      ['true', 0],
      [gate, 2],
      ['true', 0],
      [gate, 0],
    ]);
  });

  it("checks a step with the project's changed-packages command, not its gate command, and sends a failed check back as a fix with its output", async () => {
    const changed = 'test -f src/api/fixed.txt || { echo MISSING-CHANGED-FILE; exit 2; }';
    engine = await createTestEngine(
      {
        Alpha: [
          [turn],
          [write('src/api/fixed.txt'), commit('op-chg-fix-1', ['src/api/fixed.txt']), turn],
        ],
      },
      {
        delivery: 'pull_request',
        gateCommand: 'echo FULL-GATE-RAN; exit 3',
        changedCheckCommand: changed,
      },
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({ state: 'QUEUED', nextAction: { kind: 'fix' } });

    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(engine.adapter.prompts[1]?.prompt).toContain('MISSING-CHANGED-FILE');
    const checks = listEvidence(engine.store.db, workstream.id);
    expect(checks.map((check) => [check.kind, check.command, check.exitCode])).toEqual([
      ['gate', changed, 2],
      ['gate', changed, 0],
    ]);
  });

  describe('a check that fails only in tests', () => {
    const testLog = [
      ' FAIL  daemon  src/a.test.ts > suite > slow one',
      'Error: Test timed out in 30000ms.',
    ].join('\n');
    const gateResult = (exitCode: number, tail: string): GateResult => ({
      exitCode,
      durationMs: 1,
      tail,
      logPath: '/dev/null',
      timedOut: false,
      aborted: false,
      blockedHosts: [],
    });

    /**
     * An engine whose check fails with what the repository's real check leaves when its tests print
     * `log`, and whose rerun answers as `rerunExit` says.
     */
    async function flakyEngine(rerunExit: number, log = testLog): Promise<{ commands: string[] }> {
      const check = failedRepoCheck(log);
      const commands: string[] = [];
      engine = await createTestEngine(
        { Alpha: [[turn]], Beta: [[turn]] },
        { gateCommand: 'make check-changed' },
        {
          gate: {
            run: (request: GateRequest) => {
              commands.push(request.command);
              if (request.command === 'make check-changed')
                return Promise.resolve(gateResult(check.exitCode, check.tail));
              return Promise.resolve(gateResult(rerunExit, rerunExit === 0 ? 'ok' : 'still red'));
            },
          },
        },
      );
      cpSync(join(check.checkout, '.gate'), join(engine.repoPath, '.gate'), { recursive: true });
      return { commands };
    }

    it('goes on when the failing test files pass on one rerun: no fix session, no attempt used, the flake on the evidence, one Icebox task that a second task’s flake of the same file joins', async () => {
      const { commands } = await flakyEngine(0);
      const { workstream, task } = engine.addTask('Alpha');
      const beta = engine.addTask('Beta', ['ui']);
      engine.launch(workstream.id);
      await engine.runner.idle();

      expect(commands).toEqual(['make check-changed', 'pnpm exec vitest run src/a.test.ts']);
      expect(ws(workstream.id)).toMatchObject({ state: 'DONE', attempt: 0 });
      const evidence = listEvidence(engine.store.db, workstream.id);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({ exitCode: 0 });
      expect(evidence[0]?.summary).toContain('src/a.test.ts > suite > slow one');
      expect(evidence[0]?.summary).toContain('Test timed out in 30000ms');
      const filed = listTasks(engine.store.db, engine.project.id).filter(
        (t) => t.title === 'Fix flaky test file src/a.test.ts',
      );
      expect(filed).toHaveLength(1);
      expect(filed[0]?.description).toContain('suite > slow one');
      expect(filed[0]?.description).toContain(task.title);
      expect(listInbox(engine.store.db, { states: ['OPEN'] })).toEqual([]);

      // A second task's flake of the same file goes to the open Icebox task instead of another.
      engine.launch(beta.workstream.id);
      await engine.runner.idle();
      expect(ws(beta.workstream.id)).toMatchObject({ state: 'DONE', attempt: 0 });
      const flaky = listTasks(engine.store.db, engine.project.id).filter((t) =>
        t.title.startsWith('Fix flaky'),
      );
      expect(flaky).toHaveLength(1);
      expect(flaky[0]?.description).toContain('Flaked again');
      expect(flaky[0]?.description).toContain('Beta');
    });

    it('is a real failure when the rerun fails too: the attempt is counted, a fix is queued, and no task is filed', async () => {
      const { commands } = await flakyEngine(1);
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await engine.runner.idle();

      expect(commands).toEqual(['make check-changed', 'pnpm exec vitest run src/a.test.ts']);
      expect(ws(workstream.id)).toMatchObject({ state: 'QUEUED', attempt: 1 });
      expect(ws(workstream.id).nextAction.kind).toBe('fix');
      expect(
        listTasks(engine.store.db, engine.project.id).filter((t) =>
          t.title.startsWith('Fix flaky'),
        ),
      ).toEqual([]);
    });
  });

  it('fails as gate_failed once the gate fails past the retry limit, and a retry clears the kind', async () => {
    engine = await createTestEngine(
      { Alpha: [[turn], [turn]] },
      { gateCommand: 'echo STILL-FAILING; exit 2' },
    );
    const { workstream } = engine.addTask('Alpha');
    engine.state.write((ctx) => {
      patchWorkstream(ctx, workstream.id, null, { attempt: DEFAULT_RUNNER_LIMITS.maxFixAttempts });
    });
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({ state: 'FAILED', failureKind: 'gate_failed' });
    engine.retry(workstream.id);
    expect(ws(workstream.id)).toMatchObject({
      state: 'QUEUED',
      failureReason: null,
      failureKind: null,
    });
  });

  it("names the file and recommends Allow on a blocked gate's card for a project added before readings", async () => {
    const blocked: GateResult = {
      exitCode: 101,
      durationMs: 1,
      tail: 'error: failed to download',
      logPath: '/dev/null',
      timedOut: false,
      aborted: false,
      blockedHosts: ['index.crates.io'],
    };
    engine = await createTestEngine(
      { Alpha: [[turn]] },
      { gateCommand: 'cargo test' },
      { gate: { run: () => Promise.resolve(blocked) } },
    );
    // The default branch, as origin holds it, commits a Cargo.lock; no reading was ever kept.
    const repoGit = (...args: string[]) =>
      execFileSync('git', ['-C', engine.repoPath, ...args], {
        env: isolatedGitEnv(),
        stdio: 'pipe',
      });
    mkdirSync(join(engine.repoPath, 'apps/desktop/src-tauri'), { recursive: true });
    writeFileSync(
      join(engine.repoPath, 'apps/desktop/src-tauri/Cargo.lock'),
      'source = "registry+https://github.com/rust-lang/crates.io-index"\n',
    );
    repoGit('add', 'apps');
    repoGit('commit', '-q', '-m', 'lock');
    repoGit('update-ref', 'refs/remotes/origin/main', 'HEAD');
    engine.state.write((ctx) => {
      deleteAppSetting(ctx, `network-hosts-found:${engine.project.id}`);
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();

    const cards = listInbox(engine.store.db, { states: ['OPEN'] }).filter(
      (c) => c.title === 'Allow network access to index.crates.io?',
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.body).toContain(
      "The project's apps/desktop/src-tauri/Cargo.lock needs index.crates.io",
    );
    expect(cards[0]?.recommendation).toBe('Allow for the project');
    expect(listNetworkHosts(engine.state.db, engine.project.id)).toEqual([]);
  });

  it("raises one card for a host the sandbox blocked from a failed gate, naming the host and the command, and keeps it open when the lane whose gate raised it is cancelled while another lane's gate needs the host", async () => {
    const blocked: GateResult = {
      exitCode: 101,
      durationMs: 1,
      tail: 'error: failed to download\n10db: The gate was blocked from reaching index.crates.io',
      logPath: '/dev/null',
      timedOut: false,
      aborted: false,
      blockedHosts: ['index.crates.io'],
    };
    engine = await createTestEngine(
      { Alpha: [[turn]], Beta: [[turn]] },
      { gateCommand: 'cargo test' },
      { gate: { run: () => Promise.resolve(blocked) } },
    );
    const alpha = engine.addTask('Alpha');
    const beta = engine.addTask('Beta', ['ui']);
    engine.launch(alpha.workstream.id);
    await engine.runner.idle();
    const hostCards = () =>
      listInbox(engine.store.db, { states: ['OPEN'] }).filter(
        (c) => c.title === 'Allow network access to index.crates.io?',
      );
    const cards = hostCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.body).toContain('cargo test');
    expect(cards[0]?.options.map((o) => o.label)).toContain('Allow for the project');
    // The answer allows the host for the whole project, so the card is the project's, not the lane's.
    expect(cards[0]?.targets).toEqual([]);
    const [gate] = listEvidence(engine.store.db, alpha.workstream.id);
    expect(gate?.summary).toContain('The gate was blocked from reaching index.crates.io');
    engine.launch(beta.workstream.id);
    await engine.runner.idle();
    expect(hostCards()).toHaveLength(1);

    await engine.runner.cancel(alpha.workstream.id);

    expect(ws(alpha.workstream.id).state).toBe('CANCELLED');
    expect(ws(beta.workstream.id).state).toBe('QUEUED');
    expect(hostCards()).toHaveLength(1);
  });

  it('parks a long wait, frees the lane, and resumes with the answer in a new session', async () => {
    engine = await createTestEngine({
      Alpha: [
        [askShip, turn],
        [write('src/api/a.txt'), commit('op-park-0001', ['src/api/a.txt']), turn],
      ],
    });
    routeQuestionsAway(engine);
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const card = await waitFor(openCard);
    expect(ws(workstream.id).state).toBe('WAITING_HUMAN');

    engine.clock.advance(10 * 60_000);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({
      state: 'WAITING_HUMAN',
      currentSessionId: null,
      nextAction: { kind: 'answer', inboxId: card.id },
    });

    engine.inbox.answer(card.id, { choice: 'Yes' });
    expect(ws(workstream.id).state).toBe('QUEUED');
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(ws(workstream.id).state).toBe('DONE');
    const [first, second] = listSessions(engine.store.db, workstream.id);
    expect(engine.adapter.prompts[1]).toMatchObject({ resume: first?.providerSessionId });
    expect(engine.adapter.prompts[1]?.prompt).toContain('Answer: Yes');
    expect(second?.exitReason).toBe('step_done');
    // Every session's prompt carries the pack, a resumed conversation's included.
    expect(
      listEventsAfter(engine.store.db, 0, 1000)
        .filter((e) => e.type === 'context.packed')
        .map((e) => e.data['reason']),
    ).toEqual(['start', 'resume']);
  });

  it('pins the branch at the first session, so a later session never commits where HEAD moved', async () => {
    engine = await createTestEngine({
      Alpha: [
        [askShip, turn],
        [write('src/api/a.txt'), commit('op-pin-0001', ['src/api/a.txt']), turn],
      ],
    });
    routeQuestionsAway(engine);
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const card = await waitFor(openCard);
    engine.clock.advance(10 * 60_000);
    await engine.runner.idle();
    expect(getWorkstreamRow(engine.store.db, workstream.id).branch).toBe('main');
    // While the work waits, something points HEAD at another branch.
    execFileSync('git', ['-C', engine.repoPath, 'switch', '-q', '-c', 'elsewhere'], {
      env: isolatedGitEnv(),
    });
    const elsewhere = execFileSync('git', ['-C', engine.repoPath, 'rev-parse', 'elsewhere'], {
      env: isolatedGitEnv(),
    })
      .toString()
      .trim();
    engine.inbox.answer(card.id, { choice: 'Yes' });
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(getWorkstreamRow(engine.store.db, workstream.id).branch).toBe('main');
    expect(
      execFileSync('git', ['-C', engine.repoPath, 'rev-parse', 'elsewhere'], {
        env: isolatedGitEnv(),
      })
        .toString()
        .trim(),
    ).toBe(elsewhere);
    expect(
      engine.adapter.observations.some((o) =>
        JSON.stringify(o).includes("the lane's branch is main"),
      ),
    ).toBe(true);
  });

  describe('Park the task, answered on a lane question', () => {
    const askHuman = {
      do: 'mcp' as const,
      tool: 'ask_human',
      args: {
        opId: 'op-park-ask-01',
        category: 'engineering',
        question: 'Can you capture the live GitHub checks?',
        options: [
          { label: 'Defer', description: 'make no change and end this step' },
          { label: 'Retry', description: '' },
        ],
      },
    };
    // The implement step would go on to write and commit, and a review step follows it.
    const parkedBook = (ask: FakeScriptBook[string][number][number]): FakeScriptBook => ({
      Alpha: [
        [ask, write('src/api/a.txt'), commit('op-park-live-1', ['src/api/a.txt']), turn],
        [turn],
      ],
    });

    const expectParked = async (
      id: WorkstreamId,
      taskId: Parameters<typeof getTask>[1],
      card: { id: string },
    ) => {
      await waitFor(() => ws(id).state === 'CANCELLED');
      await engine.runner.idle();
      const run = ws(id);
      // Stopped where it was: the step never moved on to review and nothing was committed.
      expect(run).toMatchObject({ state: 'CANCELLED', stepIndex: 0, currentSessionId: null });
      expect(transitions(id).filter((t) => t.endsWith('->QUEUED'))).toEqual([]);
      expect(transitions(id).filter((t) => t.endsWith('->VERIFYING'))).toEqual([]);
      expect(engine.adapter.prompts).toHaveLength(1);
      expect(listSessions(engine.store.db, id)).toHaveLength(1);
      expect(engine.runner.isRunning(id)).toBe(false);
      expect(run.notice?.key).toBe(PARKED_NOTICE_KEY);
      expect(listInbox(engine.store.db, {}).find((c) => c.id === card.id)?.state).toBe('RESOLVED');
      expect(listInbox(engine.store.db, { states: ['OPEN'] })).toEqual([]);
      const icebox = listBoardColumns(engine.store.db, engine.project.id).find(
        (c) => c.name === 'Icebox',
      );
      expect(icebox).toBeDefined();
      expect(getTask(engine.store.db, taskId).boardColumnId).toBe(icebox?.id);
      expect(
        engine.adapter.observations.some((o) => JSON.stringify(o).includes(PARK_TASK_CHOICE)),
      ).toBe(false);
    };

    it('cancels a run already parked in WAITING_HUMAN with no session, and never requeues it', async () => {
      engine = await createTestEngine(parkedBook(askHuman));
      routeQuestionsAway(engine);
      const { task, workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
      engine.launch(workstream.id);
      const card = await waitFor(openCard);
      engine.clock.advance(10 * 60_000);
      await engine.runner.idle();
      expect(ws(workstream.id)).toMatchObject({
        state: 'WAITING_HUMAN',
        currentSessionId: null,
        nextAction: { kind: 'answer', inboxId: card.id },
      });

      engine.inbox.answer(card.id, { choice: PARK_TASK_CHOICE });
      await expectParked(workstream.id, task.id, card);
    });
  });

  it('delivers a live answer to the same session, going STARTING -> RUNNING -> WAITING_HUMAN -> RUNNING', async () => {
    engine = await createTestEngine(
      {
        Alpha: [[askShip, write('src/api/a.txt'), commit('op-live-0001', ['src/api/a.txt']), turn]],
      },
      {},
      {},
      triageHeld(),
    );
    routeQuestionsAway(engine);
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    engine.inbox.answer((await waitFor(openCard)).id, { choice: 'Yes' });
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({ state: 'DONE', recoveryAttempts: 0 });
    expect(transitions(workstream.id).slice(0, 4)).toEqual([
      'QUEUED->STARTING',
      'STARTING->RUNNING',
      'RUNNING->WAITING_HUMAN',
      'WAITING_HUMAN->RUNNING',
    ]);
    expect(listSessions(engine.store.db, workstream.id)).toHaveLength(1);
    expect(engine.adapter.observations).toContainEqual(
      expect.objectContaining({
        kind: 'tool_allowed',
        detail: { toolName: 'AskUserQuestion', answers: { 'Ship it?': 'Yes' } },
      }),
    );
  });

  it('keeps an answer that arrives while the parked session is still stopping', async () => {
    engine = await createTestEngine({
      Alpha: [
        [askShip, turn],
        [write('src/api/a.txt'), commit('op-grace-0001', ['src/api/a.txt']), turn],
      ],
    });
    routeQuestionsAway(engine);
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const card = await waitFor(openCard);
    engine.clock.advance(10 * 60_000);
    engine.inbox.answer(card.id, { choice: 'Yes' });
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({
      state: 'QUEUED',
      recoveryAttempts: 0,
      nextAction: { kind: 'answer', inboxId: card.id },
    });

    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(engine.adapter.prompts[1]?.prompt).toContain('Answer: Yes');
  });

  // T4: an unattended lane never waits on a card; the call is skipped, recorded, and the lane goes on.
  it('skips a command no rule allows in a lane, with or without a storable rule or a project allow-list, never parking, and runs a listed allowed one without a card', async () => {
    const unstorable = {
      do: 'tool' as const,
      toolName: 'Bash',
      input: { command: 'echo $(date)' },
    };
    engine = await createTestEngine(
      {
        Alpha: [
          [
            curl,
            unstorable,
            shell('pnpm lint'),
            shell('pnpm exec prettier --write src/api/a.txt && git status --short && git diff'),
            write('src/api/a.txt'),
            commit('op-perm-0001', ['src/api/a.txt']),
            turn,
          ],
        ],
      },
      { allowedCommands: ['pnpm exec prettier'] },
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    // The first thing to settle is the run finishing or a card asking; a card would park it, so it fails here.
    const outcome = await waitFor(() => ws(workstream.id).state === 'DONE' || openCard());
    expect(outcome).toBe(true);
    await engine.runner.idle();

    expect(ws(workstream.id).state).toBe('DONE');
    expect(everWaited(workstream.id)).toBe(false);
    expect(listInbox(engine.store.db, { states: ['OPEN'] })).toEqual([]);
    expect(listInbox(engine.store.db, {}).filter((i) => i.kind === 'permission')).toEqual([]);
    // Each skip keeps its kind and summary for the builder; the listed command is the only call allowed.
    expect(skipsOf(workstream.id)).toEqual([
      {
        toolName: 'Bash',
        summary: 'curl -s https://example.com',
        kind: 'default_mode_card',
        source: 'broker',
      },
      expect.objectContaining({ toolName: 'Bash', summary: 'echo $(date)' }),
      { toolName: 'Bash', summary: 'pnpm lint', kind: 'default_mode_card', source: 'broker' },
    ]);
    const denied = engine.adapter.observations.filter((o) => o.kind === 'tool_denied');
    expect(denied).toHaveLength(3);
    for (const observation of denied)
      expect(String(observation.detail['message'])).toMatch(/^Skipped: /);
    expect(
      engine.adapter.observations.filter(
        (o) => o.kind === 'tool_allowed' && o.detail['toolName'] === 'Bash',
      ),
    ).toHaveLength(1);
  });

  it('leaves a denied read of the worktrees folder outside the copy out of the prompt and the compaction message', async () => {
    const worktreeRoot = '/worktrees/67a1ebdc';
    const outside = `${worktreeRoot}/10db-b83cc7/scripts/gate.sh`;
    engine = await createTestEngine(
      {
        Alpha: [[{ do: 'compact' }, { do: 'await_message', contains: 'context pack' }, turn]],
      },
      {},
      { worktreeRoot },
    );
    const { task, workstream } = engine.addTask('Alpha');
    const denied = (toolName: string, summary: string): void => {
      engine.state.write((ctx) => {
        const item = insertInboxItem(ctx, {
          projectId: task.projectId,
          kind: 'permission',
          title: `Allow ${toolName}?`,
          body: summary,
          options: [{ label: 'deny', description: '' }],
          recommendation: null,
          category: 'product',
          urgency: 'normal',
          detail: { toolName, summary },
          foldKey: null,
          targets: [{ workstreamId: workstream.id, sessionId: null }],
        });
        updateInboxItem(ctx, item.id, { state: 'ANSWERED', answer: { choice: 'deny' } });
      });
    };
    denied('Read', outside);
    denied('Read', '/etc/hosts');
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(ws(workstream.id).state).toBe('DONE');
    const told = [
      engine.adapter.prompts[0]?.prompt ?? '',
      ...engine.adapter.sent.map((message) => message.text),
    ];
    expect(told).toHaveLength(2);
    for (const text of told) {
      expect(text).toContain('Read: /etc/hosts');
      expect(text).not.toContain(worktreeRoot);
    }
  });

  // A resumed session carries its whole conversation, so it hands off where that conversation would:
  // at handoffPct, or past its briefing's baseline plus the margin when the conversation began from a
  // handoff. Only a briefing earns the margin, so a fresh session with no handoff gets none.
  describe('hands off at the threshold of the conversation a session belongs to', () => {
    const ctx = (percentage: number) => ({ do: 'context' as const, percentage });
    const crash = { do: 'crash' as const, message: 'boom' };
    const handOff = (opId: string) => [
      { do: 'await_message' as const, contains: 'write_handoff' },
      { do: 'mcp' as const, tool: 'write_handoff', args: handoffArgs(opId, 'Keep going') },
      turn,
    ];
    const finish = [write('src/api/a.txt'), commit('op-conv-099', ['src/api/a.txt']), turn];
    const relaunch = async (id: Parameters<typeof ws>[0]) => {
      await engine.runner.idle();
      expect(ws(id).state).toBe('QUEUED');
      engine.launch(id);
    };
    const handoffReasons = (id: Parameters<typeof ws>[0]) =>
      listEventsAfter(engine.store.db, 0, 1000)
        .filter(
          (e) =>
            e.type === 'workstream.changed' && e.entityId === id && e.data['to'] === 'HANDING_OFF',
        )
        .map((e) => e.data['reason']);
    type Id = Parameters<typeof ws>[0];
    interface Row {
      readonly name: string;
      readonly sessions: Parameters<typeof createTestEngine>[0]['Alpha'];
      readonly drive: (id: Id) => Promise<void>;
      readonly gateCommand?: string;
      readonly reasons: readonly string[];
      /** The session that must resume the one before it, or null when the last working session is fresh. */
      readonly resumedSession: number | null;
      /** Each session's stored briefing baseline, which a restart's resume reads back. */
      readonly baselines: readonly (number | null)[];
    }
    const answerParked = async (id: Id) => {
      const card = await waitFor(openCard);
      engine.clock.advance(10 * 60_000);
      await engine.runner.idle();
      engine.inbox.answer(card.id, { choice: 'Yes' });
      engine.launch(id);
    };

    const ROWS: readonly Row[] = [
      {
        name: 'a first session resumed after a crash hands off at handoffPct',
        sessions: [[ctx(10), crash], [ctx(14), ...handOff('op-conv-001')], finish],
        drive: relaunch,
        reasons: ['context at 14%'],
        resumedSession: 1,
        baselines: [null, null, null],
      },
      {
        name: 'a first session resumed with an answer hands off at handoffPct',
        sessions: [[ctx(10), askShip, turn], [ctx(14), ...handOff('op-conv-001')], finish],
        drive: answerParked,
        reasons: ['context at 14%'],
        resumedSession: 1,
        baselines: [null, null, null],
      },
      {
        // The continuation starts at 30%, so its line is 35%; resumed at 33%, it keeps that line.
        name: 'a continuation resumed after a crash keeps its briefing margin',
        sessions: [
          [ctx(20), ...handOff('op-conv-001')],
          [ctx(30), ctx(33), crash],
          [ctx(33), ctx(34), ctx(36), ...handOff('op-conv-002')],
          finish,
        ],
        drive: relaunch,
        reasons: ['context at 20%', 'context at 36%'],
        resumedSession: 2,
        baselines: [null, 30, 30, null],
      },
      {
        // The continuation dies before its first reading, so the resumed session's first reading is
        // the briefing's baseline: 30% + 5 = 35%.
        name: 'a continuation that crashed before its first reading keeps its margin when resumed',
        sessions: [
          [ctx(20), ...handOff('op-conv-001')],
          [crash],
          [ctx(30), ctx(33), ctx(36), ...handOff('op-conv-002')],
          finish,
        ],
        drive: relaunch,
        reasons: ['context at 20%', 'context at 36%'],
        resumedSession: 2,
        baselines: [null, null, 30, null],
      },
      {
        // Resumed after a crash, the continuation parks on a question and is resumed again with the answer.
        name: 'a resume of a resumed continuation keeps its margin',
        sessions: [
          [ctx(20), ...handOff('op-conv-001')],
          [ctx(30), crash],
          [ctx(31), askShip, turn],
          [ctx(33), ctx(36), ...handOff('op-conv-002')],
          finish,
        ],
        drive: async (id) => {
          await relaunch(id);
          await answerParked(id);
        },
        reasons: ['context at 20%', 'context at 36%'],
        resumedSession: 3,
        baselines: [null, 30, 30, 30, null],
      },
      {
        // A fix prompt carries the gate output, not the handoff, so its bare 10% earns no margin.
        name: 'a fix session after a handoff gets no margin',
        sessions: [
          [ctx(20), ...handOff('op-conv-001')],
          [turn],
          [ctx(10), ctx(13), ...handOff('op-conv-002')],
          finish,
        ],
        drive: relaunch,
        gateCommand: 'test -f src/api/a.txt',
        reasons: ['context at 20%', 'context at 13%'],
        resumedSession: null,
        baselines: [null, null, null, null],
      },
      {
        // Resume fails too, and with no handoff written the third session starts bare at 10%.
        name: 'a fresh session with no handoff to brief it gets no margin',
        sessions: [
          [ctx(10), crash],
          [crash],
          [ctx(10), ctx(13), ...handOff('op-conv-001')],
          finish,
        ],
        drive: async (id) => {
          await relaunch(id);
          await relaunch(id);
        },
        reasons: ['context at 13%'],
        resumedSession: null,
        baselines: [null, null, null, null],
      },
    ];

    it('hands off at handoffPct, or past the briefing baseline plus the margin only for a conversation that began from a handoff', async () => {
      // Each row scripts its own sessions, so each boots its own lane.
      for (const [i, row] of ROWS.entries()) {
        if (i > 0) await engine.close();
        const { name, sessions, drive, gateCommand, reasons, resumedSession, baselines } = row;
        engine = await createTestEngine(
          { Alpha: sessions },
          { handoffPct: 12, nudgePct: 90, ...(gateCommand ? { gateCommand } : {}) },
        );
        routeQuestionsAway(engine);
        const { workstream } = engine.addTask('Alpha');
        engine.launch(workstream.id);
        await drive(workstream.id);

        await waitFor(() => handoffReasons(workstream.id).length === reasons.length, 3_000);
        await engine.runner.idle();
        expect.soft(ws(workstream.id).state, name).toBe('DONE');
        expect.soft(handoffReasons(workstream.id), name).toEqual(reasons);
        const rows = listSessions(engine.store.db, workstream.id);
        expect
          .soft(
            rows.map((r) => r.briefingBaselinePct),
            name,
          )
          .toEqual(baselines);
        if (resumedSession === null) {
          expect.soft(engine.adapter.prompts.at(-2)?.resume, name).toBeNull();
        } else {
          expect.soft(engine.adapter.prompts[resumedSession], name).toMatchObject({
            resume: rows[resumedSession - 1]?.providerSessionId,
          });
        }
      }
    });
  });

  it('treats a session environment that cannot be built as a crash, before any session row exists', async () => {
    engine = await createTestEngine(
      { Alpha: [[turn]] },
      {},
      {
        launcher: {
          projectEnv: () => ({}),
          session: () => {
            throw new Error('The launch could not be built.');
          },
          probe: () => {
            throw new Error('The launch could not be built.');
          },
        },
      },
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(listSessions(engine.store.db, workstream.id)).toEqual([]);
    expect(ws(workstream.id)).toMatchObject({ state: 'QUEUED', recoveryAttempts: 1 });
  });

  describe("the repo's MCP servers", () => {
    const BOOK = { Alpha: [[turn]], Beta: [[turn]], Gamma: [[turn]] };
    /** Every credential a session env can hold. None may reach a repo server unless approved. */
    const SECRET_ENV = {
      PATH: '/usr/bin:/bin',
      HOME: '/h',
      DOCS_TOKEN: 'tok-1',
      ANTHROPIC_API_KEY: 'sk-ant-x',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-x',
      AWS_SECRET_ACCESS_KEY: 'aws-x',
    };
    const MANTINE = { command: 'npx', args: ['-y', '@mantine/mcp-server@9.7.2'] };
    const DOCS = {
      type: 'http',
      url: 'https://docs.example/mcp',
      headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
    };

    const writeMcp = (servers: Record<string, unknown>) => {
      writeFileSync(join(engine.repoPath, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
    };
    const approvalCards = () =>
      listInbox(engine.store.db, { states: ['OPEN'] }).filter(
        (i) => i.detail?.[MCP_APPROVAL_DETAIL] !== undefined,
      );
    const answerAll = (choice: 'approve' | 'deny') => {
      for (const card of approvalCards()) engine.inbox.answer(card.id, { choice });
    };
    /** Runs one session of a new task and returns the spec the adapter was started with. */
    async function runTask(title: keyof typeof BOOK) {
      const start = vi.spyOn(engine.adapter, 'open');
      const { workstream } = engine.addTask(title);
      engine.launch(workstream.id);
      await engine.runner.idle();
      const spec = start.mock.calls.at(-1)?.[0];
      start.mockRestore();
      if (!spec) throw new Error(`${title} never started a session`);
      return spec;
    }

    it("asks once for a server it has not seen, and starts the session without it, and asks again when the server's config changes, running without it meanwhile", async () => {
      engine = await createTestEngine(BOOK);
      writeMcp({ mantine: MANTINE });
      const spec = await runTask('Alpha');
      expect(spec.projectMcpServers).toEqual({});
      expect(spec.prompt).toContain("mantine (waiting for the builder's approval)");
      const cards = approvalCards();
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({
        kind: 'flag',
        targets: [],
        options: [{ label: 'approve' }, { label: 'deny' }],
      });
      expect(cards[0]?.detail?.[MCP_APPROVAL_DETAIL]).toMatchObject({
        name: 'mantine',
        transport: 'stdio',
        command: 'npx',
        args: MANTINE.args,
        variables: [],
      });
      await runTask('Beta');
      expect(approvalCards()).toHaveLength(1);

      answerAll('approve');
      writeMcp({ mantine: { ...MANTINE, args: ['-y', '@mantine/mcp-server@9.8.0'] } });
      const changed = await runTask('Gamma');
      expect(changed.projectMcpServers).toEqual({});
      expect(approvalCards().map((c) => c.detail?.[MCP_APPROVAL_DETAIL])).toEqual([
        expect.objectContaining({ args: ['-y', '@mantine/mcp-server@9.8.0'] }),
      ]);
    });

    it('passes an approved remote server with the variables the builder approved, and no stdio server without a sandbox', async () => {
      engine = await createTestEngine(BOOK, {}, launcherOver(SECRET_ENV));
      writeMcp({ docs: DOCS, mantine: MANTINE });
      await runTask('Alpha');
      const reviews = approvalCards().map((c) => c.detail?.[MCP_APPROVAL_DETAIL]);
      expect(reviews).toHaveLength(2);
      expect(reviews).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'docs',
            variables: ['DOCS_TOKEN'],
            sensitive: ['DOCS_TOKEN'],
          }),
          expect.objectContaining({ name: 'mantine', variables: [] }),
        ]),
      );
      answerAll('approve');
      const spec = await runTask('Beta');
      // A stdio server runs only under the lane sandbox, which this engine doesn't have.
      expect(spec.projectMcpServers).toEqual({
        docs: {
          type: 'http',
          url: 'https://docs.example/mcp',
          headers: { Authorization: 'Bearer tok-1' },
        },
      });
      for (const secret of ['sk-ant-x', 'oauth-x', 'aws-x'])
        expect(JSON.stringify(spec.projectMcpServers)).not.toContain(secret);
      expect(spec.prompt).toContain('mantine (it runs only in the lane sandbox, which is off)');
    });

    it('leaves a denied server out, says so in the prompt, and does not ask again', async () => {
      engine = await createTestEngine(BOOK);
      writeMcp({ mantine: MANTINE });
      await runTask('Alpha');
      answerAll('deny');
      const spec = await runTask('Beta');
      expect(spec.projectMcpServers).toEqual({});
      expect(spec.prompt).toContain('mantine (denied by the builder)');
      expect(approvalCards()).toEqual([]);
    });

    it('flags an approved server whose variable is not set, naming it, and starts without that server', async () => {
      engine = await createTestEngine(
        BOOK,
        {},
        launcherOver({ PATH: '/usr/bin:/bin', HOME: '/h' }),
      );
      writeMcp({ docs: DOCS, mantine: MANTINE });
      await runTask('Alpha');
      answerAll('approve');
      const spec = await runTask('Beta');
      expect(Object.keys(spec.projectMcpServers)).toEqual([]);
      const flags = listInbox(engine.store.db, { states: ['OPEN'] }).filter((i) =>
        i.title.includes('"docs"'),
      );
      expect(flags.map((f) => f.body)).toEqual([
        expect.stringContaining(
          'server "docs" (headers.Authorization) references ${DOCS_TOKEN}, which is not set',
        ),
      ]);
    });

    it('drops a repo server that takes the 10db name, with a warning card, and never asks to approve it', async () => {
      engine = await createTestEngine(BOOK);
      writeMcp({ '10db': { command: 'impostor' }, '10db__x': { command: 'impostor' } });
      const spec = await runTask('Alpha');
      expect(spec.projectMcpServers).toEqual({});
      expect(approvalCards()).toEqual([]);
      const flags = listInbox(engine.store.db, { states: ['OPEN'] }).filter(
        (i) => i.kind === 'flag',
      );
      expect(flags.map((f) => f.body)).toEqual([
        expect.stringContaining('declares a server named "10db"'),
      ]);
    });

    it('fails the session start on a .mcp.json it cannot parse, with one folded flag', async () => {
      engine = await createTestEngine({ Alpha: [[turn]] });
      writeFileSync(join(engine.repoPath, '.mcp.json'), '{"mcpServers": {');
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await engine.runner.idle();
      engine.launch(workstream.id);
      await engine.runner.idle();
      expect(listSessions(engine.store.db, workstream.id)).toEqual([]);
      expect(ws(workstream.id)).toMatchObject({ state: 'QUEUED', recoveryAttempts: 2 });
      const flags = listInbox(engine.store.db, { states: ['OPEN'] }).filter(
        (i) => i.kind === 'flag',
      );
      expect(flags).toHaveLength(1);
      expect(flags[0]?.body).toContain('is not valid JSON');
    });

    const writeHosts = (content: string) => {
      mkdirSync(join(engine.repoPath, '.10db'), { recursive: true });
      writeFileSync(join(engine.repoPath, '.10db', 'mcp-hosts.json'), content);
    };

    it('asks again when the hosts file names a host for an approved server, with the hosts on the card', async () => {
      engine = await createTestEngine(BOOK);
      writeMcp({ mantine: MANTINE });
      await runTask('Alpha');
      answerAll('approve');
      writeHosts(JSON.stringify({ servers: { mantine: { hosts: ['registry.npmjs.org'] } } }));
      await runTask('Beta');
      const cards = approvalCards();
      expect(cards).toHaveLength(1);
      expect(cards[0]?.detail?.[MCP_APPROVAL_DETAIL]).toMatchObject({
        name: 'mantine',
        hosts: ['registry.npmjs.org'],
      });
      expect(cards[0]?.body).toContain('reaches only registry.npmjs.org, never localhost');
    });

    it('fails the session start on a hosts file it cannot parse, with one folded flag naming it', async () => {
      engine = await createTestEngine({ Alpha: [[turn]] });
      writeMcp({ mantine: MANTINE });
      writeHosts(JSON.stringify({ servers: { mantine: { hosts: ['127.0.0.1'] } } }));
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await engine.runner.idle();
      engine.launch(workstream.id);
      await engine.runner.idle();
      expect(listSessions(engine.store.db, workstream.id)).toEqual([]);
      const flags = listInbox(engine.store.db, { states: ['OPEN'] }).filter(
        (i) => i.kind === 'flag',
      );
      expect(flags).toHaveLength(1);
      expect(flags[0]?.title).toBe("The repo's MCP config stops sessions from starting");
      expect(flags[0]?.body).toContain('mcp-hosts.json is not a valid MCP hosts file');
    });

    it('warns about hosts named for a server the repo does not run over stdio, and opens none', async () => {
      engine = await createTestEngine(BOOK);
      writeMcp({ docs: DOCS });
      writeHosts(JSON.stringify({ servers: { docs: { hosts: ['docs.example'] } } }));
      await runTask('Alpha');
      expect(approvalCards()[0]?.detail?.[MCP_APPROVAL_DETAIL]).toMatchObject({ hosts: [] });
      const warnings = listInbox(engine.store.db, { states: ['OPEN'] }).filter(
        (i) => i.title === "Check the repo's MCP config",
      );
      expect(warnings.map((w) => w.body)).toEqual([
        expect.stringContaining('names hosts for "docs"'),
      ]);
    });
  });

  // T4: an unattended lane never waits on a card, however many calls ask at once.
  it('answers two overlapping calls in a lane at once, each its own skip', async () => {
    engine = await createTestEngine({ Alpha: [[{ do: 'hang' }]] });
    const start = vi.spyOn(engine.adapter, 'open');
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await waitFor(() => ws(workstream.id).state === 'RUNNING');
    const spec = start.mock.calls[0]?.[0];
    if (!spec) throw new Error('no session started');
    // Claude Code asks for parallel tool calls at once, so two permission waits can overlap.
    const ask = (command: string, toolUseId: string) =>
      spec.canUseTool({
        toolName: 'Bash',
        input: { command },
        toolUseId,
        escalated: false,
        signal: new AbortController().signal,
      });
    const [first, second] = await Promise.all([
      ask('curl -s https://one.example', 'toolu_1'),
      ask('curl -s https://two.example', 'toolu_2'),
    ]);
    for (const decision of [first, second])
      expect(decision.behavior === 'deny' && decision.message.startsWith('Skipped: ')).toBe(true);
    expect(skipsOf(workstream.id).map((s) => s.summary)).toEqual([
      'curl -s https://one.example',
      'curl -s https://two.example',
    ]);
    expect(listInbox(engine.store.db, { states: ['OPEN'] })).toEqual([]);
    expect(ws(workstream.id).state).toBe('RUNNING');
    await engine.runner.cancel(workstream.id);
  });

  // T4: an unattended lane never waits on a card, so a restart finds no answer to hand on.
  it('leaves no answer or one-time permission behind when a lane skips a call', async () => {
    engine = await createTestEngine({ Alpha: [[curl, { do: 'hang' }]] });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await waitFor(() => skipsOf(workstream.id)[0]);
    // Recovery after a restart reads this action: with no handoff yet it is a fresh start.
    expect(ws(workstream.id)).toMatchObject({ state: 'RUNNING', nextAction: { kind: 'start' } });
    await engine.runner.stopAll('shutdown');
  });

  describe('lifecycle edges', () => {
    /** Wraps every handle the fake adapter returns; the wrapper sees each call the runner makes. */
    const interceptStart = (wrap: (handle: SessionHandle) => SessionHandle) => {
      const real = engine.adapter.open.bind(engine.adapter);
      return vi.spyOn(engine.adapter, 'open').mockImplementation((spec) => wrap(real(spec)));
    };
    const doneScript = [write('src/api/a.txt'), commit('op-edge-0001', ['src/api/a.txt']), turn];

    it('stops the session process when a newer lease fences the runner off', async () => {
      engine = await createTestEngine({
        Alpha: [
          [
            { do: 'await_message', contains: 'go' },
            { do: 'activity', summary: 'later' },
            { do: 'hang' },
          ],
        ],
      });
      let inner: SessionHandle | undefined;
      let stopCalls = 0;
      interceptStart((h) => {
        inner = h;
        return {
          ...h,
          stop: () => {
            stopCalls += 1;
            return h.stop();
          },
        };
      });
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await waitFor(
        () => listSessions(engine.store.db, workstream.id)[0]?.providerSessionId ?? undefined,
      );
      engine.state.write((ctx) => {
        acquireLease(
          ctx,
          workstream.id,
          'other-daemon',
          new Date(Date.now() + 60_000).toISOString(),
        );
      });
      inner?.send('go');
      await engine.runner.idle();
      expect(stopCalls).toBeGreaterThan(0);
    });

    it.each([['a cancel', 'CANCELLED', () => engine.runner.cancel(ws0())]])(
      'settles %s that lands while the finished turn is stopping',
      async (_name, expected, act) => {
        engine = await createTestEngine({ Alpha: [doneScript] });
        let first = true;
        interceptStart((h) => ({
          ...h,
          stop: () => {
            if (first) {
              first = false;
              void act();
            }
            return h.stop();
          },
        }));
        const { workstream } = engine.addTask('Alpha');
        current = workstream.id;
        engine.launch(workstream.id);
        await engine.runner.idle();
        expect(ws(workstream.id).state).toBe(expected);
        expect(
          listInbox(engine.store.db, { states: ['OPEN'] }).filter((i) => i.kind === 'flag'),
        ).toEqual([]);
      },
    );

    it('parks normally when the turn completes after the wait timer fired, while the card is open or when it was answered during the stop', async () => {
      // Each row answers at its own moment in its own lane.
      for (const [i, [name, answerEarly, expected]] of (
        [
          ['while the card is open', false, 'WAITING_HUMAN'],
          ['when the card was answered during the stop', true, 'QUEUED'],
        ] as const
      ).entries()) {
        if (i > 0) await engine.close();
        engine = await createTestEngine({ Alpha: [[askShip, turn]] }, {}, {}, triageHeld());
        routeQuestionsAway(engine);
        let first = true;
        // The timer's stop is swallowed so the script runs on to turn_complete and a normal end, as a real adapter can.
        interceptStart((h) => ({
          ...h,
          stop: () => {
            if (!first) return h.stop();
            first = false;
            const card = openCard();
            if (answerEarly && card) engine.inbox.answer(card.id, { choice: 'Yes' });
            return Promise.resolve();
          },
        }));
        const { workstream } = engine.addTask('Alpha');
        engine.launch(workstream.id);
        const card = await waitFor(openCard);
        engine.clock.advance(10 * 60_000);
        await engine.runner.idle();

        expect.soft(ws(workstream.id), name).toMatchObject({
          state: expected,
          currentSessionId: null,
          recoveryAttempts: 0,
          nextAction: { kind: 'answer', inboxId: card.id },
        });
        expect
          .soft(listSessions(engine.store.db, workstream.id)[0]?.exitReason, name)
          .toBe('parked');
        if (!answerEarly) {
          engine.inbox.answer(card.id, { choice: 'Yes' });
          expect.soft(ws(workstream.id).state, name).toBe('QUEUED');
        }
      }
    });

    it.each([['a shutdown', () => engine.runner.stopAll('shutdown')]])(
      'keeps an answer that lands while %s is still stopping a waiting session',
      async (_name, act) => {
        engine = await createTestEngine({
          Alpha: [
            [askShip, { do: 'hang' }],
            [write('src/api/a.txt'), commit('op-slow-0001', ['src/api/a.txt']), turn],
          ],
        });
        routeQuestionsAway(engine);
        let release: () => void = () => undefined;
        const released = new Promise<void>((r) => {
          release = r;
        });
        // A real session can take a while to exit; this one exits only when the test says so.
        interceptStart((h) => ({
          ...h,
          stop: async () => {
            await released;
            await h.stop();
          },
        }));
        const { workstream } = engine.addTask('Alpha');
        engine.launch(workstream.id);
        const card = await waitFor(openCard);
        expect(ws(workstream.id).state).toBe('WAITING_HUMAN');

        const stopping = act();
        engine.inbox.answer(card.id, { choice: 'Yes' });
        release();
        await stopping;
        await engine.runner.idle();
        expect(ws(workstream.id)).toMatchObject({
          state: 'QUEUED',
          currentSessionId: null,
          nextAction: { kind: 'answer', inboxId: card.id },
        });

        engine.launch(workstream.id);
        await engine.runner.idle();
        expect(ws(workstream.id).state).toBe('DONE');
        expect(engine.adapter.prompts[1]?.prompt).toContain('Answer: Yes');
      },
    );

    it('ends the session and frees it for a parked answer when the loop fails while waiting', async () => {
      engine = await createTestEngine({ Alpha: [[askShip, { do: 'hang' }]] });
      routeQuestionsAway(engine);
      let fail: (error: Error) => void = () => undefined;
      const failed = new Promise<never>((_resolve, reject) => {
        fail = reject;
      });
      failed.catch(() => undefined);
      // Stands in for a database or IO error thrown inside the event loop.
      interceptStart((h) => ({
        ...h,
        events: (async function* () {
          const inner = h.events[Symbol.asyncIterator]();
          for (;;) {
            const next = await Promise.race([inner.next(), failed]);
            if (next.done) return;
            yield next.value;
          }
        })(),
      }));
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      const card = await waitFor(openCard);
      fail(new Error('disk I/O error'));
      await engine.runner.idle();

      expect(ws(workstream.id)).toMatchObject({
        state: 'WAITING_HUMAN',
        currentSessionId: null,
        nextAction: { kind: 'answer', inboxId: card.id },
      });
      expect(listSessions(engine.store.db, workstream.id)[0]?.endedAt).not.toBeNull();
      engine.inbox.answer(card.id, { choice: 'Yes' });
      expect(ws(workstream.id)).toMatchObject({
        state: 'QUEUED',
        nextAction: { kind: 'answer', inboxId: card.id },
      });
    });

    /** Makes the second session the adapter starts end without ever reporting `started`. */
    const secondSessionNeverStarts = () => {
      let calls = 0;
      interceptStart((h) => {
        calls += 1;
        if (calls !== 2) return h;
        return {
          ...h,
          events: (async function* () {
            for await (const event of h.events) if (event.type !== 'started') yield event;
          })(),
        };
      });
    };
    const crash = { do: 'crash' as const, message: 'boom before started' };

    // An allow_once permission no longer has a lane path: T4's unattended lane skips the call.
    it.each([['a question answer', askShip, 'Yes', [...doneScript], 'Answer: Yes']])(
      'carries %s into the next session when the answered session crashes before it starts',
      async (_name, ask, choice, finalScript, promptText) => {
        engine = await createTestEngine({ Alpha: [[ask, turn], [crash], finalScript] });
        routeQuestionsAway(engine);
        secondSessionNeverStarts();
        const { workstream } = engine.addTask('Alpha');
        engine.launch(workstream.id);
        const card = await waitFor(openCard);
        engine.clock.advance(10 * 60_000);
        await engine.runner.idle();
        engine.inbox.answer(card.id, { choice });
        engine.launch(workstream.id);
        await engine.runner.idle();
        expect(ws(workstream.id)).toMatchObject({
          state: 'QUEUED',
          recoveryAttempts: 1,
          nextAction: { kind: 'answer', inboxId: card.id },
        });

        engine.launch(workstream.id);
        await engine.runner.idle();
        expect(ws(workstream.id).state).toBe('DONE');
        expect(engine.adapter.prompts[2]?.prompt).toContain(promptText);
        expect(listInbox(engine.store.db, { states: ['OPEN'] })).toEqual([]);
        expect(
          engine.adapter.observations.filter(
            (o) => o.kind === 'tool_allowed' && o.detail['toolName'] === 'Bash',
          ),
        ).toHaveLength(choice === 'allow_once' ? 1 : 0);
      },
    );

    it('sends a failed gate back as a fix with the output, and carries it into the next session when the fix session crashes before it starts', async () => {
      engine = await createTestEngine(
        {
          Alpha: [
            [turn],
            [crash],
            [write('src/api/fixed.txt'), commit('op-fixc-0001', ['src/api/fixed.txt']), turn],
          ],
        },
        { gateCommand: 'test -f src/api/fixed.txt || { echo MISSING-FIXED-FILE; exit 2; }' },
      );
      secondSessionNeverStarts();
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await engine.runner.idle();
      expect(ws(workstream.id)).toMatchObject({
        state: 'QUEUED',
        nextAction: { kind: 'fix' },
        attempt: 1,
      });
      engine.launch(workstream.id);
      await engine.runner.idle();
      expect(ws(workstream.id)).toMatchObject({
        state: 'QUEUED',
        recoveryAttempts: 1,
        nextAction: { kind: 'fix' },
      });
      expect(engine.adapter.prompts[1]?.prompt).toContain('MISSING-FIXED-FILE');

      engine.launch(workstream.id);
      await engine.runner.idle();
      expect(ws(workstream.id).state).toBe('DONE');
      expect(engine.adapter.prompts[2]?.prompt).toContain('MISSING-FIXED-FILE');
    });
  });

  it('cancels a lane before its session starts, while it runs and while its gate runs, killing the gate and releasing the claims each time', async () => {
    engine = await createTestEngine(
      {
        Alpha: [[write('src/api/a.txt'), commit('op-edge-0001', ['src/api/a.txt']), turn]],
        Beta: [[{ do: 'activity', summary: 'working' }, { do: 'hang' }]],
        Gamma: [[turn]],
      },
      { gateCommand: 'sleep 30' },
    );

    // A cancel that arrives before the session starts.
    const before = engine.addTask('Alpha').workstream;
    engine.launch(before.id);
    await engine.runner.cancel(before.id);
    expect(ws(before.id).state).toBe('CANCELLED');
    expect(engine.adapter.prompts).toEqual([]);
    expect(activeClaims(engine.store.db, before.id)).toEqual([]);

    // A cancel while the session runs.
    const running = engine.addTask('Beta').workstream;
    engine.launch(running.id);
    await waitFor(
      () => listSessions(engine.store.db, running.id)[0]?.providerSessionId ?? undefined,
    );
    await engine.runner.cancel(running.id);
    expect(ws(running.id).state).toBe('CANCELLED');
    expect(activeClaims(engine.store.db, running.id)).toEqual([]);

    // A cancel while the gate runs kills it.
    const verifying = engine.addTask('Gamma').workstream;
    engine.launch(verifying.id);
    await waitFor(() => ws(verifying.id).state === 'VERIFYING');
    const started = Date.now();
    await engine.runner.cancel(verifying.id);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(ws(verifying.id).state).toBe('CANCELLED');
    expect(listEvidence(engine.store.db, verifying.id)).toEqual([]);
  });

  describe('while a first launch waits for its before picture', () => {
    it('starts no session until the wait ends, and then on the account the project moved to', async () => {
      const wait = Promise.withResolvers<undefined>();
      const asked: string[] = [];
      engine = await createTestEngine(
        { Alpha: [[turn], [turn]] },
        {},
        {
          awaitBeforePicture: (task) => {
            asked.push(task.id);
            return wait.promise;
          },
        },
      );
      const { task, workstream } = engine.addTask('Alpha');
      const first = engine.project.accountId;
      engine.launch(workstream.id);
      await waitFor(() => asked.length > 0);
      expect(asked).toEqual([task.id]);
      expect(listSessions(engine.store.db, workstream.id)).toEqual([]);
      const other = seedAccount(engine.store, {
        kind: 'claude_subscription',
        label: 'Second plan',
      });
      engine.state.write((ctx) => {
        patchAccount(ctx, other.id, { expectedIdentity: 'second@example.com' });
        patchProject(ctx, engine.project.id, { accountId: other.id });
      });
      wait.resolve(undefined);
      await engine.runner.idle();
      if (engine.adapter.prompts.length === 0) {
        engine.launch(workstream.id);
        await engine.runner.idle();
      }
      expect(engine.adapter.prompts.map((p) => p.accountId)).not.toContain(first);
      expect(engine.adapter.prompts[0]?.accountId).toBe(other.id);
    });
  });

  describe('when the hold comes on after a lane went past it', () => {
    it('starts no session while the Mac is overloaded or after waiting for its turn to start, gives the turn back, says the lane is parked only meanwhile, then runs it as usual', async () => {
      const fake = fakeHold(false);
      engine = await createTestEngine({ Alpha: [[turn]], Beta: [[turn]] }, {}, { hold: fake.hold });

      // The hold is on when the lane launches.
      fake.begin();
      const overloaded = engine.addTask('Alpha').workstream;
      expect(engine.runner.isParked(overloaded.id)).toBe(false);
      engine.launch(overloaded.id);
      await waitFor(() => fake.asked.length > 0);
      await waitFor(() => fake.parked() === 1);
      expect(engine.runner.isParked(overloaded.id)).toBe(true);
      expect(listSessions(engine.store.db, overloaded.id)).toEqual([]);
      expect(engine.adapter.prompts).toHaveLength(0);
      fake.release();
      await engine.runner.idle();
      expect(engine.runner.isParked(overloaded.id)).toBe(false);
      expect(ws(overloaded.id).state).toBe('DONE');
      expect(listSessions(engine.store.db, overloaded.id)).toHaveLength(1);

      // The hold comes on while the lane waits for its turn to start.
      const accountId = engine.project.accountId;
      const anotherStart = await engine.startGate.acquire(accountId);
      const { workstream } = engine.addTask('Beta');
      engine.launch(workstream.id);
      await waitFor(() => engine.startGate.waiting(accountId) === 1);
      fake.begin();
      anotherStart();
      await waitFor(() => fake.parked() === 1);
      expect(listSessions(engine.store.db, workstream.id)).toEqual([]);
      expect(engine.startGate.waiting(accountId)).toBe(0);
      fake.release();
      await engine.runner.idle();
      expect(ws(workstream.id).state).toBe('DONE');
      expect(listSessions(engine.store.db, workstream.id)).toHaveLength(1);
    });

    /** A task whose lane takes one of the given gate slots once its session ends. */
    async function laneBehindGate(hold: Hold, slots: GateSlots) {
      const gate = limitGates(createGateRunner({ sandbox: null, logger: silentLogger }), {
        slots,
        clock: new ManualClock(),
        logger: silentLogger,
      });
      engine = await createTestEngine({ Alpha: [[turn]] }, {}, { hold, gate });
      return engine.addTask('Alpha').workstream;
    }

    it('starts no gate after waiting for a slot, and keeps no slot while it is held', async () => {
      const fake = fakeHold(false);
      const slots = createGateSlots(1);
      const workstream = await laneBehindGate(fake.hold, slots);
      const anotherGate = await slots.acquire();
      engine.launch(workstream.id);
      await waitFor(() => slots.waiting === 1);
      fake.begin();
      anotherGate?.release();
      await waitFor(() => fake.parked() === 1);
      expect(slots.busy).toBe(0);
      expect(gatesStarted()).toBe(0);
      expect(ws(workstream.id).state).toBe('VERIFYING');
      fake.release();
      await engine.runner.idle();
      expect(gatesStarted()).toBe(1);
      expect(ws(workstream.id).state).toBe('DONE');
    });

    it('leaves a lane held at its gate verifying at shutdown, for recovery to run the gate', async () => {
      const fake = fakeHold(false);
      const slots = createGateSlots(1);
      const workstream = await laneBehindGate(fake.hold, slots);
      const anotherGate = await slots.acquire();
      engine.launch(workstream.id);
      await waitFor(() => slots.waiting === 1);
      fake.begin();
      anotherGate?.release();
      await waitFor(() => fake.parked() === 1);
      await engine.runner.stopAll('shutdown');
      expect(ws(workstream.id)).toMatchObject({
        state: 'VERIFYING',
        nextAction: { kind: 'verify' },
      });
      expect(listEvidence(engine.store.db, workstream.id)).toEqual([]);
    });
  });

  it('resets the crash count once a session makes progress, retries crashes as resume, then fresh, fails after the limit with a flag, and hands the builder’s retry note to the next session', async () => {
    const crash = { do: 'crash' as const, message: 'boom' };
    engine = await createTestEngine({
      Alpha: [[crash], [crash], [crash], [crash], [turn]],
      Beta: [[crash], [write('src/api/a.txt'), commit('op-reset-0001', ['src/api/a.txt']), turn]],
    });
    const progress = engine.addTask('Beta').workstream;
    engine.launch(progress.id);
    await engine.runner.idle();
    expect(ws(progress.id).recoveryAttempts).toBe(1);
    engine.launch(progress.id);
    await engine.runner.idle();
    expect(ws(progress.id)).toMatchObject({ state: 'DONE', recoveryAttempts: 0 });

    const { workstream } = engine.addTask('Alpha');
    const kinds: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      engine.launch(workstream.id);
      await engine.runner.idle();
      kinds.push(
        ws(workstream.id).state === 'QUEUED'
          ? ws(workstream.id).nextAction.kind
          : ws(workstream.id).state,
      );
    }
    expect(kinds).toEqual(['resume', 'start', 'resume', 'FAILED']);
    expect(ws(workstream.id).failureKind).toBe('session_failed');
    expect(listInbox(engine.store.db, { states: ['OPEN'] }).map((i) => i.kind)).toEqual(['flag']);
    engine.retry(workstream.id, 'The fixture server needs port 4100.');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(engine.adapter.prompts.at(-1)?.prompt).toContain(
      'The builder sent the work back: The fixture server needs port 4100.',
    );
  });

  it('briefs a session with the policy in scope, logs emergency compaction as a deviation and re-sends the context pack, and records the pack at start and after compaction', async () => {
    engine = await createTestEngine({
      Alpha: [
        [
          { do: 'compact' },
          { do: 'await_message', contains: '- [testing.no-sleeps] Never sleep in tests' },
          turn,
        ],
      ],
    });
    engine.state.write((ctx) =>
      insertPrinciple(ctx, {
        target: { scope: 'project', projectId: engine.project.id },
        statement: 'Never sleep in tests',
        kind: 'policy',
        topicKey: 'testing.no-sleeps',
        status: 'confirmed',
        sourceId: insertSource(ctx, 'builder', {}),
        sourceQuote: null,
        speaker: 'me',
        confirmedBy: 'me',
      }),
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(engine.store.db.select().from(schema.deviations).all()).toHaveLength(1);
    expect(
      engine.adapter.sent.map((m) => m.text).filter((t) => t.includes('context pack')),
    ).toHaveLength(1);
    expect(engine.adapter.prompts[0]?.prompt).toContain(
      '- [testing.no-sleeps] Never sleep in tests',
    );
    const packed = listEventsAfter(engine.store.db, 0, 1000).filter(
      (e) => e.type === 'context.packed',
    );
    expect(packed.map((e) => e.data['reason'])).toEqual(['start', 'compaction']);
    expect(packed[0]?.data).toMatchObject({
      workstreamId: workstream.id,
      budget: 1500,
      dropped: { policies: 0, heuristics: 0, decisions: 0 },
    });
    expect(packed[1]?.data).toMatchObject({
      budget: 1500,
      principles: packed[0]?.data['principles'],
    });
  });
});

describe('accounts', () => {
  it('pauses the account and sends no prompt when the identity differs, then resumes after Resume or confirms the identity', async () => {
    engine = await createTestEngine({ Alpha: [[turn]] });
    engine.adapter.seen = () => ({ email: 'someone-else@example.com' });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(engine.adapter.prompts).toEqual([]);
    expect(ws(workstream.id)).toMatchObject({
      state: 'PAUSED_LIMIT',
      nextAction: { kind: 'start' },
    });
    expect(engine.accounts.isPaused(engine.project.accountId)).toBe(true);
    const card = listInbox(engine.store.db, { states: ['OPEN'] })[0];
    expect(card?.body).toContain('someone-else@example.com');
    expect(transitions(workstream.id).filter((t) => t.endsWith('->FAILED'))).toEqual([]);

    engine.adapter.seen = () => ({});
    if (!card) throw new Error('no refusal card');
    engine.inbox.answer(card.id, { choice: AccountCardChoice.Resume });
    expect(ws(workstream.id).state).toBe('QUEUED');

    // A different identity can also be confirmed from the refusal card: that resumes the account
    // and re-queues the lane the same way, and the account expects the new identity from then on.
    engine.adapter.seen = () => ({ email: 'someone-else@example.com' });
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(engine.accounts.isPaused(engine.project.accountId)).toBe(true);
    const confirm = listInbox(engine.store.db, { states: ['OPEN'] })[0];
    if (!confirm) throw new Error('no refusal card');
    expect(confirm.options.map((o) => o.label)).toContain('Confirm');
    engine.inbox.answer(confirm.id, { choice: AccountCardChoice.Confirm });
    expect(getAccount(engine.store.db, engine.project.accountId).expectedIdentity).toBe(
      'someone-else@example.com',
    );
    expect(engine.accounts.isPaused(engine.project.accountId)).toBe(false);
    expect(ws(workstream.id).state).toBe('QUEUED');
  });

  it('refuses an API-key account whose Keychain secret changed, before any session row', async () => {
    engine = await createTestEngine(
      { Alpha: [[turn]] },
      {},
      {},
      {
        account: { kind: 'anthropic_api_key', label: 'Client key' },
        secret: 'sk-ant-api03-original-key',
      },
    );
    engine.keychain.write(`account:${engine.project.accountId}`, 'sk-ant-api03-someone-elses');
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(listSessions(engine.store.db, workstream.id)).toEqual([]);
    expect(ws(workstream.id).state).toBe('PAUSED_LIMIT');
    const cards = listInbox(engine.store.db, { states: ['OPEN'] });
    expect(cards.map((c) => c.title)).toEqual(['Client key: sessions refused']);
    expect(JSON.stringify(cards)).not.toContain('sk-ant');
  });

  it("gives the gate the project env, never the account's key", async () => {
    engine = await createTestEngine(
      { Alpha: [[write('src/api/a.txt'), commit('op-key-0001', ['src/api/a.txt']), turn]] },
      { gateCommand: 'test -z "$ANTHROPIC_API_KEY"' },
      {},
      {
        account: { kind: 'anthropic_api_key', label: 'Client key' },
        secret: 'sk-ant-api03-gate-must-not-see',
      },
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
  });
});

const moveTo = (accountId: AccountId) =>
  engine.state.write((ctx) => patchProject(ctx, engine.project.id, { accountId }));
/** What the scheduler does once the new account isn't paused. */
const requeue = (id: Parameters<typeof getWorkstream>[1]) =>
  engine.state.write((ctx) => transitionWorkstream(ctx, id, { to: 'QUEUED', fence: null }));
/** Every spec the fake adapter is started with, in order. */
const recordSpecs = (): LaneSessionSpec[] => {
  const specs: LaneSessionSpec[] = [];
  engine.adapter.seen = (spec) => {
    specs.push(spec);
    return {};
  };
  return specs;
};

describe('moving accounts', () => {
  it("briefs for the account a lane moved to, session by session, with a task's kinds' skills named for Claude and inlined for Codex", async () => {
    engine = await createTestEngine({
      Alpha: [
        [
          {
            do: 'mcp',
            tool: 'write_handoff',
            args: handoffArgs('op-brief-0000', 'Write the second file'),
          },
          { do: 'rate_limit', status: 'rejected', resetsInSeconds: 600 },
        ],
        [write('src/api/b.txt'), commit('op-brief-0001', ['src/api/b.txt']), turn],
      ],
    });
    engine.state.write((ctx) =>
      insertKind(ctx, { key: 'craft', label: 'Craft', skills: ['brainstorming'] }),
    );
    const { workstream } = engine.addTask('Alpha', ['api'], [], {
      flow: 'quick',
      kinds: ['craft'],
    });
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('PAUSED_LIMIT');

    const chatgpt = seedAccount(engine.store, { kind: 'codex_signin', label: 'ChatGPT plan' });
    engine.state.write((ctx) =>
      patchAccount(ctx, chatgpt.id, { expectedIdentity: 'chatgpt@example.com' }),
    );
    moveTo(chatgpt.id);
    requeue(workstream.id);
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');

    const [claude, codex] = engine.adapter.prompts.map((p) => p.prompt);
    expect(claude).toContain('Change files with the Edit or Write tool');
    expect(claude).not.toContain('apply_patch');
    expect(codex).toContain('Change files with apply_patch');
    expect(codex).toContain('In this session, the Edit or Write tool means apply_patch.');
    // The implementer's skills are in the briefing itself, as a Codex lane loads no plugin.
    expect(codex).toContain(readSkillBody('test-first') ?? 'missing');
    expect(claude).not.toContain(readSkillBody('test-first') ?? 'missing');
    // The project's own provider is not what the briefing follows.
    expect(getProject(engine.store.db, engine.project.id).provider).toBe(engine.project.provider);
    // The implementer's own skills stay, and the kind's come after them.
    const kindSkill = readSkillBody('brainstorming') ?? 'missing';
    expect(claude).toContain('Skills to use: test-first, handoff, brainstorming.');
    expect(claude).not.toContain(kindSkill);
    expect(codex).toContain(kindSkill);
    // A small change by a Light task adds no review step.
    expect(ws(workstream.id).steps.map((s) => s.role)).toEqual(['implement']);
  });
});

describe('usage thresholds', () => {
  it('asks a lane on the account to hand off once, in the account words, and runs its next session on the fallback', async () => {
    const nearLimit = (utilization: number) => ({
      do: 'rate_limit' as const,
      status: 'allowed_warning' as const,
      resetsInSeconds: 3600,
      utilization,
      limitType: 'five_hour',
    });
    engine = await createTestEngine({
      Alpha: [
        [
          nearLimit(0.96),
          { do: 'await_message', contains: 'near its usage limit' },
          nearLimit(0.97),
          {
            do: 'mcp',
            tool: 'write_handoff',
            args: handoffArgs('op-usage-0001', 'Write the second file'),
          },
          turn,
        ],
        [write('src/api/b.txt'), commit('op-usage-0002', ['src/api/b.txt']), turn],
      ],
    });
    const fallback = seedAccount(engine.store, {
      kind: 'claude_subscription',
      label: 'Second plan',
    });
    engine.state.write((ctx) =>
      patchAccount(ctx, fallback.id, { expectedIdentity: 'second@example.com' }),
    );
    engine.state.write((ctx) =>
      patchProject(ctx, engine.project.id, { fallbackAccountId: fallback.id }),
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(transitions(workstream.id).filter((t) => t === 'RUNNING->HANDING_OFF')).toHaveLength(1);
    const sent = engine.adapter.sent.map((s) => s.text);
    expect(sent.filter((text) => text === HANDOFF_NUDGE_ACCOUNT)).toHaveLength(1);
    expect(sent).not.toContain(HANDOFF_NUDGE);
    expect(listSessions(engine.store.db, workstream.id).map((s) => s.accountId)).toEqual([
      engine.project.accountId,
      fallback.id,
    ]);
    expect(engine.adapter.prompts[1]?.prompt).toContain('Next action: Write the second file');
    expect(engine.usageReports.map((r) => r.report.utilization)).toEqual([0.96, 0.97]);
  });
});

describe('flows', () => {
  const approve = (opId: string) => ({
    do: 'mcp' as const,
    tool: 'complete_step',
    args: { opId, summary: 'Looks right.', verdict: 'approve' },
  });
  const reject = (opId: string, notes = '1. The empty state has no test.') => ({
    do: 'mcp' as const,
    tool: 'complete_step',
    args: { opId, summary: notes, verdict: 'reject' },
  });
  const implement = (opId: string) => [
    write('src/api/a.txt', opId),
    commit(opId, ['src/api/a.txt']),
    turn,
  ];
  const step = (id: Parameters<typeof ws>[0], i: number) => ws(id).steps[i];
  const until = async (
    id: Parameters<typeof ws>[0],
    done: (state: string) => boolean,
    max = 10,
  ) => {
    for (let i = 0; i < max && !done(ws(id).state); i += 1) {
      engine.launch(id);
      await engine.runner.idle();
    }
  };

  it('runs implement then review to DONE when the reviewer approves, ending the review as done though a command it started still runs in the background', async () => {
    engine = await createTestEngine({
      Alpha: [
        implement('op-flow-0001'),
        [approve('op-flow-0002'), { do: 'background', tasks: ['pnpm dev'] }, turn, { do: 'hang' }],
      ],
    });
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({
      state: 'QUEUED',
      stepIndex: 1,
      // Standard's review needs at least 40, which Sonnet at high effort meets.
      model: 'claude-sonnet-5-5',
      effort: 'high',
    });
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(ws(workstream.id).steps.map((s) => s.status)).toEqual(['done', 'done']);
    expect(engine.adapter.prompts[1]?.prompt).toContain('Your step: 2 of 2, review, as Reviewer.');
    expect(
      listEvidence(engine.store.db, workstream.id).filter((e) => e.kind === 'gate'),
    ).toHaveLength(1);
    expect(listSessions(engine.store.db, workstream.id).map((s) => s.exitReason)).toEqual([
      'step_done',
      'step_done',
    ]);
  });

  describe('a send-back is fixed by the session that wrote the code, or a fresh one', () => {
    const script = [
      implement('op-fixby-0011'),
      [reject('op-fixby-0012'), turn],
      implement('op-fixby-0013'),
      [approve('op-fixby-0014'), turn],
    ];

    it('resumes the build session on its own model, with no escalation, when the row says resumed', async () => {
      engine = await createTestEngine({ Alpha: script });
      const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
      await until(workstream.id, (s) => s === 'DONE' || s === 'FAILED');
      expect(ws(workstream.id).state).toBe('DONE');
      const sessions = listSessions(engine.store.db, workstream.id);
      const build = sessions[0];
      expect(sessions).toHaveLength(4);
      expect(engine.adapter.prompts[2]?.resume).toBe(build?.providerSessionId);
      expect(sessions[2]?.model).toBe(build?.model);
      expect(sessions[2]?.effort).toBe(build?.effort);
      expect(step(workstream.id, 0)).toMatchObject({
        model: build?.model,
        attempts: 1,
        providerSessionId: build?.providerSessionId,
      });
      expect(engine.adapter.prompts[2]?.prompt).toContain('Its findings are below.');
      expect(engine.adapter.prompts[2]?.prompt).toContain('1. The empty state has no test.');
      expect(step(workstream.id, 0)?.reason).toContain('fixing in its own session');
      expect(step(workstream.id, 0)?.reason).not.toContain('escalated');
    });

    it('starts a fresh session one profile up, once, when the resumed fix crashes', async () => {
      engine = await createTestEngine({
        Alpha: [
          implement('op-fixby-0021'),
          [reject('op-fixby-0022'), turn],
          [{ do: 'crash', message: 'boom' }],
          implement('op-fixby-0023'),
          [approve('op-fixby-0024'), turn],
        ],
      });
      const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
      await until(workstream.id, (s) => s === 'DONE' || s === 'FAILED');
      expect(ws(workstream.id).state).toBe('DONE');
      const sessions = listSessions(engine.store.db, workstream.id);
      expect(engine.adapter.prompts[2]?.resume).toBe(sessions[0]?.providerSessionId);
      expect(engine.adapter.prompts[3]?.resume).toBeNull();
      expect(sessions[3]?.model).toBe('claude-opus-5-5');
      expect(step(workstream.id, 0)).toMatchObject({ fixFresh: 'done', model: 'claude-opus-5-5' });
    });
  });

  it('hands the reviewer the current attempt of a verification-only build report, after a send-back too', async () => {
    // A task that only checks things commits nothing: the build's last message is the whole result.
    // The card showed it, but the review's brief listed only steps with a recorded result, so each
    // reviewer had nothing of the build to judge, and a send-back left the next one no better off.
    const first =
      'Docker status: exit 0. HTTP check on localhost:8080: skipped, precondition PORT-FORWARD-MISSING.';
    const second = 'Docker status: exit 0. HTTP check on localhost:8080: exit 7, CURL-SEVEN.';
    engine = await createTestEngine({
      Alpha: [
        [{ do: 'turn_complete', text: first }],
        [reject('op-report-0001', '1. Run the HTTP check.'), turn],
        [{ do: 'turn_complete', text: second }],
        [approve('op-report-0002'), { do: 'turn_complete', text: 'Reviewed.' }],
      ],
    });
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
    await until(workstream.id, (s) => s === 'DONE' || s === 'FAILED');
    expect(ws(workstream.id).state).toBe('DONE');
    const [, review1, , review2] = engine.adapter.prompts.map((p) => p.prompt);
    expect(review1).toContain(`Implementation report, attempt 1`);
    expect(review1).toContain(first);
    // The second reviewer judges the build after the send-back, and is told which attempt that is.
    expect(review2).toContain(`Implementation report, attempt 2`);
    expect(review2).toContain(second);
    expect(review2).not.toContain(first);
    const builds = listSessions(engine.store.db, workstream.id);
    expect(step(workstream.id, 0)?.report).toMatchObject({
      summary: second,
      sessionId: builds[2]?.id,
      attempt: 2,
    });
    // The review's result is its own, and its step carries no report.
    expect(step(workstream.id, 1)?.result?.summary).toBe('Looks right.');
    expect(step(workstream.id, 1)?.report).toBeUndefined();
  });

  it('sends a rejection back to the implement step, one profile up, with the notes', async () => {
    engine = await createTestEngine({
      Alpha: [
        implement('op-flow-0011'),
        [reject('op-flow-0012'), turn],
        implement('op-flow-0013'),
        [approve('op-flow-0014'), turn],
      ],
    });
    // The row says fresh, which is what Careful and Critical do: Standard resumes by default.
    engine.state.write((ctx) =>
      setPlaybook(ctx, null, { rows: [{ rigor: 'standard', fixBy: 'fresh' }] }),
    );
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
    engine.launch(workstream.id);
    await engine.runner.idle();
    engine.launch(workstream.id); // review rejects; the implement step reruns in the same lane
    await engine.runner.idle();
    expect(engine.adapter.prompts[2]?.prompt).toContain('1. The empty state has no test.');
    expect(engine.adapter.prompts[2]?.prompt).toContain(
      'The review step (Reviewer) rejected the work',
    );
    expect(step(workstream.id, 0)).toMatchObject({
      model: 'claude-opus-5-5',
      effort: 'low',
      attempts: 1,
      reason: 'escalated from claude-sonnet-5-5@high after the review step rejected it',
    });
    // A reviewer's send-back counts against the review rounds, not the attempts.
    expect(ws(workstream.id).attempt).toBe(0);
    engine.launch(workstream.id); // the second gate passed; review again
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
  });

  const noVerdict = [turn, { do: 'await_message' as const, contains: RESULT_NUDGE }, turn];

  describe('a review session that ends without a verdict', () => {
    it('fails only when the rerun ends without a verdict too, and marks the step failed', async () => {
      engine = await createTestEngine({
        Alpha: [implement('op-flow-0023'), noVerdict, noVerdict],
      });
      const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
      await until(workstream.id, (s) => s === 'FAILED', 2);
      expect(ws(workstream.id)).toMatchObject({
        state: 'FAILED',
        failureReason:
          'The review step ended without calling complete_step: its last turn ended normally.',
        failureKind: 'no_result',
      });
      expect(listSessions(engine.store.db, workstream.id)).toHaveLength(3);
      expect(step(workstream.id, 1)?.status).toBe('failed');
      expect(listInbox(engine.store.db, { states: ['OPEN'] }).map((i) => i.kind)).toContain('flag');
      // A review that wrote nothing leaves no findings on the card.
      const card = listInbox(engine.store.db, { states: ['OPEN'] }).find((i) => i.kind === 'flag');
      expect(card?.detail?.['reviewRejection']).toBeUndefined();
    });

    it('runs the review once more by itself, gives each review its own rerun after the work is sent back, and the rerun can approve after the nudge with a verdict whose opId an earlier session already used', async () => {
      // Two incident reviews reused one readable opId: the daemon answered "Recorded" from the first
      // session's reply and wrote nothing, so the step failed for a verdict the reviewer had given.
      // The script waits for the exact nudge text, so a nudge that was never sent hangs the review.
      engine = await createTestEngine({
        Alpha: [
          implement('op-flow-0026'),
          noVerdict,
          [turn, { do: 'await_message', contains: RESULT_NUDGE }, reject('op-review-same'), turn],
          implement('op-flow-0028'),
          noVerdict,
          [turn, { do: 'await_message', contains: RESULT_NUDGE }, approve('op-review-same'), turn],
        ],
      });
      const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
      // The implement step, then the review: its rerun comes within the review's own launch.
      await until(workstream.id, () => false, 2);
      expect(listSessions(engine.store.db, workstream.id).length).toBeGreaterThanOrEqual(3);
      await until(workstream.id, (s) => s === 'DONE');
      expect(ws(workstream.id).state).toBe('DONE');
      expect(step(workstream.id, 1)?.result?.verdict).toBe('approve');
      expect(ws(workstream.id).steps.map((s) => s.status)).toEqual(['done', 'done']);
      expect(listSessions(engine.store.db, workstream.id).map((s) => s.exitReason)).toEqual(
        Array.from({ length: 6 }, () => 'step_done'),
      );
      expect(listInbox(engine.store.db, { states: ['OPEN'] }).map((i) => i.kind)).not.toContain(
        'flag',
      );
    });
  });

  describe('a review session that runs low on context', () => {
    const handoff = (opId: string) => ({
      do: 'mcp' as const,
      tool: 'write_handoff',
      args: handoffArgs(opId, 'Check the empty state, then give the verdict'),
    });
    const lowOnContext = (opId: string) => [
      { do: 'context' as const, percentage: 75 },
      { do: 'await_message' as const, contains: 'write_handoff' },
      handoff(opId),
      turn,
    ];

    it('hands off with its findings so far, a fresh session continues from them, and a rerun after it continues from that handoff', async () => {
      engine = await createTestEngine(
        {
          Alpha: [
            implement('op-flow-0151'),
            lowOnContext('op-flow-0152'),
            noVerdict,
            [approve('op-flow-0153'), turn],
          ],
        },
        { handoffPct: 70, nudgePct: 90 },
      );
      const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
      await until(workstream.id, (s) => s === 'DONE', 2);
      expect(ws(workstream.id).state).toBe('DONE');
      expect(listSessions(engine.store.db, workstream.id).map((s) => s.exitReason)).toEqual([
        'step_done',
        'handoff',
        'step_done',
        'step_done',
      ]);
      const continued = engine.adapter.prompts[2]?.prompt ?? '';
      expect(continued).toContain('Continue from the handoff below');
      expect(continued).toContain('Next action: Check the empty state, then give the verdict');
      expect(continued).toContain('Your step: 2 of 2, review');
      expect(engine.adapter.prompts[3]?.prompt).toContain('Continue from the handoff below');
    });
  });

  describe('when the reviewer rejects an ordinary task at the retry limit', () => {
    const FINAL =
      '1. BLOCKING src/api/a.txt:3 the card hides what the reviewer found.\n   Show it.\n2. NOTE the empty state has no test.';
    const round = (n: number) => [
      [turn],
      [reject(`op-flow-05${String(n)}0`, n === 4 ? FINAL : `1. NOTE round ${String(n)}`), turn],
    ];
    const shipped = async () => {
      engine = await createTestEngine({ Alpha: [...[1, 2, 3, 4].flatMap(round)] });
      // Three rounds, so the fourth rejection is the one at the limit.
      engine.state.write((ctx) =>
        setPlaybook(ctx, null, { rows: [{ rigor: 'standard', reviewRounds: 3 }] }),
      );
      const { task, workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
      await until(workstream.id, (s) => s === 'DONE' || s === 'FAILED');
      return { task, workstream };
    };
    const filedFor = (taskId: string) =>
      listTasks(engine.store.db, engine.project.id).filter((t) => t.id !== taskId);

    it('ships the task as an approved one is, without failing it, and files the last rejection as one Ready task that names the original', async () => {
      const { task, workstream } = await shipped();
      expect(ws(workstream.id)).toMatchObject({ state: 'DONE', failureReason: null });
      expect(getTask(engine.store.db, task.id).status).toBe('done');
      expect(step(workstream.id, 1)).toMatchObject({
        status: 'done',
        result: { verdict: 'reject' },
      });
      expect(activeClaims(engine.store.db, workstream.id)).toEqual([]);
      expect(listInbox(engine.store.db, { states: ['OPEN'] })).toEqual([]);
      // Only the send-backs before the limit count.
      expect(step(workstream.id, 1)?.sentBack).toBe(3);
      expect(reviewRounds(ws(workstream.id).steps)).toHaveLength(4);
      const [filed, ...rest] = filedFor(task.id);
      expect(rest).toEqual([]);
      expect(filed).toMatchObject({
        status: 'open',
        boardColumnId: null,
        boardStatus: 'ready',
        landing: task.landing,
        areas: task.areas,
      });
      expect(filed?.description).toContain(task.title);
      expect(filed?.description).toContain(task.id);
      expect(filed?.description).toContain(FINAL);
      expect(filed?.description).not.toContain('round 3');
      expect(filed?.acceptanceCriteria).toHaveLength(2);
      expect(step(workstream.id, 1)?.shippedAtLimit).toEqual({
        followUpTaskId: filed?.id,
        followUpTitle: filed?.title,
      });
    });

    describe('when a QA step follows the review', () => {
      const plan = {
        do: 'mcp' as const,
        tool: 'complete_step',
        args: { opId: 'op-flow-0570', summary: '1. Put it in src/api/a.txt.', verdict: null },
      };
      it('files one follow-up when QA sends the work back and the review rejects past its limit again', async () => {
        const LATER = '1. BLOCKING src/api/a.txt:9 the card still hides what the reviewer found.';
        const QA_SENT_BACK = '1. BLOCKING src/api/a.txt:1 the empty state crashes.';
        engine = await createTestEngine({
          Alpha: [
            [plan, turn],
            // Round 1 of the review, then its rejection past the limit that ships, then QA sends the work
            // back, the review rejects past its limit once more, and QA approves.
            [turn],
            [reject('op-flow-0591', '1. NOTE round 1'), turn],
            [turn],
            [reject('op-flow-0592', FINAL), turn],
            [reject('op-flow-0593', QA_SENT_BACK), turn],
            [turn],
            [reject('op-flow-0594', LATER), turn],
            [approve('op-flow-0595'), turn],
          ],
        });
        engine.state.write((ctx) =>
          setPlaybook(ctx, null, { rows: [{ rigor: 'critical', reviewRounds: 1 }] }),
        );
        const { task, workstream } = engine.addTask('Alpha', ['api'], [], {
          flow: 'full',
          criteria: 4,
        });
        await until(workstream.id, (s) => s === 'DONE' || s === 'FAILED');
        expect(ws(workstream.id)).toMatchObject({ state: 'DONE', failureReason: null });
        const [filed, ...rest] = filedFor(task.id);
        expect(rest).toEqual([]);
        expect(step(workstream.id, 2)?.shippedAtLimit).toEqual({
          followUpTaskId: filed?.id,
          followUpTitle: filed?.title,
        });
        // The follow-up is still unstarted, so what the review found the second time joins it.
        expect(filed?.description).toContain(FINAL);
        expect(filed?.description).toContain(LATER);
      });
    });
  });

  describe('when the reviewer keeps rejecting a task that must not ship with open findings', () => {
    const FINAL =
      '1. BLOCKING src/api/a.txt:3 the card hides what the reviewer found.\n   Show it.';
    const round = (n: number) => [
      [turn],
      [reject(`op-flow-04${String(n)}0`, n === 4 ? FINAL : `1. NOTE round ${String(n)}`), turn],
    ];
    const failed = async () => {
      engine = await createTestEngine({
        Alpha: [
          ...[1, 2, 3, 4].flatMap(round),
          // After a retry: the implement step reruns, then the review approves.
          [turn],
          [approve('op-flow-0499'), turn],
        ],
      });
      engine.state.write((ctx) =>
        setPlaybook(ctx, null, { rows: [{ rigor: 'standard', reviewRounds: 3 }] }),
      );
      // A kind of its own that fails at the limit, so the task stays on the Standard steps the script runs.
      engine.state.write((ctx) => {
        insertKind(ctx, { key: 'no-open-findings', label: 'No open findings', failsAtLimit: true });
      });
      const { workstream } = engine.addTask('Alpha', ['api'], [], {
        flow: 'standard',
        kinds: ['no-open-findings'],
      });
      await until(workstream.id, (s) => s === 'FAILED');
      return workstream;
    };

    it('fails after the fix limit with a flag that carries the last review’s findings, keeps every round, and a retry hands the findings to the implement step', async () => {
      const workstream = await failed();
      expect(ws(workstream.id)).toMatchObject({
        state: 'FAILED',
        failureReason: 'The review step rejected the work and the review rounds (3) are used up',
        failureKind: 'rejected_at_limit',
      });
      const card = listInbox(engine.store.db, { states: ['OPEN'] }).find((i) => i.kind === 'flag');
      const detail = ReviewCardDetail.parse(card?.detail?.['reviewRejection']);
      expect(detail.at).toBe(ws(workstream.id).steps[1]?.result?.at);
      expect(detail).toEqual({
        role: 'review',
        personaName: 'Reviewer',
        at: detail.at,
        findings: [
          {
            severity: 'BLOCKING',
            location: 'src/api/a.txt:3',
            text: 'BLOCKING src/api/a.txt:3 the card hides what the reviewer found.',
          },
        ],
        summary: FINAL,
      });
      // Every round the reviewer gave is kept.
      expect(reviewRounds(ws(workstream.id).steps).map((r) => r.result.summary)).toEqual([
        FINAL,
        '1. NOTE round 3',
        '1. NOTE round 2',
        '1. NOTE round 1',
      ]);
      expect(step(workstream.id, 1)?.sentBack).toBe(3);

      // The builder's retry goes to the implement step with the findings.
      engine.retry(workstream.id);
      expect(ws(workstream.id)).toMatchObject({
        state: 'QUEUED',
        stepIndex: 0,
        attempt: 0,
        nextAction: { kind: 'revise', reviewStep: 1, providerSessionId: null },
      });
      // The builder's retry stays fresh and owes no step up for a send-back that resumed.
      expect(step(workstream.id, 0)?.fixFresh).toBeUndefined();
      // The review has not run since the retry, so nothing it said before counts.
      expect(step(workstream.id, 1)?.sentBack).toBe(0);
      expect(reviewRounds(ws(workstream.id).steps)).toHaveLength(4);
      expect(step(workstream.id, 0)).toMatchObject({ status: 'running', result: null });
      await until(workstream.id, (s) => s === 'DONE');
      const prompt = engine.adapter.prompts.at(-2)?.prompt ?? '';
      expect(prompt).toContain('Your step: 1 of 2, implement');
      expect(prompt).toContain('rejected the work');
      expect(prompt).toContain('the card hides what the reviewer found');
      expect(ws(workstream.id).state).toBe('DONE');
    });
  });

  describe('a rigor change on a started task changes only the steps still to come', () => {
    const passing: GateResult = {
      exitCode: 0,
      durationMs: 1,
      tail: 'ok',
      logPath: '/dev/null',
      timedOut: false,
      aborted: false,
      blockedHosts: [],
    };
    const setRigor = (taskId: Parameters<typeof patchTask>[1], rigor: Rigor) =>
      engine.state.write((ctx) => patchTask(ctx, taskId, { rigor }));
    /** An engine whose gate waits for `release()`, after telling the test it started. */
    const heldGate = async (script: FakeScriptBook) => {
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started: () => void = () => undefined;
      const gateStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      engine = await createTestEngine(
        script,
        { gateCommand: 'true' },
        {
          gate: {
            run: async () => {
              started();
              await released;
              return passing;
            },
          },
        },
      );
      return { release, gateStarted };
    };

    it('gives a Light task patched to Standard while its gate runs a Review instead of done', async () => {
      const held = await heldGate({
        Alpha: [implement('op-replan-0011'), [approve('op-replan-0012'), turn]],
      });
      const { task, workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'quick' });
      engine.launch(workstream.id);
      await held.gateStarted;
      setRigor(task.id, 'standard');
      held.release();
      await engine.runner.idle();
      expect(ws(workstream.id)).toMatchObject({ state: 'QUEUED', stepIndex: 1 });
      expect(ws(workstream.id).steps.map((s) => s.role)).toEqual(['implement', 'review']);
      expect(step(workstream.id, 1)).toMatchObject({ reviewRounds: 1 });
      expect(ws(workstream.id).model).toBe(step(workstream.id, 1)?.model);
      engine.launch(workstream.id);
      await engine.runner.idle();
      expect(ws(workstream.id).state).toBe('DONE');
    });
  });

  it('goes from an approving review to DONE with no QA session when only Markdown changed', async () => {
    const plan = {
      do: 'mcp' as const,
      tool: 'complete_step',
      args: { opId: 'op-docs-0001', summary: '1. Write src/api/a.md.', verdict: null },
    };
    engine = await createTestEngine({
      Alpha: [
        [plan, turn],
        [write('src/api/a.md', '# A design'), commit('op-docs-0002', ['src/api/a.md']), turn],
        [approve('op-docs-0003'), turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'full', criteria: 4 });
    expect(ws(workstream.id).steps.map((s) => s.role)).toEqual([
      'plan',
      'implement',
      'review',
      'qa',
    ]);
    await until(workstream.id, (s) => s === 'DONE');
    expect(ws(workstream.id).state).toBe('DONE');
    // The QA step leaves the plan, as a step an existing rule skips never enters it, and no QA session ran.
    expect(ws(workstream.id).steps.map((s) => s.role)).toEqual(['plan', 'implement', 'review']);
    expect(engine.adapter.prompts).toHaveLength(3);
    const reasons = listEventsAfter(engine.store.db, 0, 1000)
      .filter((e) => e.type === 'workstream.changed' && e.entityId === workstream.id)
      .map((e) => e.data['reason']);
    expect(reasons).toContain('review approved; QA skipped: only docs changed');
  });

  it('gives the implementer the plan, and still runs QA when a commit changes a file that is not Markdown', async () => {
    const plan = {
      do: 'mcp' as const,
      tool: 'complete_step',
      args: { opId: 'op-docs-0011', summary: '1. Write both.', verdict: null },
    };
    engine = await createTestEngine({
      Alpha: [
        [plan, turn],
        [
          write('src/api/a.md', '# A design'),
          write('src/api/b.txt', 'code'),
          commit('op-docs-0012', ['src/api/a.md', 'src/api/b.txt']),
          turn,
        ],
        [approve('op-docs-0013'), turn],
        [approve('op-docs-0014'), turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'full', criteria: 4 });
    await until(workstream.id, (s) => s === 'DONE');
    expect(ws(workstream.id).state).toBe('DONE');
    expect(ws(workstream.id).steps.map((s) => s.role)).toEqual([
      'plan',
      'implement',
      'review',
      'qa',
    ]);
    expect(engine.adapter.prompts).toHaveLength(4);
    expect(engine.adapter.prompts[1]?.prompt).toContain('1. Write both.');
  });

  it('fails a sent-back plan that ends without a new result instead of reusing the old one', async () => {
    const plan = {
      do: 'mcp' as const,
      tool: 'complete_step',
      args: { opId: 'op-flow-0111', summary: 'PLAN ONE', verdict: null },
    };
    engine = await createTestEngine({
      Alpha: [
        [plan, turn],
        [reject('op-flow-0112', 'Needs more.'), turn],
        [turn, { do: 'await_message', contains: RESULT_NUDGE }, turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha', ['api'], [], {
      flow: 'full',
      criteria: 4,
      riskTags: ['security'],
    });
    await until(workstream.id, (s) => s === 'FAILED');
    expect(ws(workstream.id).failureReason).toBe(
      'The plan step ended without calling complete_step: its last turn ended normally.',
    );
  });

  describe('a run whose commits were reverted, retried before its implement step', () => {
    const REVERT = 'a'.repeat(40);
    const REDO = 'Redo the work and commit it with the commit tool';
    const plan = (opId: string) => ({
      do: 'mcp' as const,
      tool: 'complete_step',
      args: { opId, summary: 'PLAN', verdict: null },
    });
    const leaveOut = (id: WorkstreamId) => {
      engine.state.write((ctx) => {
        setWorkstreamNotice(ctx, id, {
          key: LEFT_OUT_NOTICE_KEY,
          tone: 'info',
          line: 'Left out of the pull request: its commit was reverted',
          body: `This run failed, and you chose Ship without it.\n\n${REVERT_COMMIT_LINE}${REVERT}`,
        });
      });
    };
    const promptFor = (step: string) =>
      engine.adapter.prompts.find((p) => p.prompt.includes(`Your step: ${step}`))?.prompt ?? '';
    const lastPromptFor = (step: string) =>
      engine.adapter.prompts.findLast((p) => p.prompt.includes(`Your step: ${step}`))?.prompt ?? '';

    it('tells the implement step when Retry restarted the plan step', async () => {
      engine = await createTestEngine({
        Alpha: [
          [turn, { do: 'await_message', contains: RESULT_NUDGE }, turn],
          [plan('op-told-0001'), turn],
          implement('op-told-0002'),
          [approve('op-told-0003'), turn],
          [approve('op-told-0004'), turn],
        ],
      });
      const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'full', criteria: 4 });
      await until(workstream.id, (s) => s === 'FAILED');
      leaveOut(workstream.id);
      engine.retry(workstream.id);
      await until(workstream.id, (s) => s === 'DONE');
      const planning = lastPromptFor('1 of 4, plan');
      expect(planning).toContain(REVERT);
      expect(planning).not.toContain(REDO);
      const building = promptFor('2 of 4, implement');
      expect(building).toContain(REVERT);
      expect(building).toContain(REDO);
      expect(building).toContain('Address it, commit, and end your turn.');
    });

    it('tells the implement step when Retry went back to the plan after a plan review at the limit', async () => {
      engine = await createTestEngine({
        Alpha: [
          [plan('op-told-0011'), turn],
          [reject('op-told-0012', 'Needs more.'), turn],
          [plan('op-told-0013'), turn],
          [approve('op-told-0014'), turn],
          implement('op-told-0015'),
          [approve('op-told-0016'), turn],
          [approve('op-told-0017'), turn],
        ],
      });
      const { workstream } = engine.addTask('Alpha', ['api'], [], {
        flow: 'full',
        criteria: 4,
        riskTags: ['security'],
      });
      // No rounds: the plan review's first rejection is already at the limit.
      engine.state.write((ctx) =>
        setPlaybook(ctx, null, { rows: [{ rigor: 'critical', reviewRounds: 0 }] }),
      );
      await until(workstream.id, (s) => s === 'FAILED');
      expect(ws(workstream.id).stepIndex).toBe(1);
      leaveOut(workstream.id);
      expect(engine.retry(workstream.id).stepIndex).toBe(0);
      await until(workstream.id, (s) => s === 'DONE');
      expect(lastPromptFor('1 of 5, plan')).not.toContain(REDO);
      expect(promptFor('2 of 5, plan_review')).not.toContain(REDO);
      const building = promptFor('3 of 5, implement');
      expect(building).toContain(REVERT);
      expect(building).toContain(REDO);
    });
  });

  it('resumes the step it was on after a crash, and never gives a later step an earlier step’s handoff', async () => {
    engine = await createTestEngine({
      Alpha: [
        [
          { do: 'context', percentage: 75 },
          { do: 'await_message', contains: 'write_handoff' },
          {
            do: 'mcp',
            tool: 'write_handoff',
            args: handoffArgs('op-flow-0081', 'Commit the file'),
          },
          turn,
        ],
        implement('op-flow-0082'),
        [{ do: 'crash', message: 'boom' }],
        [{ do: 'crash', message: 'boom again' }],
        [approve('op-flow-0083'), turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
    // Run up to the review's first crash: the lane waits on the review step to resume it.
    for (let i = 0; i < 10 && ws(workstream.id).nextAction.kind !== 'resume'; i += 1) {
      engine.launch(workstream.id);
      await engine.runner.idle();
    }
    expect(ws(workstream.id)).toMatchObject({
      state: 'QUEUED',
      stepIndex: 1,
      nextAction: { kind: 'resume' },
    });
    await until(workstream.id, (s) => s === 'DONE');
    // The crashed review is resumed in its own conversation.
    const sessions = listSessions(engine.store.db, workstream.id);
    expect(engine.adapter.prompts[3]).toMatchObject({ resume: sessions[2]?.providerSessionId });
    // The review crashed twice: once resumed, then started fresh. A fresh review starts, not continues.
    expect(engine.adapter.prompts[4]?.prompt).not.toContain('Continue from the handoff');
    expect(engine.adapter.prompts[4]?.prompt).toContain('Your step: 2 of 2, review');
    expect(engine.adapter.prompts[4]?.prompt).not.toContain('Commit the file');
    // The implementer's handoff reached the implement step's own continuation.
    expect(engine.adapter.prompts[1]?.prompt).toContain('Commit the file');
  });

  it('posts a notice for a read-only step that leaves changes in its claims, and the flow still completes', async () => {
    engine = await createTestEngine({
      Alpha: [implement('op-flow-0101'), [approve('op-flow-0102'), turn]],
    });
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
    engine.launch(workstream.id);
    await engine.runner.idle();
    // The review session's own change: it lands inside the claim after the implement step committed.
    mkdirSync(join(engine.repoPath, 'src/api'), { recursive: true });
    writeFileSync(join(engine.repoPath, 'src/api/review-note.txt'), 'x');
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(ws(workstream.id).state).toBe('DONE');
    expect(
      listInbox(engine.store.db, { states: ['OPEN'] }).filter((i) => i.kind === 'flag'),
    ).toEqual([]);
    expect(noticesPosted(engine.store.db)).toMatchObject([
      {
        key: `left-changes:${workstream.id}:review`,
        tone: 'warning',
        line: 'The review step left changes in its claims',
        body: 'src/api/review-note.txt',
        projectId: engine.project.id,
        taskId: ws(workstream.id).taskId,
      },
    ]);
  });
});

describe('a step that ends with changes in its claims', () => {
  const gateEvidence = (id: Parameters<typeof ws>[0]) =>
    listEvidence(engine.store.db, id).filter((e) => e.kind === 'gate');

  it('goes back to the same step, naming the files in its claims only, no gate runs on them, and a change outside its claims is left to the watcher', async () => {
    engine = await createTestEngine({
      Alpha: [
        [write('src/api/a.txt'), turn],
        [commit('op-uncom-0001', ['src/api/a.txt']), turn],
      ],
    });
    // Outside the claims: the watcher's, so the step neither names it nor waits on it for the gate.
    mkdirSync(join(engine.repoPath, 'src/ui'), { recursive: true });
    writeFileSync(join(engine.repoPath, 'src/ui/elsewhere.txt'), 'x');
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(ws(workstream.id)).toMatchObject({
      state: 'QUEUED',
      stepIndex: 0,
      attempt: 1,
      nextAction: { kind: 'uncommitted', paths: ['src/api/a.txt'] },
    });
    expect(gateEvidence(workstream.id)).toEqual([]);

    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(engine.adapter.prompts[1]?.prompt).toContain('- src/api/a.txt');
    expect(gateEvidence(workstream.id)).toHaveLength(1);
  });

  it("leaves what the checkout held before the task first ran, naming only the task's own change", async () => {
    engine = await createTestEngine({
      Alpha: [
        [write('src/api/a.txt'), turn],
        [commit('op-uncom-0002', ['src/api/a.txt']), turn],
      ],
    });
    // The builder's edit in a shared checkout, inside the task's claims and older than the task.
    mkdirSync(join(engine.repoPath, 'src/api'), { recursive: true });
    writeFileSync(join(engine.repoPath, 'src/api/builder.txt'), 'theirs');
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(ws(workstream.id)).toMatchObject({
      state: 'QUEUED',
      nextAction: { kind: 'uncommitted', paths: ['src/api/a.txt'] },
    });

    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(gateEvidence(workstream.id)).toHaveLength(1);
  });

  it('finishes on its own commit once its session leaves an edit another writer made while it ran', async () => {
    engine = await createTestEngine({
      Alpha: [
        [
          write('src/api/a.txt'),
          { do: 'await_signal', name: 'builder-wrote' },
          commit('op-uncom-0003', ['src/api/a.txt']),
          turn,
        ],
        [
          {
            do: 'mcp',
            tool: 'report_deviation',
            args: {
              opId: 'op-uncom-0004',
              cause: 'Another writer is editing this checkout.',
              severity: 'warn',
              reason: 'This task never changed src/api/builder.txt.',
              leaveUncommitted: ['src/api/builder.txt'],
            },
          },
          turn,
        ],
      ],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    // The builder edits inside the task's claims after the task first launched.
    await waitFor(() => existsSync(join(engine.repoPath, 'src/api/a.txt')) || undefined);
    writeFileSync(join(engine.repoPath, 'src/api/builder.txt'), 'theirs');
    engine.adapter.signal('builder-wrote');
    await engine.runner.idle();
    expect(ws(workstream.id).nextAction).toEqual({
      kind: 'uncommitted',
      paths: ['src/api/builder.txt'],
    });
    const repoGit = (...args: string[]) =>
      execFileSync('git', ['-C', engine.repoPath, ...args], {
        env: isolatedGitEnv(),
        encoding: 'utf8',
      }).trim();
    const head = repoGit('rev-parse', 'HEAD');

    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    // No second commit: the gate passed on the step's one commit, and the builder's edit stays theirs.
    expect(repoGit('rev-parse', 'HEAD')).toBe(head);
    expect(gateEvidence(workstream.id).map((e) => e.commitShas)).toEqual([[head]]);
    expect(repoGit('status', '--porcelain')).toBe('?? src/api/builder.txt');
  });

  it("a retry after its committed step was blocked finishes on that commit, naming only the task's commits", async () => {
    engine = await createTestEngine({
      Alpha: [
        [
          write('src/api/a.txt'),
          commit('op-retry-0001', ['src/api/a.txt']),
          // Skipped, sent out to the network, so the step can say it was blocked.
          { do: 'tool', toolName: 'Bash', input: { command: 'curl -s https://example.com' } },
          { do: 'mcp', tool: 'report_blocked', args: { reason: 'The checks could not start.' } },
          turn,
        ],
        [turn],
      ],
    });
    const repoGit = (...args: string[]) =>
      execFileSync('git', ['-C', engine.repoPath, ...args], {
        env: isolatedGitEnv(),
        encoding: 'utf8',
      }).trim();
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({ state: 'FAILED', failureKind: 'blocked' });
    const own = repoGit('rev-parse', 'HEAD');
    // The builder commits their own work on the shared branch before pressing Retry.
    writeFileSync(join(engine.repoPath, 'builder.txt'), 'theirs');
    repoGit('add', 'builder.txt');
    repoGit('commit', '-q', '-m', 'Builder work');
    const builders = repoGit('rev-parse', 'HEAD');

    engine.retry(workstream.id);
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(repoGit('rev-parse', 'HEAD')).toBe(builders);
    expect(gateEvidence(workstream.id).map((e) => e.commitShas)).toEqual([[own]]);
  });

  it('keeps its retry limit while the builder keeps adding files its sessions leave', async () => {
    const leave = (n: number) => [
      {
        do: 'mcp' as const,
        tool: 'report_deviation',
        args: {
          opId: `op-uncom-left-${String(n)}`,
          cause: 'Another writer is editing this checkout.',
          severity: 'warn',
          reason: 'This task never changed it.',
          leaveUncommitted: [`src/api/builder-${String(n)}.txt`],
        },
      },
      { do: 'await_signal' as const, name: `left-${String(n)}` },
      turn,
    ];
    engine = await createTestEngine({
      Alpha: [
        [
          write('src/api/a.txt'),
          commit('op-uncom-left-0', ['src/api/a.txt']),
          { do: 'await_signal', name: 'left-0' },
          turn,
        ],
        leave(1),
        leave(2),
        leave(3),
        leave(4),
      ],
    });
    const { workstream } = engine.addTask('Alpha');
    const deviations = () => engine.store.db.select().from(schema.deviations).all().length;
    engine.launch(workstream.id);
    // Each round the builder adds a file after the session has dealt with the last one.
    // The session waits on its signal once it has committed (the first) or named the last file.
    const paused = (n: number) =>
      n === 1
        ? engine.adapter.observations.some(
            (o) => o.kind === 'mcp_result' && o.detail['tool'] === 'commit',
          )
        : deviations() === n - 1 && engine.adapter.prompts.length === n;
    for (let n = 1; n <= 4; n += 1) {
      await waitFor(() => paused(n) || undefined);
      writeFileSync(join(engine.repoPath, `src/api/builder-${String(n)}.txt`), 'theirs');
      engine.adapter.signal(`left-${String(n - 1)}`);
      await engine.runner.idle();
      expect(ws(workstream.id).nextAction).toEqual({
        kind: 'uncommitted',
        paths: [`src/api/builder-${String(n)}.txt`],
      });
      // Only the first send-back, which nobody had answered yet, counts.
      expect(ws(workstream.id).attempt).toBe(1);
      engine.launch(workstream.id);
    }
    await waitFor(() => paused(5) || undefined);
    engine.adapter.signal('left-4');
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
  });

  it('keeps charging a task with its own uncommitted change when it ran before its start was recorded', async () => {
    engine = await createTestEngine({
      Alpha: [[write('src/api/a.txt'), turn], [turn]],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).nextAction).toEqual({ kind: 'uncommitted', paths: ['src/api/a.txt'] });

    // As for a task that ran before 10db recorded what a checkout held, or one taken out of a pass.
    engine.store.db.delete(schema.taskStartDirt).run();
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({
      state: 'QUEUED',
      nextAction: { kind: 'uncommitted', paths: ['src/api/a.txt'] },
    });
  });

  it('fails the step once it has been sent back as many times as the fix limit allows', async () => {
    const uncommitted = [write('src/api/a.txt'), turn];
    engine = await createTestEngine({
      Alpha: [uncommitted, uncommitted, uncommitted, uncommitted],
    });
    const { workstream } = engine.addTask('Alpha');
    const finished = (): boolean => ['DONE', 'FAILED'].includes(ws(workstream.id).state);
    for (let run = 0; run < 4 && !finished(); run += 1) {
      engine.launch(workstream.id);
      await engine.runner.idle();
    }

    expect(ws(workstream.id).state).toBe('FAILED');
    expect(ws(workstream.id).failureReason).toContain('uncommitted changes');
    expect(ws(workstream.id).failureKind).toBe('retry_limit');
    expect(gateEvidence(workstream.id)).toEqual([]);
  });
});

describe('the session guard', () => {
  // An account's config directory lives under the data directory, which the guard protects.
  const configDir = () => join(engine.dataDir, 'accounts', 'a', 'claude');
  const results = (sessionId: string) =>
    join(configDir(), 'projects', 'p', sessionId, 'tool-results', 'out.txt');
  let workstreamId = '' as Parameters<typeof listSessions>[1];
  // The session id is the fake provider's, derived from the session row; read when the step runs.
  const ownSession = () => `fake-${listSessions(engine.store.db, workstreamId)[0]?.id ?? ''}`;
  const read = (path: () => string) => ({
    do: 'tool' as const,
    toolName: 'Read',
    input: {
      get file_path() {
        return path();
      },
    },
  });
  const start = async (
    steps: (ReturnType<typeof read> | { do: 'activity'; summary: string })[],
  ) => {
    engine = await createTestEngine({ Alpha: [[...steps, turn]] });
    mkdirSync(dirname(results('someone-else')), { recursive: true });
    // The test database's accounts are all this test's; point them at that directory.
    engine.store.db.update(schema.accounts).set({ configDir: configDir() }).run();
    const { workstream } = engine.addTask('Alpha');
    workstreamId = workstream.id;
    engine.launch(workstream.id);
  };
  const denials = () => engine.adapter.observations.filter((o) => o.kind === 'denied_by_guard');
  // T4: the read passes the guard; in a lane the broker then skips the card it would have raised.
  it("lets a session read its own saved output, which reaches the broker, and refuses a read of another session's", async () => {
    await start([
      read(() => {
        // Claude Code has written the output by the time the model reads it.
        const path = results(ownSession());
        mkdirSync(dirname(path), { recursive: true });
        return path;
      }),
      read(() => results('someone-else')),
    ]);
    await waitFor(() => denials().length > 0);
    await waitFor(() => skipsOf(workstreamId)[0]);
    // Only the other session's read is the guard's: the own read passed it and reached the broker.
    expect(denials().map((d) => d.step)).toEqual([1]);
    expect(String(denials()[0]?.detail['reason'])).toContain('sign-in');
    expect(skipsOf(workstreamId)).toMatchObject([{ toolName: 'Read', source: 'broker' }]);
  });

  // An area narrowed while a session runs: its guard judges the area as it is now, not as it was at
  // the start, or a claim on the narrowed name would still cover another lane's files.
  it('judges a write against the areas as they are now, not as the session started with them', async () => {
    engine = await createTestEngine({ Alpha: [[{ do: 'hang' }]] });
    const specs: LaneSessionSpec[] = [];
    engine.adapter.seen = (spec) => {
      specs.push(spec);
      return {};
    };
    const { workstream } = engine.addTask('Alpha', ['api']);
    engine.launch(workstream.id);
    const spec = await waitFor(() => specs[0]);
    const write = () =>
      spec.preToolUse({
        toolName: 'Write',
        input: { file_path: join(engine.repoPath, 'src/api/billing/charge.ts'), content: 'x' },
      }).decision;
    expect(write()).toBe('allow');
    engine.state.write((ctx) =>
      patchProject(ctx, engine.project.id, {
        areas: [
          { name: 'api', globs: ['src/api/*'] },
          { name: 'api-billing', globs: ['src/api/billing/**'] },
          { name: 'ui', globs: ['src/ui/**'] },
        ],
      }),
    );
    expect(write()).toBe('deny');
    await engine.runner.cancel(workstream.id);
  });

  // T4 call 2: a guard ask in a lane is answered at once by the unattended table.
  it('skips a call the broker must see in a lane, whatever the permission mode', async () => {
    engine = await createTestEngine({ Alpha: [[{ do: 'hang' }]] });
    const specs: LaneSessionSpec[] = [];
    engine.adapter.seen = (spec) => {
      specs.push(spec);
      return {};
    };
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const spec = await waitFor(() => specs[0]);
    const decision = (toolName: string, input: Record<string, unknown>) =>
      spec.preToolUse({ toolName, input }).decision;
    expect(decision('Bash', { command: 'SUB=add; pnpm $SUB left-pad@1.3.0' })).toBe('deny');
    expect(decision('WebFetch', { url: 'https://example.net/', prompt: 'x' })).toBe('deny');
    expect(decision('Bash', { command: 'pnpm test' })).toBe('allow');
    expect(skipsOf(workstream.id)).toEqual([
      {
        toolName: 'Bash',
        summary: 'SUB=add; pnpm $SUB left-pad@1.3.0',
        kind: 'unread_hazard',
        source: 'guard',
      },
      {
        toolName: 'WebFetch',
        summary: 'https://example.net/',
        kind: 'web_or_mcp',
        source: 'guard',
      },
    ]);
    await engine.runner.cancel(workstream.id);
  });
});

// A stand-in lane session, not the `lane sandbox` probe below: the probe needs the shared `/tmp`
// and skips in a sandboxed gate, and this hop must be held there too. The judge is the real one.
describe("a lane's settled read-only line", () => {
  let root: ReturnType<typeof tempDir>;
  beforeEach(() => {
    root = tempDir('settled');
  });
  afterEach(() => {
    root.cleanup();
  });

  const standInSandbox = (): LaneSandbox => ({
    judgeSetup: () => Promise.reject(new Error('no preview here')),
    forTakeover: () => Promise.reject(new Error('no takeover here')),
    forSession: (input) =>
      Promise.resolve({
        spec: {} as LaneSession['spec'],
        fileAccess: {
          checkout: input.project.repoPath,
          home: root.path,
          protectedReads: [],
          readList: [],
          configDir: input.configDir,
          providerSessionId: null,
          sandboxTemp: { roots: [root.path], own: root.path },
        },
        tmpDir: root.path,
        commandEnv: {},
        mcpServers: {},
        mcpFailures: [],
        setup: EMPTY_SETUP,
        secretReadsDir: null,
        setProviderSession: () => undefined,
        trackProcesses: () => Promise.resolve(true),
        endProcesses: () => Promise.resolve(),
        processMembers: () => [],
        markOwn: () => undefined,
        endJobs: () => Promise.resolve(),
        dispose: () => undefined,
      }),
  });

  it("is judged from the hook's cwd, which an earlier call's cd moved", async () => {
    engine = await createTestEngine(
      { Alpha: [[{ do: 'hang' }]] },
      {},
      { laneSandbox: standInSandbox() },
    );
    const specs: LaneSessionSpec[] = [];
    engine.adapter.seen = (spec) => {
      specs.push(spec);
      return {};
    };
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const spec = await waitFor(() => specs[0]);
    const apps = join(spec.cwd, 'apps');
    mkdirSync(apps);
    symlinkSync('/dev/zero', join(apps, 'zero-link'));
    const cat = { toolName: 'Bash', input: { command: 'cat zero-link' } };
    // Without the hook's cwd the word is read from the copy's root, where no such link exists.
    expect(spec.preToolUse(cat)).toHaveProperty('settled');
    expect(spec.preToolUse({ ...cat, cwd: apps })).not.toHaveProperty('settled');
    await engine.runner.cancel(workstream.id);
  });
});

// The probe's temp root is a short path under the shared `/tmp`, which no sandbox can write.
describe.skipIf(SANDBOXED)('lane sandbox', () => {
  const lanesGit = createGit();
  /**
   * A real lane sandbox over a short temp root, its own files root and Codex lanes root, and a temp
   * home, recording each session it makes.
   */
  interface SandboxProbe {
    readonly laneSandbox: LaneSandbox;
    readonly inputs: LaneSessionInput[];
    readonly sessions: LaneSession[];
    readonly home: string;
    readonly tmpRoot: string;
    readonly filesRoot: string;
    /** What the engine is given as `codexLaneTempRoot`. */
    readonly codexLanes: string;
  }
  let probeRoot: string | null = null;
  let probeHome: TempDir | null = null;
  afterEach(() => {
    if (probeRoot !== null) rmSync(probeRoot, { recursive: true, force: true });
    probeRoot = null;
    probeHome?.cleanup();
    probeHome = null;
  });
  const sandboxProbe = (fail?: () => never, processes?: LaneProcessSetup): SandboxProbe => {
    probeRoot = realpathSync(mkdtempSync('/tmp/sbr-'));
    // The builder's home is outside every temp root: under one, 10db leaves out what its files lead into.
    probeHome = homeOutsideTemp('sbr');
    const home = join(probeHome.path, 'h');
    mkdirSync(home);
    const tmpRoot = join(probeRoot, 't');
    const filesRoot = join(probeRoot, 'r');
    const codexLanes = join(probeRoot, 'l');
    for (const dir of [tmpRoot, filesRoot, codexLanes]) mkdirSync(dir);
    const real = createLaneSandbox({
      home,
      dataDir: join(probeRoot, 'd'),
      loginConfigDir: null,
      tmpRoot,
      filesRoot,
      codexLaneTempRoot: codexLanes,
      gitDirs: (path) => lanesGit.gitDirs(path),
      runtime: FAKE_SRT,
      worktreeRoot: join(probeRoot, 'w'),
      ...(processes === undefined ? {} : { processes }),
    });
    const inputs: LaneSessionInput[] = [];
    const sessions: LaneSession[] = [];
    return {
      laneSandbox: {
        judgeSetup: (project, setup, checkouts) => real.judgeSetup(project, setup, checkouts),
        forTakeover: (input) => real.forTakeover(input),
        async forSession(input) {
          inputs.push(input);
          if (fail) fail();
          const session = await real.forSession(input);
          sessions.push(session);
          return session;
        },
      },
      inputs,
      sessions,
      home,
      tmpRoot,
      filesRoot,
      codexLanes,
    };
  };
  const hostCall = (host: string) => ({
    do: 'tool' as const,
    toolName: 'SandboxNetworkAccess',
    input: { host },
  });

  it("runs the session under its profile in default mode, with checkout-scoped reads and the sandbox briefing, and keeps a Claude lane's temp dir under the lane temp root", async () => {
    const probe = sandboxProbe();
    engine = await createTestEngine(
      { Alpha: [[turn]] },
      {},
      { laneSandbox: probe.laneSandbox, codexLaneTempRoot: probe.codexLanes },
    );
    const specs = recordSpecs();
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();

    const [laneSession] = probe.sessions;
    const [spec] = specs;
    const [session] = listSessions(engine.store.db, workstream.id);
    expect(spec?.sandbox).toBe(laneSession?.spec);
    expect(spec?.profile.allowedTools).toContain(`Read(/${realpathSync(engine.repoPath)}/**)`);
    expect(spec?.profile.allowedTools).not.toContain('Read');
    expect(spec?.prompt).toContain('a bare `mktemp` fails in the sandbox');
    expect(probe.inputs[0]).toMatchObject({
      project: { id: engine.project.id, repoPath: engine.repoPath, sandboxLoopback: false },
      env: spec?.env,
      rules: [],
      resumeProviderSessionId: null,
      configDir: join(homedir(), '.claude'),
    });
    // The id Claude Code named at `started` is the one the file tools judge by.
    expect(laneSession?.fileAccess.providerSessionId).toBe(session?.providerSessionId);
    // Claude Code and srt run in a Claude lane's temp dir: it stays under the short temp root.
    expect(probe.inputs[0]?.tempRoot).toBeUndefined();
    expect(probe.inputs[0]?.provider).toBe('claude');
    expect(dirname(laneSession?.tmpDir ?? '')).toBe(probe.tmpRoot);
    // The session ended, so its temp dir and files are gone.
    expect(readdirSync(probe.tmpRoot)).toEqual([]);
    expect(readdirSync(probe.filesRoot)).toEqual([]);
    expect(ws(workstream.id).state).toBe('DONE');
  });

  describe('the setup a session starts with', () => {
    /** The engine on the probe's sandbox, reading the probe's home as the builder's. */
    const setupEngine = async (
      probe: SandboxProbe,
      book: FakeScriptBook,
      logger = silentLogger,
    ): Promise<TestEngine> =>
      createTestEngine(
        book,
        {},
        {
          laneSandbox: probe.laneSandbox,
          codexLaneTempRoot: probe.codexLanes,
          builderHome: probe.home,
          laneWritableRoots: [probe.tmpRoot, probe.codexLanes],
          logger,
        },
      );
    const builderSkill = (home: string, name: string): string => {
      const dir = join(home, '.claude/skills', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: a skill\n---\n`);
      return dir;
    };
    /** Commits files into the engine's repository, so the lane's copy holds them and nothing is left over. */
    const commitToRepo = (files: Record<string, string>): void => {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(engine.repoPath, path)), { recursive: true });
        writeFileSync(join(engine.repoPath, path), text);
      }
      const repoGit = (...args: string[]) =>
        execFileSync('git', ['-C', engine.repoPath, ...args], {
          env: isolatedGitEnv(),
          stdio: 'pipe',
        });
      repoGit('add', '--', ...Object.keys(files));
      repoGit('commit', '-q', '-m', 'setup');
    };
    /** Each spec as it started, with where its `yours` plugin's skill links led while it ran. */
    const recordSetups = (): { spec: LaneSessionSpec; links: Record<string, string> }[] => {
      const seen: { spec: LaneSessionSpec; links: Record<string, string> }[] = [];
      engine.adapter.seen = (spec) => {
        const yours = spec.setup?.plugins.find((dir) => dir.endsWith('/yours'));
        const skills = yours === undefined ? [] : readdirSync(join(yours, 'skills'));
        seen.push({
          spec,
          links: Object.fromEntries(
            skills.map((name) => [name, readlinkSync(join(yours ?? '', 'skills', name))]),
          ),
        });
        return {};
      };
      return seen;
    };

    it("starts a lane with the project's instructions, the builder's skills and the setup reads in its profile", async () => {
      const probe = sandboxProbe();
      engine = await setupEngine(probe, { Alpha: [[turn]] });
      commitToRepo({ 'AGENTS.md': '# Rules\n\nUse pnpm.\n' });
      const skill = builderSkill(probe.home, 's');
      const seen = recordSetups();
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await engine.runner.idle();

      const [first] = seen;
      expect(first?.spec.instructions).toContain('Use pnpm.');
      expect(first?.spec.setup?.plugins[0]).toMatch(/\/yours$/);
      expect(first?.links).toEqual({ s: skill });
      expect(probe.sessions[0]?.spec.settings.filesystem.allowRead).toContain(
        join(probe.home, '.claude/skills'),
      );
      expect(first?.spec.prompt).toContain(
        "- The repository's agent instructions (AGENTS.md, CLAUDE.md, .claude/rules) and the builder's own are in your system prompt.",
      );
      expect(first?.spec.prompt).toContain('- Loaded for you: 1 of your skills.');
      // The session ended, so its setup dir is gone with its sandbox.
      expect(readdirSync(probe.filesRoot)).toEqual([]);
    });

    describe("the builder's own MCP servers", () => {
      const approve = (probe: SandboxProbe, ...names: string[]): void => {
        const { entries } = readYourMcpConfig({ home: probe.home, laneWritable: [], plugins: [] });
        for (const name of names) {
          const entry = entries.find((e) => e.name === name);
          const hash = entry?.configHash;
          if (!entry || !hash) throw new Error(`no ${name} in the probe's config`);
          engine.state.write((ctx) => {
            approveMcpServer(ctx, entry.key, hash);
          });
        }
      };
      const writeClaudeJson = (home: string, servers: Record<string, unknown>): void => {
        mkdirSync(home, { recursive: true });
        writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: servers }));
      };
      const startOne = async (): Promise<LaneSessionSpec> => {
        const seen: LaneSessionSpec[] = [];
        engine.adapter.seen = (spec) => {
          seen.push(spec);
          return {};
        };
        const { workstream } = engine.addTask('Alpha');
        engine.launch(workstream.id);
        await engine.runner.idle();
        const spec = seen[0];
        if (!spec) throw new Error('Alpha never started a session');
        return spec;
      };

      it("starts a lane with your approved servers as launches or urls, names the one waiting for approval, and takes the plan account's claude.ai connectors with the switch on, naming them in the policy", async () => {
        const probe = sandboxProbe();
        engine = await setupEngine(probe, { Alpha: [[turn]] });
        writeClaudeJson(probe.home, {
          mine: { command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: 'sk-canary' } },
          docs: { type: 'http', url: 'https://docs.example/mcp' },
          later: { command: 'npx', args: ['-y', 'later'] },
        });
        approve(probe, 'mine', 'docs');
        const spec = await startOne();
        // The home is outside every temp root, so the approved stdio server launches beside the url one.
        expect(Object.keys(spec.yourMcpServers).sort()).toEqual(['docs', 'mine']);
        expect(spec.yourMcpServers['docs']?.connect).toEqual({
          type: 'http',
          url: 'https://docs.example/mcp',
          headers: null,
        });
        expect(spec.prompt).toContain('later (~/.claude.json)');
        expect(spec.prompt).toContain('waiting for your approval in Settings');
        expect(spec.claudeConnectors).toBe(true);
        expect(spec.policy.environment.join('\n')).toContain('claude.ai connectors');
      });

      it('takes no claude.ai connector when the project turns Your MCP servers off', async () => {
        const probe = sandboxProbe();
        engine = await setupEngine(probe, { Alpha: [[turn]] });
        engine.state.write((ctx) => {
          setProjectTrustOverrides(ctx, engine.project.id, { yourMcpServers: false });
        });
        const spec = await startOne();
        expect(spec.claudeConnectors).toBe(false);
        expect(spec.policy.environment.join('\n')).not.toContain('claude.ai connectors');
      });

      it('a project override off drops a server for that project only', async () => {
        const probe = sandboxProbe();
        engine = await setupEngine(probe, { Alpha: [[turn]] });
        writeClaudeJson(probe.home, { docs: { type: 'http', url: 'https://docs.example/mcp' } });
        approve(probe, 'docs');
        const key = yourMcpServerKey(YourMcpSource.ClaudeJson, 'docs');
        engine.state.write((ctx) => {
          setProjectTrustOverrides(ctx, engine.project.id, { mcpServers: { [key]: false } });
        });
        const spec = await startOne();
        expect(spec.yourMcpServers).toEqual({});
        expect(spec.policy.environment.join('\n')).not.toContain(
          'Outside the sandbox: the MCP servers',
        );
      });

      it('the prompt and the log of a session start hold no env value, argument or url text', async () => {
        const probe = sandboxProbe();
        const logs = captureLogs();
        engine = await setupEngine(probe, { Alpha: [[turn]] }, logs.logger);
        writeClaudeJson(probe.home, {
          mine: { command: 'npx', args: ['--m=arg-canary'], env: { TOKEN: 'sk-canary' } },
          broken: { type: 'http', url: 'https://x.example/url-canary?k=${NOPE_CANARY}' },
          unsafe: { command: 'npx', args: [`${engine.repoPath}/x-canary`] },
        });
        approve(probe, 'mine', 'broken', 'unsafe');
        const spec = await startOne();
        // `mine` launches; `broken` and `unsafe` are left out.
        expect(Object.keys(spec.yourMcpServers)).toEqual(['mine']);
        expect(spec.prompt).toContain('broken (~/.claude.json)');
        expect(spec.prompt).toContain('your MCP server unsafe');
        const everything = JSON.stringify([spec.prompt, logs.lines()]);
        for (const canary of ['sk-canary', 'arg-canary', 'url-canary', 'x-canary'])
          expect(everything).not.toContain(canary);
      });
    });

    it('logs a stored trust setting that is not a shape 10db reads, and starts with it off', async () => {
      const probe = sandboxProbe();
      const logs = captureLogs();
      engine = await setupEngine(probe, { Alpha: [[turn]] }, logs.logger);
      builderSkill(probe.home, 's');
      engine.state.write((ctx) => {
        setAppSetting(ctx, 'trust', 'on');
      });
      const seen = recordSetups();
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await engine.runner.idle();

      expect(seen[0]?.links).toEqual({});
      expect(logs.lines()).toContainEqual(
        expect.objectContaining({
          key: 'trust',
          stored: 'on',
          msg: 'a stored trust switch is not a shape 10db reads, so it reads as off',
        }),
      );
    });

    it('a switch flipped while a session runs applies from the next one', async () => {
      const probe = sandboxProbe();
      engine = await setupEngine(probe, {
        Alpha: [[{ do: 'await_signal', name: 'go' }, turn]],
        Beta: [[turn]],
      });
      builderSkill(probe.home, 's');
      const seen = recordSetups();
      const alpha = engine.addTask('Alpha', ['api']).workstream;
      engine.launch(alpha.id);
      const first = await waitFor(() => seen[0]);
      engine.state.write((ctx) => {
        setAppTrustSwitches(ctx, { ...TRUST_DEFAULTS, yourSkills: false });
      });
      const beta = engine.addTask('Beta', ['ui']).workstream;
      engine.launch(beta.id);
      const second = await waitFor(() => seen[1]);
      // The running session still reads the skill it started with.
      const yours = first.spec.setup?.plugins.find((dir) => dir.endsWith('/yours')) ?? '';
      expect(readlinkSync(join(yours, 'skills/s'))).toBe(first.links['s']);
      engine.adapter.signal('go');
      await engine.runner.idle();

      expect(first.links).toHaveProperty('s');
      expect(second.spec.setup?.plugins.some((dir) => dir.endsWith('/yours'))).toBe(false);
      expect(second.spec.prompt).not.toContain('of your skills');
    });

    it("a project definition the frontmatter reader can't take starts the session and frees the account's start", async () => {
      const probe = sandboxProbe();
      engine = await setupEngine(probe, { Alpha: [[turn]] });
      commitToRepo({
        '.claude/skills/x/SKILL.md': '---\nname: x\nconstructor: y\n---\nBody\n',
      });
      const seen = recordSetups();
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await engine.runner.idle();

      // A leaked start slot would leave this acquire pending forever.
      (await engine.startGate.acquire(engine.project.accountId))();
      expect(ws(workstream.id).state).toBe('DONE');
      expect(seen[0]?.spec.prompt).toContain(
        '- .claude/skills/x/SKILL.md: constructor removed: a lane can write this file',
      );
    });

    it('a skill link into a checkout is left out and named in the prompt and the log', async () => {
      const probe = sandboxProbe();
      const logs = captureLogs();
      engine = await setupEngine(probe, { Alpha: [[turn]] }, logs.logger);
      commitToRepo({
        'lane-skill/SKILL.md': '---\nname: lane\ndescription: written by a lane\n---\n',
      });
      mkdirSync(join(probe.home, '.claude/skills'), { recursive: true });
      symlinkSync(join(engine.repoPath, 'lane-skill'), join(probe.home, '.claude/skills/lane'));
      const seen = recordSetups();
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await engine.runner.idle();

      const prompt = seen[0]?.spec.prompt ?? '';
      expect(seen[0]?.links).toEqual({});
      expect(prompt).toContain('Left out: ~/.claude/skills/lane, see the note at the end.');
      expect(prompt).toContain(
        '- ~/.claude/skills/lane: it lies in, or holds, a folder a lane can write',
      );
      const logged = logs.lines().find((line) => line['msg'] === 'session setup left out');
      expect(logged).toMatchObject({
        workstreamId: workstream.id,
        leftOut: [
          { what: '~/.claude/skills/lane', why: 'it lies in, or holds, a folder a lane can write' },
        ],
      });
    });
  });

  describe('the web in a lane', () => {
    const fetchCall = {
      toolName: 'WebFetch',
      input: { url: 'https://example.net/', prompt: 'x' },
      reportedMode: 'auto' as const,
    };

    // T4 call 2: on the rules floor a web call is a skip, recorded by its call id, and the lane goes on.
    it("a rules-floor lane's WebFetch is skipped and recorded, and the lane goes on to its end", async () => {
      const probe = sandboxProbe();
      engine = await createTestEngine(
        { Alpha: [[{ do: 'tool', ...fetchCall }, turn]] },
        {},
        { laneSandbox: probe.laneSandbox, codexLaneTempRoot: probe.codexLanes },
        RULES_FLOOR_ACCOUNT,
      );
      confirmRulesFloorIdentity();
      const specs = recordSpecs();
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      const spec = await waitFor(() => specs[0]);
      expect(spec.profile.lanePermissionMode).toBe('auto');
      // A lane nobody watches waits on no card: the floor's line says a refused call is skipped.
      expect(spec.prompt).toContain('A call 10db or auto mode refuses with "Skipped:" is left out');
      await engine.runner.idle();

      expect(ws(workstream.id).state).toBe('DONE');
      expect(skipsOf(workstream.id)).toEqual([
        {
          toolName: 'WebFetch',
          summary: 'https://example.net/',
          kind: 'web_or_mcp',
          source: 'guard',
        },
      ]);
      expect(
        engine.store.db
          .select({ id: schema.skippedActions.toolUseId })
          .from(schema.skippedActions)
          .all(),
      ).toEqual([{ id: 'fake-tool-0' }]);
      expect(everWaited(workstream.id)).toBe(false);
    });

    it('a subscription lane in auto mode runs WebFetch without a card', async () => {
      const probe = sandboxProbe();
      engine = await createTestEngine(
        { Alpha: [[turn]] },
        {},
        { laneSandbox: probe.laneSandbox, codexLaneTempRoot: probe.codexLanes },
        { account: { kind: 'claude_subscription', label: 'Plan' } },
      );
      engine.state.write((ctx) =>
        patchAccount(ctx, engine.project.accountId, { expectedIdentity: 'me@example.com' }),
      );
      const specs = recordSpecs();
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      const spec = await waitFor(() => specs[0]);
      expect(spec.profile.lanePermissionMode).toBe('auto');
      expect(spec.preToolUse(fetchCall).decision).toBe('allow');
      expect(spec.profile.allowedTools).not.toContain('WebFetch');
      expect(spec.prompt).toContain("WebSearch and WebFetch go to auto mode's judge");
      await engine.runner.idle();
    });

    // T4 call 2: with the Web switch off no judge sees a web call, so a lane skips it.
    it('a subscription lane with the Web switch off skips WebFetch, never handing it to the classifier', async () => {
      const probe = sandboxProbe();
      engine = await createTestEngine(
        { Alpha: [[turn]] },
        {},
        { laneSandbox: probe.laneSandbox, codexLaneTempRoot: probe.codexLanes },
        { account: { kind: 'claude_subscription', label: 'Plan' } },
      );
      engine.state.write((ctx) => {
        patchAccount(ctx, engine.project.accountId, { expectedIdentity: 'me@example.com' });
        setAppTrustSwitches(ctx, { ...TRUST_DEFAULTS, web: false });
      });
      const specs = recordSpecs();
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      const spec = await waitFor(() => specs[0]);
      expect(spec.preToolUse(fetchCall).decision).toBe('deny');
      expect(skipsOf(workstream.id)).toMatchObject([{ toolName: 'WebFetch', kind: 'web_or_mcp' }]);
      await engine.runner.idle();
    });
  });

  describe('a lane judged by auto mode', () => {
    const deploy = {
      toolName: 'Bash',
      input: { command: 'npx vercel deploy --prod --yes' },
      reportedMode: 'auto' as const,
    };
    const PLAN: Parameters<typeof createTestEngine>[3] = {
      account: { kind: 'claude_subscription', label: 'Plan' },
    };
    const start = async (
      setup: Parameters<typeof createTestEngine>[3],
      project: Parameters<typeof createTestEngine>[1] = {},
      book: FakeScriptBook = { Alpha: [[turn]] },
      flow?: string,
    ) => {
      const probe = sandboxProbe();
      engine = await createTestEngine(
        book,
        project,
        { laneSandbox: probe.laneSandbox, codexLaneTempRoot: probe.codexLanes },
        setup,
      );
      if (setup?.account?.kind === 'claude_subscription') {
        engine.state.write((ctx) =>
          patchAccount(ctx, engine.project.accountId, { expectedIdentity: 'me@example.com' }),
        );
      }
      if (setup === RULES_FLOOR_ACCOUNT) confirmRulesFloorIdentity();
      const specs = recordSpecs();
      const { task, workstream } = engine.addTask(
        'Alpha',
        ['api'],
        [],
        flow === undefined ? undefined : { flow },
      );
      return { specs, task, workstream };
    };
    const FLOOR_PREFIXES = ["10db's rules judge", 'Claude Code stopped running in auto mode'];
    /** The floor notices a task's thread holds. */
    const floorNotices = (taskId: Parameters<typeof listTaskThread>[1]): string[] =>
      listTaskThread(engine.store.db, taskId)
        .map((message) => message.body)
        .filter((body) => FLOOR_PREFIXES.some((prefix) => body.startsWith(prefix)));
    const RULES_FLOOR_NOTICE =
      "10db's rules judge this session: 10db's judge needs an account that can power Decisions and its Limits switch on in Settings › Decisions. A call those rules can't settle is skipped, not asked about.";

    it('a subscription lane on claude-sonnet-5-5 leaves a deploy to its judge, and the project’s live systems reach the spec', async () => {
      const { specs, task, workstream } = await start(PLAN);
      engine.state.write((ctx) => {
        setProjectLiveSystems(ctx, engine.project.id, [
          'the production database on db.example.com',
        ]);
      });
      engine.launch(workstream.id);
      const spec = await waitFor(() => specs[0]);
      expect(spec.model).toBe('claude-sonnet-5-5');
      expect(spec.preToolUse(deploy).decision).toBe('allow');
      expect(spec.policy.surface).toBe('lane');
      expect(spec.policy.attended).toBe(false);
      expect(
        spec.policy.environment.some((line) =>
          line.includes('"the production database on db.example.com"'),
        ),
      ).toBe(true);
      await engine.runner.idle();
      expect(listInbox(engine.store.db, { states: ['OPEN'] })).toEqual([]);
      expect(floorNotices(task.id)).toEqual([]);
    });

    // T4 Task 6: an unattended lane's denial is a skip, not only a log line.
    it("a lane's denial makes no notice and is one skip with a null limit", async () => {
      const { task, workstream } = await start(
        PLAN,
        {},
        {
          Alpha: [
            [
              {
                do: 'judge_denied' as const,
                toolName: 'Bash',
                summary: 'npx vercel deploy --prod --yes',
                reason: 'The classifier judged this action dangerous',
                by: 'classifier' as const,
              },
              turn,
            ],
          ],
        },
      );
      engine.launch(workstream.id);
      await engine.runner.idle();
      expect(
        listTaskThread(engine.store.db, task.id).filter((m) =>
          m.body.startsWith('Auto mode stopped'),
        ),
      ).toEqual([]);
      expect(listSessions(engine.store.db, workstream.id).length).toBeGreaterThan(0);
      expect(listSkipsForWorkstream(engine.store.db, workstream.id)).toMatchObject([
        {
          toolName: 'Bash',
          summary: 'npx vercel deploy --prod --yes',
          kind: 'classifier',
          source: 'auto_mode',
          limit: null,
          reason: 'The classifier judged this action dangerous',
        },
      ]);
    });

    // T4 call 9: one row per call, whichever channel reports it first.
    it('a safety check denying a call the guard already skipped stays one row', async () => {
      const { workstream } = await start(
        PLAN,
        {},
        {
          Alpha: [
            [
              shell('SUB=add; pnpm $SUB left-pad'),
              {
                do: 'judge_denied' as const,
                toolName: 'Bash',
                summary: 'SUB=add; pnpm $SUB left-pad',
                reason: 'Only a person may approve this',
                by: 'safety_check' as const,
                toolUseId: 'fake-tool-0',
              },
              turn,
            ],
          ],
        },
      );
      engine.launch(workstream.id);
      await engine.runner.idle();
      expect(listSkipsForWorkstream(engine.store.db, workstream.id)).toHaveLength(1);
    });

    it('a rules-floor lane refuses the same deploy and says why once', async () => {
      const { specs, task, workstream } = await start(
        RULES_FLOOR_ACCOUNT,
        {},
        {
          Alpha: [
            [write('src/api/a.txt', 'one'), commit('op-floor-0001', ['src/api/a.txt']), turn],
            [
              {
                do: 'mcp' as const,
                tool: 'complete_step',
                args: { opId: 'op-floor-0002', summary: 'Looks right.', verdict: 'approve' },
              },
              turn,
            ],
          ],
        },
        'standard',
      );
      engine.launch(workstream.id);
      const spec = await waitFor(() => specs[0]);
      expect(spec.preToolUse(deploy).decision).toBe('deny');
      for (let i = 0; i < 10 && ws(workstream.id).state !== 'DONE'; i += 1) {
        await engine.runner.idle();
        if (ws(workstream.id).state !== 'DONE') engine.launch(workstream.id);
      }
      expect(listSessions(engine.store.db, workstream.id).length).toBeGreaterThan(1);
      expect(floorNotices(task.id)).toEqual([RULES_FLOOR_NOTICE]);
    });

    it('with lane auto mode off, a subscription lane refuses it', async () => {
      const { specs, task, workstream } = await start(PLAN);
      engine.state.write((ctx) => {
        setLaneAutoMode(ctx, false);
      });
      engine.launch(workstream.id);
      const spec = await waitFor(() => specs[0]);
      expect(spec.preToolUse(deploy).decision).toBe('deny');
      await engine.runner.idle();
      expect(floorNotices(task.id)).toEqual([
        '10db\'s rules judge this session, not auto mode: "Lanes decide routine permissions" is off in Settings. A call those rules can\'t settle waits on a card.',
      ]);
    });

    it('a call reported outside auto mode is refused, and the thread says Claude Code left auto mode', async () => {
      const { task, workstream } = await start(
        PLAN,
        {},
        {
          Alpha: [
            [{ ...shell('npx vercel deploy --prod --yes'), reportedMode: 'other' as const }, turn],
          ],
        },
      );
      engine.launch(workstream.id);
      await engine.runner.idle();
      expect(engine.adapter.observations.map((o) => o.kind)).toContain('denied_by_guard');
      expect(floorNotices(task.id)).toEqual([
        "Claude Code stopped running in auto mode during this session, so 10db's rules judge its calls from here. A call those rules can't settle waits on a card.",
      ]);
    });

    it("a project allowing kubectl runs kubectl apply in a judged lane: the builder's allow rule wins", async () => {
      const { specs, workstream } = await start(PLAN, { allowedCommands: ['kubectl'] });
      engine.launch(workstream.id);
      const spec = await waitFor(() => specs[0]);
      const apply = { ...deploy, input: { command: 'kubectl apply -f deploy.yaml' } };
      const verdict = spec.preToolUse(apply);
      expect(
        verdict.decision === 'allow' && 'settled' in verdict ? verdict.settled : null,
      ).toContain('allow rule');
      const unlisted = { ...deploy, input: { command: 'vercel deploy --prod' } };
      expect(spec.preToolUse(unlisted)).toEqual({ decision: 'allow' });
      await engine.runner.idle();
    });
  });

  describe("a lane on 10db's judge", () => {
    let states: string[];
    /**
     * What 10db's judge's model answers for a state: `allow` (every limit unlikely), a limit's name (that one
     * likely), or `fail` for an HTTP failure.
     */
    let answer: (state: string) => string;
    const judgeFetch: typeof fetch = (_input, init) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        state?: unknown;
        questions?: Record<string, unknown>;
      };
      const state = JSON.stringify(body.state ?? '');
      states.push(state);
      const choice = answer(state);
      if (choice === 'fail') return Promise.resolve(new Response('{}', { status: 500 }));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            model: 'typesafe/jev-1.13',
            answers: Object.fromEntries(
              Object.keys(body.questions ?? {}).map((id) => [
                id,
                { type: 'noul', noul: id === choice ? 0.95 : 0.02 },
              ]),
            ),
            usage: { cost: 0 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    };
    const start = async (
      setup: Parameters<typeof createTestEngine>[3] = RULES_FLOOR_ACCOUNT,
      project: Parameters<typeof createTestEngine>[1] = {},
      launchId?: string,
    ) => {
      const probe = sandboxProbe();
      engine = await createTestEngine(
        { Alpha: [[turn]] },
        project,
        { laneSandbox: probe.laneSandbox, codexLaneTempRoot: probe.codexLanes },
        { ...setup, openRouter: { fetch: judgeFetch } },
      );
      if (setup.account?.kind === 'claude_subscription')
        engine.state.write((ctx) =>
          patchAccount(ctx, engine.project.accountId, { expectedIdentity: 'me@example.com' }),
        );
      if (setup === RULES_FLOOR_ACCOUNT) confirmRulesFloorIdentity();
      // The account launches the planned model under an older id, which auto mode does not judge.
      if (launchId !== undefined)
        engine.state.write((ctx) =>
          replaceAccountModels(ctx, engine.project.accountId, [
            {
              model: 'claude-sonnet-5-5',
              family: null,
              launchId,
              efforts: [],
              inputPrice: null,
              outputPrice: null,
            },
          ]),
        );
      const specs = recordSpecs();
      const { task, workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      const spec = await waitFor(() => specs[0]);
      const judgeCall = spec.judgeCall;
      if (judgeCall === undefined) throw new Error('the lane has no session judge');
      return { spec, judgeCall, task, workstream };
    };
    const call = (
      toolName: string,
      input: Record<string, unknown>,
      toolUseId: string,
    ): JudgedCallRequest => ({
      toolName,
      input,
      toolUseId,
      signal: new AbortController().signal,
      hunk: null,
    });
    const bash = (command: string, toolUseId: string) => call('Bash', { command }, toolUseId);
    /** The guard, then the session judge, as the hook runs them. */
    const hook = async (
      spec: LaneSessionSpec,
      judgeCall: NonNullable<LaneSessionSpec['judgeCall']>,
      req: JudgedCallRequest,
    ) => {
      const verdict = spec.preToolUse({ ...req, toolUseId: req.toolUseId ?? undefined });
      return verdict.decision === 'allow' && !('settled' in verdict && verdict.settled)
        ? judgeCall(req)
        : verdict;
    };

    beforeEach(() => {
      states = [];
      answer = () => 'allow';
    });

    // A Claude Code lane auto mode does not judge: Bedrock on a model older than auto mode supports.
    const CLAUDE_JUDGED_ACCOUNT: Parameters<typeof createTestEngine>[3] = {
      account: {
        kind: 'bedrock',
        label: 'Bedrock',
        settings: { region: 'us-west-2', awsProfile: 'dev' },
      },
    };

    it('a Claude Code lane auto mode does not judge runs pnpm test and WebFetch after the judge allows them, with no card, in default mode, sends a grep -rn over a checkout holding .env to the model, and its deploy is a tendb_judge skip, with no Inbox card', async () => {
      const { spec, judgeCall, workstream } = await start(
        CLAUDE_JUDGED_ACCOUNT,
        {},
        'claude-sonnet-4-5',
      );
      expect(spec.profile.lanePermissionMode).toBe('default');
      expect(spec.prompt).toContain("10db's judge checks each call against four limits");
      expect(await hook(spec, judgeCall, bash('pnpm test', 'toolu_1'))).toEqual({
        decision: 'allow',
        settled: "Allowed by 10db's judge",
      });
      expect(states).toHaveLength(1);
      expect(listInbox(engine.store.db, { states: ['OPEN'] })).toEqual([]);

      const fetched = await hook(
        spec,
        judgeCall,
        call('WebFetch', { url: 'https://example.net/', prompt: 'x' }, 'toolu_3'),
      );
      expect(fetched).toEqual({ decision: 'allow', settled: "Allowed by 10db's judge" });
      expect(skipsOf(workstream.id)).toEqual([]);

      writeFileSync(join(spec.cwd, '.env'), 'KEY=1\n');
      const asked = states.length;
      await hook(spec, judgeCall, bash('grep -rn KEY .', 'toolu_4'));
      expect(states).toHaveLength(asked + 1);
      expect(states.at(-1)).toContain('grep -rn KEY .');

      answer = () => 'writes_live';
      const verdict = await hook(spec, judgeCall, bash('vercel deploy --prod', 'toolu_2'));
      expect(verdict.decision).toBe('deny');
      expect(verdict.decision === 'deny' ? verdict.reason : '').toMatch(/^Skipped:/);
      expect(skipsOf(workstream.id)).toEqual([
        {
          toolName: 'Bash',
          summary: 'vercel deploy --prod',
          kind: 'classifier',
          source: 'tendb_judge',
        },
      ]);
      expect(listInbox(engine.store.db, { states: ['OPEN'] })).toEqual([]);
      await engine.runner.idle();
    });

    it("a rules-floor lane's call the project's allowed commands cover runs with no model; the step's own list settles nothing", async () => {
      const { spec, judgeCall } = await start(RULES_FLOOR_ACCOUNT, { allowedCommands: ['psql'] });
      expect(await hook(spec, judgeCall, bash('psql -c "select 1"', 'toolu_20'))).toEqual({
        decision: 'allow',
        settled: "The builder's allow rule covers this call, so it runs, as in Claude Code.",
      });
      expect(states).toEqual([]);
      // The step's own list (`Bash(git log:*)`) is not the builder's: its call still reaches the model.
      await hook(spec, judgeCall, bash('git log -p', 'toolu_21'));
      expect(states).toHaveLength(1);
      await engine.runner.idle();
    });

    it('OpenRouter failing mid-session: the next deploy is a skipped_actions row, the lane never waits, and the thread says so once', async () => {
      const { spec, judgeCall, task, workstream } = await start();
      await hook(spec, judgeCall, bash('pnpm test', 'toolu_5'));
      answer = () => 'fail';
      await hook(spec, judgeCall, bash('vercel deploy --prod', 'toolu_6'));
      await hook(spec, judgeCall, bash('vercel deploy --prod --force', 'toolu_7'));
      expect(skipsOf(workstream.id).map((s) => s.source)).toEqual(['guard', 'guard']);
      expect(ws(workstream.id).state).not.toBe('WAITING_HUMAN');
      expect(
        listTaskThread(engine.store.db, task.id).filter((m) =>
          m.body.startsWith("10db's judge didn't answer"),
        ),
      ).toHaveLength(1);
      await engine.runner.idle();
    });

    it("a native lane's call reported outside auto mode is judged by 10db's judge", async () => {
      const { spec, judgeCall } = await start({
        account: { kind: 'claude_subscription', label: 'Plan' },
      });
      expect(spec.profile.lanePermissionMode).toBe('auto');
      await hook(spec, judgeCall, { ...bash('pnpm test', 'toolu_8'), reportedMode: 'other' });
      expect(states).toHaveLength(1);
      await hook(spec, judgeCall, { ...bash('pnpm build', 'toolu_9'), reportedMode: 'auto' });
      expect(states).toHaveLength(1);
      await engine.runner.idle();
    });

    const CODEX: Parameters<typeof createTestEngine>[3] = {
      account: { kind: 'codex_signin', label: 'ChatGPT plan' },
    };
    const startCodex = async (switches: { web: boolean } = { web: true }) => {
      const probe = sandboxProbe();
      engine = await createTestEngine(
        { Alpha: [[turn]] },
        {},
        { laneSandbox: probe.laneSandbox, codexLaneTempRoot: probe.codexLanes },
        { ...CODEX, openRouter: { fetch: judgeFetch } },
      );
      engine.state.write((ctx) =>
        patchAccount(ctx, engine.project.accountId, {
          expectedIdentity: 'chatgpt@example.com · ws-1',
        }),
      );
      engine.state.write((ctx) => {
        setAppTrustSwitches(ctx, { ...TRUST_DEFAULTS, ...switches });
      });
      const specs = recordSpecs();
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      const spec = await waitFor(() => specs[0]);
      const judgeCall = spec.judgeCall;
      if (judgeCall === undefined) throw new Error('the lane has no session judge');
      return { spec, judgeCall, workstream };
    };

    it("a Codex lane's patch that deletes a file reaches the model with the hunk named, and its deploy is a tendb_judge skip, with web search live under the Web switch", async () => {
      const { spec, judgeCall, workstream } = await startCodex();
      expect(spec.webSearch).toBe('live');
      await hook(spec, judgeCall, {
        ...call('Edit', { file_path: join(spec.cwd, 'src', 'api', 'a.txt') }, 'call_2'),
        hunk: 'delete',
      });
      expect(states).toHaveLength(1);
      expect(states[0]).toContain('"patch":"deletes the file"');
      answer = () => 'writes_live';
      await hook(spec, judgeCall, bash('vercel deploy --prod', 'call_1'));
      expect(skipsOf(workstream.id).map((s) => s.source)).toEqual(['tendb_judge']);
      await engine.runner.idle();
    });

    it("a Codex lane's web search is disabled with the Web switch off", async () => {
      const { spec } = await startCodex({ web: false });
      expect(spec.webSearch).toBe('disabled');
    });

    it('an auto mode denial is a judge_calls row with the auto mode model', async () => {
      const probe = sandboxProbe();
      engine = await createTestEngine(
        {
          Alpha: [
            [
              {
                do: 'judge_denied' as const,
                toolName: 'Bash',
                summary: 'npx vercel deploy --prod --yes',
                reason: 'The classifier judged this action dangerous',
                by: 'classifier' as const,
              },
              turn,
            ],
          ],
        },
        {},
        { laneSandbox: probe.laneSandbox, codexLaneTempRoot: probe.codexLanes },
        { account: { kind: 'claude_subscription', label: 'Plan' } },
      );
      engine.state.write((ctx) =>
        patchAccount(ctx, engine.project.accountId, { expectedIdentity: 'me@example.com' }),
      );
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await engine.runner.idle();
      expect(listJudgeCalls(engine.store.db, 10)).toMatchObject([
        {
          decision: 'crosses_limit',
          model: 'claude-code-auto-mode',
          answer: 'limit',
          outcome: 'acted',
          workstreamId: workstream.id,
        },
      ]);
    });
  });

  /** A subscription session starts only on an account whose identity was confirmed. */
  const confirmIdentity = (): void => {
    engine.state.write((ctx) =>
      patchAccount(ctx, engine.project.accountId, { expectedIdentity: 'me@example.com' }),
    );
  };

  it('builds a lane sandbox on the account home for a ChatGPT account, and makes its temp dir under the Codex lanes root', async () => {
    const probe = sandboxProbe();
    engine = await createTestEngine(
      { Alpha: [[turn]] },
      {},
      { laneSandbox: probe.laneSandbox, codexLaneTempRoot: probe.codexLanes },
      { account: { kind: 'codex_signin', label: 'ChatGPT plan' } },
    );
    confirmIdentity();
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();

    const [seen] = probe.inputs;
    expect(seen?.configDir).toBe(engine.store.db.select().from(schema.accounts).get()?.configDir);
    expect(seen?.configDir).not.toBe(join(homedir(), '.claude'));
    expect(seen?.env['CODEX_HOME']).toBe(seen?.configDir);
    // A ChatGPT lane's temp dir is kept apart from Claude lanes', in the root the daemon names.
    expect(seen?.tempRoot).toBe(probe.codexLanes);
    expect(seen?.provider).toBe('codex');
    expect(dirname(probe.sessions[0]?.tmpDir ?? '')).toBe(probe.codexLanes);
    expect(readdirSync(probe.tmpRoot)).toEqual([]);
    expect(readdirSync(probe.codexLanes)).toEqual([]);
  });

  // T4 call 2: Codex's guard hook carries the call's id, and an unknown tool on the rules floor is a skip.
  it("a codex lane's unknown tool is skipped and recorded by its call id", async () => {
    const probe = sandboxProbe();
    engine = await createTestEngine(
      { Alpha: [[{ do: 'hang' }]] },
      {},
      { laneSandbox: probe.laneSandbox, codexLaneTempRoot: probe.codexLanes },
      { account: { kind: 'codex_signin', label: 'ChatGPT plan' } },
    );
    confirmIdentity();
    const specs = recordSpecs();
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const spec = await waitFor(() => specs[0]);
    const verdict = spec.preToolUse({
      toolName: 'frobnicate',
      input: { x: 1 },
      toolUseId: 'call-1',
    });
    expect(verdict.decision === 'deny' && verdict.reason.startsWith('Skipped: ')).toBe(true);
    expect(skipsOf(workstream.id)).toMatchObject([
      { toolName: 'frobnicate', kind: 'unknown_tool', source: 'guard' },
    ]);
    expect(
      engine.store.db
        .select({ id: schema.skippedActions.toolUseId })
        .from(schema.skippedActions)
        .all(),
    ).toEqual([{ id: 'call-1' }]);
    await engine.runner.cancel(workstream.id);
  });

  describe('the processes a session’s commands start', () => {
    const STARTED = 'Thu Oct 30 12:00:00 2026';
    /** claude (4000), a command's shell (4001) and two loops that outlive both (4002, 4003). */
    let rows: { pid: number; ppid: number; pgid: number; startedAt: string }[];
    const fakeProcesses = (): LaneProcessSetup => ({
      table: () => Promise.resolve(rows.map((r) => ({ ...r }))),
      signal: (target) => {
        rows = rows.filter((r) => (target < 0 ? r.pgid !== -target : r.pid !== target));
        return true;
      },
      sleep: () => Promise.resolve(),
      ownPid: 1,
      intervalMs: 3_600_000,
    });
    beforeEach(() => {
      rows = [
        { pid: 4000, ppid: 1, pgid: 4000, startedAt: STARTED },
        { pid: 4001, ppid: 4000, pgid: 4001, startedAt: STARTED },
        { pid: 4002, ppid: 4001, pgid: 4001, startedAt: STARTED },
        { pid: 4003, ppid: 4001, pgid: 4001, startedAt: STARTED },
      ];
    });
    /** Reports claude's pid at `started`, as the real adapter does. */
    const reportPid = () => {
      const real = engine.adapter.open.bind(engine.adapter);
      return vi.spyOn(engine.adapter, 'open').mockImplementation((spec) => {
        const handle = real(spec);
        return {
          ...handle,
          events: (async function* () {
            for await (const event of handle.events) {
              yield event.type === 'started' ? { ...event, pid: 4000 } : event;
            }
          })(),
        };
      });
    };

    it('are stopped when the session ends, before its temp dir goes', async () => {
      const probe = sandboxProbe(undefined, fakeProcesses());
      engine = await createTestEngine(
        { Alpha: [[turn]] },
        {},
        { laneSandbox: probe.laneSandbox, identifyProcess: () => Promise.resolve(STARTED) },
      );
      reportPid();
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await engine.runner.idle();

      expect(ws(workstream.id).state).toBe('DONE');
      expect(rows).toEqual([]);
      expect(readdirSync(probe.tmpRoot)).toEqual([]);
    });

    it('are stopped even when the session’s start time could not be read at `started`', async () => {
      const probe = sandboxProbe(undefined, fakeProcesses());
      engine = await createTestEngine(
        { Alpha: [[turn]] },
        {},
        // One failed `ps` as the session started, as an overloaded Mac can give.
        { laneSandbox: probe.laneSandbox, identifyProcess: () => Promise.resolve(null) },
      );
      reportPid();
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await engine.runner.idle();

      expect(ws(workstream.id).state).toBe('DONE');
      expect(rows).toEqual([]);
    });

    it('logs a warning when the session’s processes cannot be watched, and again when they cannot be stopped', async () => {
      const logs = captureLogs();
      const probe = sandboxProbe(undefined, {
        ...fakeProcesses(),
        table: () => Promise.reject(new Error('ps: fork failed')),
      });
      engine = await createTestEngine(
        { Alpha: [[turn]] },
        {},
        {
          laneSandbox: probe.laneSandbox,
          identifyProcess: () => Promise.resolve(null),
          logger: logs.logger,
        },
      );
      reportPid();
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await engine.runner.idle();

      const warnings = logs
        .lines()
        .filter((line) => line['level'] === 40)
        .map((line) => String(line['msg']));
      expect(warnings).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/process could not be read/),
          'the processes a lane session started could not be stopped',
        ]),
      );
      expect(ws(workstream.id).state).toBe('DONE');
    });

    it('are stopped when the session is stopped, as the daemon stopping does', async () => {
      const probe = sandboxProbe(undefined, fakeProcesses());
      engine = await createTestEngine(
        { Alpha: [[{ do: 'hang' }]] },
        {},
        { laneSandbox: probe.laneSandbox, identifyProcess: () => Promise.resolve(STARTED) },
      );
      reportPid();
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await waitFor(() => ws(workstream.id).state === 'RUNNING');
      expect(rows).toHaveLength(4);
      await engine.runner.stopAll('shutdown');
      await engine.runner.idle();

      expect(rows).toEqual([]);
    });
  });

  it("records the session's temp dir while it runs, for the load guard to name a lane by, and forgets it once the dir is gone", async () => {
    const probe = sandboxProbe();
    const recorded = new Map<string, string>();
    const seen: string[] = [];
    engine = await createTestEngine(
      { Alpha: [[turn]] },
      {},
      {
        laneSandbox: probe.laneSandbox,
        laneTempDirs: {
          set: (id, dir) => {
            recorded.set(id, dir);
            seen.push(dir);
          },
          delete: (id) => {
            recorded.delete(id);
          },
        },
      },
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(seen).toEqual(probe.sessions.map((s) => s.tmpDir));
    expect(seen).toHaveLength(1);
    expect(recorded.size).toBe(0);
  });

  it("hands Claude Code an approved stdio server only as its launch under srt, and removes its sandbox with the session's", async () => {
    const probe = sandboxProbe();
    engine = await createTestEngine(
      { Alpha: [[turn]], Beta: [[turn]] },
      {},
      { laneSandbox: probe.laneSandbox, ...launcherOver({ PATH: '/usr/bin:/bin', HOME: '/h' }) },
    );
    const mantine = { command: 'npx', args: ['-y', '@mantine/mcp-server@9.7.2'] };
    const docs = { type: 'http', url: 'https://docs.example/mcp' };
    writeFileSync(
      join(engine.repoPath, '.mcp.json'),
      JSON.stringify({ mcpServers: { mantine, docs } }),
    );
    const specs = recordSpecs();
    const first = engine.addTask('Alpha');
    engine.launch(first.workstream.id);
    await engine.runner.idle();
    for (const card of listInbox(engine.store.db, { states: ['OPEN'] }))
      if (card.detail?.[MCP_APPROVAL_DETAIL] !== undefined)
        engine.inbox.answer(card.id, { choice: 'approve' });
    const second = engine.addTask('Beta');
    engine.launch(second.workstream.id);
    await engine.runner.idle();

    expect(probe.inputs.map((input) => input.mcpServers)).toEqual([
      {},
      {
        mantine: {
          type: 'stdio',
          ...mantine,
          env: { PATH: '/usr/bin:/bin', HOME: '/h' },
          hosts: [],
        },
      },
    ]);
    const servers = specs[1]?.projectMcpServers;
    expect(servers?.['docs']).toEqual({ ...docs, headers: null });
    expect(servers?.['mantine']).toBe(probe.sessions[1]?.mcpServers['mantine']);
    const mantineServer = servers?.['mantine'];
    if (!(mantineServer instanceof SandboxedMcpServer)) throw new Error('mantine is not sandboxed');
    expect(mantineServer.launch().command).toBe('/usr/bin/env');
    expect(mantineServer.launch().args).toContain(FAKE_SRT.cli);
    expect(readdirSync(probe.tmpRoot)).toEqual([]);
  });

  it('puts no approved value on a command line: a server that wants one in its args is ignored, one with it in env gets it sealed', async () => {
    const probe = sandboxProbe();
    engine = await createTestEngine(
      { Alpha: [[turn]], Beta: [[turn]] },
      {},
      {
        laneSandbox: probe.laneSandbox,
        ...launcherOver({ PATH: '/usr/bin:/bin', HOME: '/h', DOCS_TOKEN: 'tok-on-argv' }),
      },
    );
    const inArgs = { command: 'node', args: ['x.mjs', '--token', '${DOCS_TOKEN}'] };
    const inEnv = { command: 'node', args: ['x.mjs'], env: { DOCS_TOKEN: '${DOCS_TOKEN}' } };
    writeFileSync(
      join(engine.repoPath, '.mcp.json'),
      JSON.stringify({ mcpServers: { inArgs, inEnv } }),
    );
    const specs = recordSpecs();
    const first = engine.addTask('Alpha');
    engine.launch(first.workstream.id);
    await engine.runner.idle();
    for (const card of listInbox(engine.store.db, { states: ['OPEN'] }))
      if (card.detail?.[MCP_APPROVAL_DETAIL] !== undefined)
        engine.inbox.answer(card.id, { choice: 'approve' });
    const second = engine.addTask('Beta');
    engine.launch(second.workstream.id);
    await engine.runner.idle();

    const servers = specs[1]?.projectMcpServers ?? {};
    expect(Object.keys(servers)).toEqual(['inEnv']);
    const launch =
      servers['inEnv'] instanceof SandboxedMcpServer ? servers['inEnv'].launch() : null;
    expect(launch?.command).toBe('/usr/bin/env');
    expect(JSON.stringify(launch)).not.toContain('tok-on-argv');
    expect(
      listInbox(engine.store.db, { states: ['OPEN'] }).some((item) =>
        item.body.includes('server "inArgs" uses "${" in its command or args'),
      ),
    ).toBe(true);
  });

  it("starts the session without a stdio server whose sandbox can't be built, and names it in the prompt and a card", async () => {
    const probe = sandboxProbe();
    engine = await createTestEngine(
      { Alpha: [[turn]], Beta: [[turn]] },
      {},
      {
        laneSandbox: probe.laneSandbox,
        ...launcherOver({ PATH: '/usr/bin:/bin', HOME: '/h', DOCS_TOKEN: 'line-one\nline-two' }),
      },
    );
    const mantine = { command: 'npx', args: ['-y', '@mantine/mcp-server@9.7.2'] };
    const broken = { command: 'node', args: ['x.mjs'], env: { DOCS_TOKEN: '${DOCS_TOKEN}' } };
    writeFileSync(
      join(engine.repoPath, '.mcp.json'),
      JSON.stringify({ mcpServers: { mantine, broken } }),
    );
    const specs = recordSpecs();
    const first = engine.addTask('Alpha');
    engine.launch(first.workstream.id);
    await engine.runner.idle();
    for (const card of listInbox(engine.store.db, { states: ['OPEN'] }))
      if (card.detail?.[MCP_APPROVAL_DETAIL] !== undefined)
        engine.inbox.answer(card.id, { choice: 'approve' });
    const second = engine.addTask('Beta');
    engine.launch(second.workstream.id);
    await engine.runner.idle();

    expect(ws(second.workstream.id).state).toBe('DONE');
    expect(Object.keys(specs[1]?.projectMcpServers ?? {})).toEqual(['mantine']);
    expect(specs[1]?.prompt).toContain("broken (its config can't be used as written)");
    const card = listInbox(engine.store.db, { states: ['OPEN'] }).find(
      (item) => item.title === `The repo's MCP server "broken" can't run as written`,
    );
    expect(card?.body).toContain('DOCS_TOKEN');
    expect(JSON.stringify(card)).not.toContain('line-one');
    expect(readdirSync(probe.tmpRoot)).toEqual([]);
  });

  it('with the lane sandbox null or absent, a session gets no sandbox and the unscoped tools', async () => {
    // Each row is an engine option, so each boots its own lane.
    for (const [i, [name, overrides]] of (
      [
        ['null', { laneSandbox: null }],
        ['absent', {}],
      ] as const
    ).entries()) {
      if (i > 0) await engine.close();
      engine = await createTestEngine({ Alpha: [[turn]] }, {}, overrides);
      const specs = recordSpecs();
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await engine.runner.idle();
      expect.soft(specs[0]?.sandbox, name).toBeNull();
      expect
        .soft(specs[0]?.profile.allowedTools, name)
        .toEqual(allowedToolsFor(engine.project, ToolAccess.Edit));
      expect.soft(specs[0]?.prompt, name).not.toContain('mktemp');
    }
  });

  it("reads the app-wide auto mode setting and the project's localhost switch when each session starts, so a change applies at the next one", async () => {
    const probe = sandboxProbe();
    engine = await createTestEngine(
      { Alpha: [[turn]], Beta: [[turn]] },
      {},
      { laneSandbox: probe.laneSandbox },
    );
    const specs = recordSpecs();
    const first = engine.addTask('Alpha');
    engine.launch(first.workstream.id);
    await engine.runner.idle();
    engine.state.write((ctx) => {
      setLaneAutoMode(ctx, false);
    });
    engine.state.write((ctx) => patchProject(ctx, engine.project.id, { sandboxLoopback: true }));
    const second = engine.addTask('Beta');
    engine.launch(second.workstream.id);
    await engine.runner.idle();
    expect(specs.map((spec) => spec.profile.lanePermissionMode)).toEqual(['auto', 'default']);
    expect(probe.inputs.map((input) => input.project.sandboxLoopback)).toEqual([false, true]);
    expect(specs.map((spec) => spec.sandbox?.settings.network.allowLocalBinding)).toEqual([
      undefined,
      true,
    ]);
  });

  it("judges the session's file tools by real path, keeping its own saved tool results readable", async () => {
    const probe = sandboxProbe();
    engine = await createTestEngine(
      { Alpha: [[{ do: 'hang' }]] },
      {},
      { laneSandbox: probe.laneSandbox },
    );
    const specs = recordSpecs();
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const providerId = await waitFor(
      () => listSessions(engine.store.db, workstream.id)[0]?.providerSessionId ?? undefined,
    );
    const [spec] = specs;
    if (!spec) throw new Error('the session was not started');
    const results = (id: string) =>
      join(homedir(), '.claude', 'projects', 'slug', id, 'tool-results', 'out.txt');
    const read = (path: string) =>
      spec.preToolUse({ toolName: 'Read', input: { file_path: path } });
    expect(read(results(providerId))).toEqual({ decision: 'allow' });
    expect(read(results('someone-else'))).toMatchObject({ decision: 'deny' });
    // Not one of the guard's own protected paths: only the sandbox's file-access judge refuses it.
    expect(read(join(probe.home, 'Library', 'Keychains', 'login.keychain-db'))).toMatchObject({
      decision: 'deny',
    });
    await engine.runner.cancel(workstream.id);
    expect(readdirSync(probe.tmpRoot)).toEqual([]);
  });

  it('fails the workstream at once when the sandbox refuses with a SandboxProfileError or a SandboxTempDirError, writing no session', async () => {
    // Each row is a sandbox that throws its own error, so each boots its own lane.
    for (const [i, [name, error]] of (
      [
        [
          'SandboxProfileError',
          () => new SandboxProfileError('checkout', "the checkout can't be read"),
        ],
        [
          'SandboxTempDirError',
          () => new SandboxTempDirError('Could not create the lane temp directory'),
        ],
      ] as const
    ).entries()) {
      if (i > 0) {
        await engine.close();
        // The next probe takes the afterEach's place: the earlier one's dirs go here.
        if (probeRoot !== null) rmSync(probeRoot, { recursive: true, force: true });
        probeHome?.cleanup();
      }
      const probe = sandboxProbe(() => {
        throw error();
      });
      engine = await createTestEngine({ Alpha: [[turn]] }, {}, { laneSandbox: probe.laneSandbox });
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await engine.runner.idle();

      const row = ws(workstream.id);
      expect.soft(row.state, name).toBe('FAILED');
      expect.soft(row.failureReason, name).toMatch(/^The lane sandbox could not start: /);
      expect.soft(listSessions(engine.store.db, workstream.id), name).toEqual([]);
      expect.soft(engine.adapter.prompts, name).toEqual([]);
      expect
        .soft(
          transitions(workstream.id).filter((t) => t.endsWith('->RECOVERING')),
          name,
        )
        .toEqual([]);
      const cards = listInbox(engine.store.db, { states: ['OPEN'] });
      expect
        .soft(
          cards.map((card) => card.kind),
          name,
        )
        .toEqual(['flag']);
      expect.soft(cards[0]?.body, name).toMatch(/^The lane sandbox could not start: /);
      // A leaked start slot would leave this acquire pending forever.
      (await engine.startGate.acquire(engine.project.accountId))();
    }
  });

  it("frees the account's start and the temp dir when reading the lane's approved calls throws", async () => {
    const probe = sandboxProbe();
    engine = await createTestEngine({ Alpha: [[turn]] }, {}, { laneSandbox: probe.laneSandbox });
    // A real read failure: the table the approvals are read from is gone.
    engine.store.db.$client.exec('DROP TABLE skip_approvals');
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(readdirSync(probe.tmpRoot)).toEqual([]);
    // A leaked start slot would leave this acquire pending forever.
    (await engine.startGate.acquire(engine.project.accountId))();
  });

  it('leaves no temp dir behind when the adapter throws on start', async () => {
    const probe = sandboxProbe();
    engine = await createTestEngine({ Alpha: [[turn]] }, {}, { laneSandbox: probe.laneSandbox });
    engine.adapter.open = () => {
      throw new Error('spawn failed');
    };
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(probe.sessions).toHaveLength(1);
    expect(readdirSync(probe.tmpRoot)).toEqual([]);
    (await engine.startGate.acquire(engine.project.accountId))();
  });

  it('fails at once, without retrying, when Claude Code cannot start the sandbox', async () => {
    const probe = sandboxProbe();
    engine = await createTestEngine({ Alpha: [[turn]] }, {}, { laneSandbox: probe.laneSandbox });
    const refusal = 'The lane sandbox could not start: Error processing settings: ENOTDIR';
    async function* refused(): AsyncGenerator<SessionEvent> {
      yield await Promise.resolve({ type: 'ended', reason: 'sandbox_refused', message: refusal });
    }
    vi.spyOn(engine.adapter, 'open').mockImplementation(() => ({
      events: refused(),
      send: () => undefined,
      interrupt: () => Promise.resolve(null),
      stop: () => Promise.resolve(),
      setModel: () => Promise.resolve(),
    }));
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({ state: 'FAILED', failureReason: refusal });
    expect(transitions(workstream.id).filter((t) => t.endsWith('->RECOVERING'))).toEqual([]);
    expect(readdirSync(probe.tmpRoot)).toEqual([]);
  });

  it("refuses a host the project hasn't allowed and asks once, and a host card answered AllowProject after the session ended is a stored rule the next session's broker allows", async () => {
    const probe = sandboxProbe();
    const host = 'registry.example.org';
    engine = await createTestEngine(
      {
        Alpha: [[hostCall(host), hostCall(host), turn]],
        Beta: [[hostCall(host), turn]],
      },
      {},
      { laneSandbox: probe.laneSandbox },
    );
    const first = engine.addTask('Alpha');
    engine.launch(first.workstream.id);
    await engine.runner.idle();
    expect(ws(first.workstream.id).state).toBe('DONE');
    const outcomes = (title: string) =>
      engine.adapter.observations
        .filter((o) => o.title === title && o.detail['toolName'] === 'SandboxNetworkAccess')
        .map((o) => o.kind);
    expect(outcomes('Alpha')).toEqual(['tool_denied', 'tool_denied']);
    // The lane never waited on the card.
    expect(transitions(first.workstream.id).filter((t) => t.endsWith('->WAITING_HUMAN'))).toEqual(
      [],
    );
    const hostCards = listInbox(engine.store.db, { states: ['OPEN'] }).filter(
      (card) => card.kind === 'permission',
    );
    expect(hostCards.map((card) => card.title)).toEqual([`Allow network access to ${host}?`]);

    const [card] = hostCards;
    if (!card) throw new Error('no host card');
    engine.inbox.answer(card.id, { choice: 'allow_project' });

    const second = engine.addTask('Beta');
    engine.launch(second.workstream.id);
    await engine.runner.idle();
    expect(outcomes('Beta')).toEqual(['tool_allowed']);
    expect(probe.inputs[1]?.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolName: 'SandboxNetworkAccess', pattern: host }),
      ]),
    );
    expect(probe.sessions[1]?.spec.settings.network.allowedDomains).toEqual([host]);
  });
  describe('in a worktree batch', () => {
    /** A project whose batch has a real worktree made by git, as the daemon's cut would leave it. */
    function worktreeBatch() {
      const worktrees = tempDir('runner-worktrees');
      const path = join(worktrees.path, 'wt');
      execFileSync(
        'git',
        ['-C', engine.repoPath, 'worktree', 'add', '-q', '-b', 'batch/one', path],
        {
          env: isolatedGitEnv(),
          stdio: 'pipe',
        },
      );
      const batch = engine.state.write((ctx) => {
        const inserted = insertBatch(ctx, {
          projectId: engine.project.id,
          title: 'Greetings',
          baseBranch: 'main',
          worktreePath: realpathSync(path),
        });
        return transitionBatch(ctx, inserted.id, {
          to: 'OPEN',
          patch: { branch: 'batch/one', baseSha: 'x' },
        });
      });
      return {
        batch,
        path: realpathSync(path),
        cleanup: () => {
          worktrees.cleanup();
        },
      };
    }
    const realGate = createGateRunner({ sandbox: null, logger: silentLogger });
    let cleanups: (() => void)[] = [];
    afterEach(() => {
      for (const cleanup of cleanups) cleanup();
      cleanups = [];
    });
    const gateRequests: GateRequest[] = [];
    const recordingGate = {
      run: (request: GateRequest) => {
        gateRequests.push(request);
        return realGate.run(request);
      },
    };

    /** Runs one task in a worktree batch; the script is built once the main checkout's path exists. */
    async function run(
      script: (main: string) => FakeScriptBook['Alpha'],
      opts: { readonly gateCommand?: string; readonly baseUpdates?: BaseUpdates } = {},
    ) {
      const probe = sandboxProbe();
      gateRequests.length = 0;
      const book: FakeScriptBook = {};
      engine = await createTestEngine(
        book,
        {
          workspaceMode: 'worktree',
          delivery: 'pull_request',
          prTitlePrefix: 'feat(app)',
          ...(opts.gateCommand ? { gateCommand: opts.gateCommand } : {}),
        },
        {
          laneSandbox: probe.laneSandbox,
          gate: recordingGate,
          ...(opts.baseUpdates ? { baseUpdates: opts.baseUpdates } : {}),
        },
      );
      book['Alpha'] = script(realpathSync(engine.repoPath));
      const specs = recordSpecs();
      const made = worktreeBatch();
      cleanups.push(made.cleanup);
      const { workstream } = engine.addTask('Alpha', ['api'], [], undefined, made.batch.id);
      engine.launch(workstream.id);
      await engine.runner.idle();
      return { probe, specs, workstream, ...made };
    }

    it('the session and the gate run in the worktree, and the lane sandbox gets it as the checkout and every checkout in checkouts', async () => {
      const { probe, specs, workstream, path } = await run(() => [
        [write('src/api/a.txt'), commit('op-wt-gate-1', ['src/api/a.txt']), turn],
      ]);
      expect(specs.map((spec) => spec.cwd)).toEqual([path]);
      expect(probe.inputs[0]?.project.repoPath).toBe(path);
      expect(probe.inputs[0]?.checkouts).toEqual([engine.repoPath, path]);
      expect(specs[0]?.profile.allowedTools).toContain(`Read(/${realpathSync(path)}/**)`);
      expect(ws(workstream.id).state).toBe('DONE');
      expect(gateRequests.map((request) => request.project.repoPath)).toEqual([path]);
      expect(gateRequests[0]?.checkouts).toEqual([engine.repoPath, path]);
    });

    it("a shared task's session still runs in the project's checkout while a copy is live", async () => {
      const probe = sandboxProbe();
      const book: FakeScriptBook = { Beta: [[turn]] };
      engine = await createTestEngine(
        book,
        { delivery: 'pull_request', prTitlePrefix: 'feat(app)' },
        { laneSandbox: probe.laneSandbox },
      );
      const specs = recordSpecs();
      const made = worktreeBatch();
      cleanups.push(made.cleanup);
      // A task with no batch works in Your folder, whatever copies the project holds.
      const { workstream } = engine.addTask('Beta', ['api']);
      engine.launch(workstream.id);
      await engine.runner.idle();
      expect(specs.map((spec) => realpathSync(spec.cwd))).toEqual([realpathSync(engine.repoPath)]);
      expect(probe.inputs[0]?.project.repoPath).toBe(engine.repoPath);
      expect(probe.inputs[0]?.checkouts).toEqual([engine.repoPath, made.path]);
    });

    it('a write outside the worktree is denied', async () => {
      await run((main) => [[write(join(main, 'src/api/outside.txt')), turn]]);
      const denied = engine.adapter.observations.filter((o) => o.kind === 'denied_by_guard');
      expect(denied).toHaveLength(1);
      expect(String(denied[0]?.detail['reason'])).toContain('outside');
    });

    describe("the batch's base before each gate", () => {
      const NOTE =
        'origin/main conflicts with this branch in README.md, so this gate ran without it.';

      /** Base updates that answer `answer` and record each call in `order`, beside the gates. */
      function recordingBaseUpdates(answer: BaseUpdate, order: string[]): BaseUpdates {
        return {
          beforeGate: (batchId) => {
            order.push(`base ${batchId}`);
            return Promise.resolve(answer);
          },
          gate: (batchId, _signal, run) => {
            order.push(`batch gate ${batchId}`);
            return run();
          },
          atLaunch: () => Promise.resolve({ kind: 'up_to_date', note: null }),
        };
      }

      /** Records in `order` when a gate is asked for and when its command starts, around `run`. */
      function watchGates(order: string[]): () => void {
        const gateRun = recordingGate.run;
        recordingGate.run = (request) => {
          order.push('gate asked');
          return gateRun({
            ...request,
            onSpawn: (pid) => {
              order.push('gate spawned');
              request.onSpawn?.(pid);
            },
          });
        };
        return () => {
          recordingGate.run = gateRun;
        };
      }

      it("is brought in once each gate may start, and what kept it out heads a failed gate's evidence and the fix prompt", async () => {
        const order: string[] = [];
        const restore = watchGates(order);
        try {
          const { workstream, batch } = await run(
            () => [
              [turn],
              [write('src/api/fixed.txt'), commit('op-wt-base-1', ['src/api/fixed.txt']), turn],
            ],
            {
              gateCommand: 'test -f src/api/fixed.txt || { echo MISSING-FIXED-FILE; exit 2; }',
              baseUpdates: recordingBaseUpdates({ kind: 'not_merged', note: NOTE }, order),
            },
          );
          expect(ws(workstream.id).state).toBe('QUEUED');
          const [failed] = listEvidence(engine.store.db, workstream.id);
          expect(failed?.summary.startsWith(`${NOTE}\n\n`)).toBe(true);
          expect(failed?.summary).toContain('MISSING-FIXED-FILE');

          engine.launch(workstream.id);
          await engine.runner.idle();
          expect(ws(workstream.id).state).toBe('DONE');
          expect(engine.adapter.prompts[1]?.prompt).toContain(NOTE);
          // One gate of the batch at a time; inside the gate's run, which holds its slot, and before
          // its command starts.
          const once = [`batch gate ${batch.id}`, 'gate asked', `base ${batch.id}`, 'gate spawned'];
          expect(order).toEqual([...once, ...once]);
        } finally {
          restore();
        }
      });

      it("cancels a task promptly while its gate waits for its batch's turn", async () => {
        let entered: () => void = () => undefined;
        const waiting = new Promise<void>((resolve) => {
          entered = resolve;
        });
        // A sibling's gate holds the batch's turn for as long as this test runs.
        const behindASibling: BaseUpdates = {
          beforeGate: () => Promise.resolve({ kind: 'up_to_date', note: null }),
          atLaunch: () => Promise.resolve({ kind: 'up_to_date', note: null }),
          gate: (_batchId, gateSignal) =>
            new Promise((resolve) => {
              entered();
              gateSignal.addEventListener('abort', () => {
                resolve(null);
              });
            }),
        };
        const probe = sandboxProbe();
        gateRequests.length = 0;
        const book: FakeScriptBook = {};
        engine = await createTestEngine(
          book,
          { workspaceMode: 'worktree', delivery: 'pull_request', prTitlePrefix: 'feat(app)' },
          { laneSandbox: probe.laneSandbox, gate: recordingGate, baseUpdates: behindASibling },
        );
        book['Alpha'] = [[write('src/api/a.txt'), commit('op-wt-base-3', ['src/api/a.txt']), turn]];
        const made = worktreeBatch();
        cleanups.push(made.cleanup);
        const { workstream } = engine.addTask('Alpha', ['api'], [], undefined, made.batch.id);
        engine.launch(workstream.id);
        await waiting;
        await engine.runner.cancel(workstream.id);
        await engine.runner.idle();
        expect(ws(workstream.id).state).toBe('CANCELLED');
        expect(gateRequests).toEqual([]);
        expect(listEvidence(engine.store.db, workstream.id)).toEqual([]);
      });

      it('runs no gate once shutdown stopped it: the workstream stays verifying for recovery', async () => {
        const order: string[] = [];
        const restore = watchGates(order);
        const { workstream, batch } = await run(
          () => [[write('src/api/a.txt'), commit('op-wt-base-2', ['src/api/a.txt']), turn]],
          { baseUpdates: recordingBaseUpdates({ kind: 'aborted' }, order) },
        ).finally(restore);
        expect(order).toEqual([`batch gate ${batch.id}`, 'gate asked', `base ${batch.id}`]);
        expect(ws(workstream.id)).toMatchObject({
          state: 'VERIFYING',
          nextAction: { kind: 'verify' },
        });
        expect(listEvidence(engine.store.db, workstream.id)).toEqual([]);
      });

      it('stops a broken install with a card that says so, runs no gate and counts no attempt of the task’s code', async () => {
        const order: string[] = [];
        const restore = watchGates(order);
        const note =
          'The install in this copy is broken: 3 of 9 dependencies do not resolve (.: tsx)';
        const { workstream } = await run(
          () => [[write('src/api/a.txt'), commit('op-wt-base-6', ['src/api/a.txt']), turn]],
          { baseUpdates: recordingBaseUpdates({ kind: 'install_broken', note }, order) },
        ).finally(restore);
        expect(order).not.toContain('gate spawned');
        expect(ws(workstream.id)).toMatchObject({
          state: 'FAILED',
          failureKind: 'install_broken',
          attempt: 0,
        });
        expect(ws(workstream.id).failureReason).toContain(note);
        expect(listEvidence(engine.store.db, workstream.id)).toEqual([]);
        const cards = listInbox(engine.store.db, { states: ['OPEN'] });
        expect(cards.map((card) => card.body)).toEqual([expect.stringContaining('(.: tsx)')]);
      });

      it('stops a broken install with no trustworthy pnpm under its own kind, so the failure line does not promise a Retry that installs', async () => {
        const order: string[] = [];
        const restore = watchGates(order);
        const note = 'The install in this copy is broken: no trustworthy pnpm was found';
        const { workstream } = await run(
          () => [[write('src/api/a.txt'), commit('op-wt-base-6b', ['src/api/a.txt']), turn]],
          {
            baseUpdates: recordingBaseUpdates(
              { kind: 'install_broken', note, noPnpm: true },
              order,
            ),
          },
        ).finally(restore);
        expect(order).not.toContain('gate spawned');
        expect(ws(workstream.id)).toMatchObject({
          state: 'FAILED',
          failureKind: 'no_pnpm',
          attempt: 0,
        });
        expect(ws(workstream.id).failureReason).toContain(note);
      });

      it('counts a migration the base merge lost as a failed gate, so a fix session re-creates it, with no gate run', async () => {
        const order: string[] = [];
        const restore = watchGates(order);
        const note = 'The merge of origin/main left this branch without 0042_x.';
        const { workstream } = await run(
          () => [[write('src/api/a.txt'), commit('op-wt-base-7', ['src/api/a.txt']), turn]],
          {
            baseUpdates: recordingBaseUpdates({ kind: 'uncarried', head: 'abc', note }, order),
          },
        ).finally(restore);
        expect(order).not.toContain('gate spawned');
        const row = ws(workstream.id);
        expect(row).toMatchObject({ state: 'QUEUED', attempt: 1 });
        expect(row.nextAction.kind).toBe('fix');
        const evidence = listEvidence(engine.store.db, workstream.id);
        expect(evidence).toHaveLength(1);
        expect(evidence[0]?.summary).toContain(note);
      });

      it('sends the work back to a session that resolves the conflict markers the base merge left, running no gate and raising no card, then gates the merged branch', async () => {
        const order: string[] = [];
        const options: (BeforeGateOptions | undefined)[] = [];
        const answers: BaseUpdate[] = [
          {
            kind: 'conflicted',
            base: 'abc',
            paths: ['README.md'],
            note: 'markers are left in README.md',
          },
          { kind: 'merged', base: 'abc', head: 'def', note: null },
        ];
        const baseUpdates: BaseUpdates = {
          beforeGate: (batchId, _signal, given) => {
            order.push(`base ${batchId}`);
            options.push(given);
            return Promise.resolve(answers.shift() ?? { kind: 'up_to_date', note: null });
          },
          gate: (batchId, _signal, go) => {
            order.push(`batch gate ${batchId}`);
            return go();
          },
          atLaunch: () => Promise.resolve({ kind: 'up_to_date', note: null }),
        };
        const restore = watchGates(order);
        try {
          const { workstream } = await run(
            () => [
              [write('src/api/a.txt'), commit('op-wt-base-4', ['src/api/a.txt']), turn],
              [write('README.md'), commit('op-wt-base-5', ['README.md']), turn],
            ],
            { baseUpdates },
          );
          expect(ws(workstream.id)).toMatchObject({
            state: 'QUEUED',
            nextAction: { kind: 'merge', base: 'origin/main', paths: ['README.md'] },
            attempt: 1,
          });
          expect(order).not.toContain('gate spawned');
          expect(listEvidence(engine.store.db, workstream.id)).toEqual([]);
          expect(listInbox(engine.store.db, { states: ['OPEN'] })).toEqual([]);

          engine.launch(workstream.id);
          await engine.runner.idle();
          expect(engine.adapter.prompts[1]?.prompt).toContain(
            '10db merged origin/main into your branch',
          );
          expect(engine.adapter.prompts[1]?.prompt).toContain('- README.md');
          expect(ws(workstream.id).state).toBe('DONE');
          expect(order.filter((entry) => entry === 'gate spawned')).toHaveLength(1);
          // A task's gate has a session to send, which the shipping gate has not.
          expect(options).toEqual([{ inSession: true }, { inSession: true }]);
        } finally {
          restore();
        }
      });
    });
  });
});

describe('the base merge leaving conflict markers in a task that used its fix attempts', () => {
  const conflicted: BaseUpdate = {
    kind: 'conflicted',
    base: 'abc',
    paths: ['README.md'],
    note: 'markers',
  };

  /**
   * A batch task whose step has used its fix attempts when its lane launches, and whose gate meets
   * `answers` in turn, then an up-to-date branch.
   */
  async function usedUp(answers: BaseUpdate[], script: FakeScriptBook['Alpha']) {
    const baseUpdates: BaseUpdates = {
      beforeGate: () => Promise.resolve(answers.shift() ?? { kind: 'up_to_date', note: null }),
      gate: (_batchId, _signal, go) => go(),
      atLaunch: (batchId) => {
        engine.state.write((ctx) => {
          for (const w of listWorkstreams(ctx.tx, { batchId }))
            patchWorkstream(ctx, w.id, null, { attempt: DEFAULT_RUNNER_LIMITS.maxFixAttempts });
        });
        return Promise.resolve({ kind: 'up_to_date', note: null });
      },
    };
    engine = await createTestEngine({ Alpha: script }, {}, { baseUpdates });
    const batch = engine.state.write((ctx) =>
      insertBatch(ctx, { projectId: engine.project.id, title: 'Greetings', baseBranch: 'main' }),
    );
    const { workstream } = engine.addTask('Alpha', ['api'], [], undefined, batch.id);
    engine.launch(workstream.id);
    await engine.runner.idle();
    return workstream;
  }

  it('is told which of its migrations the merge of its base renumbered, when the next session starts', async () => {
    const notice = {
      key: MIGRATIONS_RENUMBERED_NOTICE_KEY,
      tone: 'info',
      line: '1 of this batch migrations was renumbered',
      body: "- 0042_x → 0043_x\n\nDocs that name a renumbered migration are the lane's to fix",
    } as const;
    const answers: BaseUpdate[] = [conflicted];
    const baseUpdates: BaseUpdates = {
      beforeGate: (batchId) => {
        engine.state.write((c) => {
          setBatchNotice(c, batchId, notice);
        });
        return Promise.resolve(answers.shift() ?? { kind: 'up_to_date', note: null });
      },
      gate: (_batchId, _signal, go) => go(),
      atLaunch: () => Promise.resolve({ kind: 'up_to_date', note: null }),
    };
    engine = await createTestEngine({ Alpha: [[turn], [turn]] }, {}, { baseUpdates });
    const batch = engine.state.write((ctx) =>
      insertBatch(ctx, { projectId: engine.project.id, title: 'Greetings', baseBranch: 'main' }),
    );
    const { workstream } = engine.addTask('Alpha', ['api'], [], undefined, batch.id);
    engine.launch(workstream.id);
    await engine.runner.idle();
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(engine.adapter.prompts[0]?.prompt).not.toContain('0042_x');
    expect(engine.adapter.prompts[1]?.prompt).toContain(notice.body);
  });

  it("is not told to re-create migrations when the lost-migrations notice's list can't be read", async () => {
    const notice = {
      key: MIGRATIONS_UNCARRIED_NOTICE_KEY,
      tone: 'warning',
      line: '1 of this batch migrations was lost',
      body: 'The lane re-creates each after the base',
    } as const;
    const baseUpdates: BaseUpdates = {
      beforeGate: (batchId) => {
        engine.state.write((c) => {
          setBatchNotice(c, batchId, notice);
        });
        return Promise.resolve(conflicted);
      },
      gate: (_batchId, _signal, go) => go(),
      atLaunch: () => Promise.resolve({ kind: 'up_to_date', note: null }),
    };
    engine = await createTestEngine({ Alpha: [[turn], [turn]] }, {}, { baseUpdates });
    const batch = engine.state.write((ctx) =>
      insertBatch(ctx, { projectId: engine.project.id, title: 'Greetings', baseBranch: 'main' }),
    );
    const { workstream } = engine.addTask('Alpha', ['api'], [], undefined, batch.id);
    engine.launch(workstream.id);
    await engine.runner.idle();
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(engine.adapter.prompts[1]?.prompt).toContain("won't clear this notice");
    expect(engine.adapter.prompts[1]?.prompt).not.toContain(notice.body);
  });

  it('still gets a session that resolves the markers, rather than failing before any merge session ran', async () => {
    const workstream = await usedUp(
      [conflicted, { kind: 'merged', base: 'abc', head: 'def', note: null }],
      [[turn], [turn]],
    );
    expect(ws(workstream.id).failureReason).toBeNull();
    expect(ws(workstream.id)).toMatchObject({
      state: 'QUEUED',
      nextAction: { kind: 'merge', base: 'origin/main', paths: ['README.md'] },
    });
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(engine.adapter.prompts[1]?.prompt).toContain('10db merged origin/main into your branch');
    expect(ws(workstream.id).state).toBe('DONE');
  });

  it('fails once that session left the markers again', async () => {
    const workstream = await usedUp([conflicted, conflicted, conflicted], [[turn], [turn], [turn]]);
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('FAILED');
    expect(engine.adapter.prompts).toHaveLength(2);
    expect(ws(workstream.id).failureReason).toContain('README.md');
    expect(ws(workstream.id).failureReason).toContain('retry limit');
    expect(ws(workstream.id).failureReason).toContain('still in README.md');
    expect(ws(workstream.id).failureKind).toBe('retry_limit');
  });

  it('does not say the markers are still there when a new base merge made them after the merge session', async () => {
    const workstream = await usedUp([conflicted, { ...conflicted, fresh: true }], [[turn], [turn]]);
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('FAILED');
    expect(engine.adapter.prompts).toHaveLength(2);
    const reason = ws(workstream.id).failureReason ?? '';
    expect(reason).toContain('README.md');
    expect(reason).toContain('retry limit');
    expect(reason).not.toContain('still');
    expect(reason).toMatch(/new|again/);
  });

  it('counts only the sessions the step used when it ends the merge session with uncommitted changes', async () => {
    const workstream = await usedUp([conflicted], [[turn], [write('src/api/a.txt'), turn]]);
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('FAILED');
    const limit = DEFAULT_RUNNER_LIMITS.maxFixAttempts;
    const reason = ws(workstream.id).failureReason ?? '';
    expect(reason).toContain('uncommitted changes');
    // The attempt is now limit + 2, but only limit + 1 sessions (fix attempts and the merge) ran.
    expect(reason).not.toContain(`${String(limit + 2)} times`);
    expect(reason).toContain(`after ${String(limit + 1)} fix attempts and merge sessions`);
  });
});

describe('the base before a task that holds the migrations hazard from its start', () => {
  /** Answers `answer`, recording each ask and how many sessions had started by then. */
  function recordingMigrationsBase(answer: MigrationsBaseTake) {
    const asked: { id: WorkstreamId; sessions: number }[] = [];
    const migrationsBase: MigrationsBase = {
      take: (id) => {
        asked.push({ id, sessions: engine.adapter.prompts.length });
        return Promise.resolve(answer);
      },
    };
    return { asked, migrationsBase };
  }

  async function run(migrationsBase: MigrationsBase, areas: string[], more: FakeScriptBook = {}) {
    engine = await createTestEngine({ Alpha: [[turn]], ...more }, {}, { migrationsBase });
    const { workstream } = engine.addTask('Alpha', areas);
    engine.launch(workstream.id);
    await engine.runner.idle();
    return workstream;
  }

  it('is brought in before its first session, which keeps the hazard, and is not asked for a task without the hazard', async () => {
    const { asked, migrationsBase } = recordingMigrationsBase({ kind: 'ready' });
    const workstream = await run(migrationsBase, ['api', 'migrations'], { Beta: [[turn]] });
    expect(asked).toEqual([{ id: workstream.id, sessions: 0 }]);
    expect(engine.adapter.prompts[0]?.prompt).toContain(
      'Your claims: area api, hazard migrations.',
    );

    const without = engine.addTask('Beta', ['api']).workstream;
    engine.launch(without.id);
    await engine.runner.idle();
    expect(ws(without.id).state).toBe('DONE');
    expect(asked).toEqual([{ id: workstream.id, sessions: 0 }]);
    expect(engine.adapter.prompts).toHaveLength(2);
  });

  it("gives the hazard back when the branch can't take its base, and the session starts without it", async () => {
    const { asked, migrationsBase } = recordingMigrationsBase({
      kind: 'held',
      instruction: 'origin/main conflicts with this branch in README.md',
    });
    const workstream = await run(migrationsBase, ['api', 'migrations']);
    expect(asked).toEqual([{ id: workstream.id, sessions: 0 }]);
    expect(engine.adapter.prompts[0]?.prompt).toContain('Your claims: area api.');
  });
});

describe("the batch's base when a lane launches", () => {
  it("is brought into the batch's copy before a lane's first session starts, never again for a lane that ran one or for work outside a batch, and the lane starts on the copy as it is when the base could not be brought in or threw", async () => {
    // What the base update answers at the next launch; each launch and the sessions started by then.
    let answer: BaseUpdate | Error = { kind: 'up_to_date', note: null };
    const launches: { batch: string; sessions: number }[] = [];
    const baseUpdates: BaseUpdates = {
      beforeGate: () => Promise.resolve({ kind: 'up_to_date', note: null }),
      gate: (_batchId, _signal, run) => run(),
      atLaunch: (batchId) => {
        launches.push({ batch: batchId, sessions: engine.adapter.prompts.length });
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    };
    const titles = ['First', 'Started', 'Outside', 'NotMerged', 'Threw'] as const;
    engine = await createTestEngine(
      Object.fromEntries(titles.map((title) => [title, [[turn]]])),
      {},
      { baseUpdates },
    );
    // A project runs one batch at a time: each batch task is a lane of its own in this one.
    const batch = engine.state.write((ctx) =>
      insertBatch(ctx, { projectId: engine.project.id, title: 'Greetings', baseBranch: 'main' }),
    );
    /** Runs one task's lane until it stops, in the batch unless `inBatch` is false. */
    const run = async (title: (typeof titles)[number], inBatch: boolean, areas = ['api']) => {
      const { workstream } = engine.addTask(
        title,
        areas,
        [],
        undefined,
        inBatch ? batch.id : undefined,
      );
      // A lane that ran a session before has recorded where it started.
      if (title === 'Started')
        engine.state.write((ctx) => {
          patchWorkstream(ctx, workstream.id, null, { baseHead: 'abc' });
        });
      engine.launch(workstream.id);
      await engine.runner.idle();
      return workstream;
    };

    await run('First', true);
    expect(launches).toEqual([{ batch: batch.id, sessions: 0 }]);
    expect(engine.adapter.prompts).toHaveLength(1);

    // A lane that already ran a session, whose changes are in the copy, and work outside a batch.
    // The started lane's made-up base head leaves it queued with its claims, so it takes ui.
    await run('Started', true, ['ui']);
    const outside = await run('Outside', false);
    expect(ws(outside.id).state).toBe('DONE');
    expect(launches).toHaveLength(1);
    expect(engine.adapter.prompts).toHaveLength(3);

    for (const [title, failed] of [
      ['NotMerged', { kind: 'not_merged', note: 'fetch failed' }],
      ['Threw', new Error('git is gone')],
    ] as const) {
      answer = failed;
      const before = launches.length;
      const lane = await run(title, true);
      expect(ws(lane.id).state, title).toBe('DONE');
      // Asked once, before the lane's own session: every session before it was an earlier lane's.
      expect
        .soft(launches.slice(before), title)
        .toEqual([{ batch: batch.id, sessions: engine.adapter.prompts.length - 1 }]);
    }
    expect(launches).toHaveLength(3);
    expect(engine.adapter.prompts).toHaveLength(5);
  });
});

describe("a batch's gate while new work is held", () => {
  /** Base updates that bring nothing in, recording in `order` each turn taken and each update. */
  function recordingBase(order: string[]): BaseUpdates {
    return {
      beforeGate: () => {
        order.push('base');
        return Promise.resolve({ kind: 'up_to_date', note: null });
      },
      gate: (_batchId, _signal, run) => {
        order.push('turn');
        return run();
      },
      atLaunch: () => Promise.resolve({ kind: 'up_to_date', note: null }),
    };
  }

  /** The real gate, recording in `order` each gate asked for and each command that starts. */
  function recordingGate(order: string[]): GateRunner {
    const gate = createGateRunner({ sandbox: null, logger: silentLogger });
    return {
      run: (request) => {
        order.push('gate asked');
        return gate.run({
          ...request,
          onSpawn: (pid) => {
            order.push('gate spawned');
            request.onSpawn?.(pid);
          },
        });
      },
    };
  }

  /** Starts one task in a batch under `hold`; its session ends when `endSession` is called. */
  async function laneInBatch(hold: Hold, baseUpdates: BaseUpdates, order: string[]) {
    engine = await createTestEngine(
      { Alpha: [[{ do: 'await_message', contains: 'go' }, turn]] },
      {},
      { baseUpdates, hold, gate: recordingGate(order) },
    );
    const start = vi.spyOn(engine.adapter, 'open');
    const batch = engine.state.write((ctx) =>
      insertBatch(ctx, { projectId: engine.project.id, title: 'Greetings', baseBranch: 'main' }),
    );
    const { workstream } = engine.addTask('Alpha', ['api'], [], undefined, batch.id);
    engine.launch(workstream.id);
    await waitFor(() => start.mock.results.length === 1);
    const session = start.mock.results[0]?.value as { send(text: string): void } | undefined;
    if (!session) throw new Error('no session started');
    return {
      workstream,
      endSession: () => {
        session.send('go');
      },
    };
  }

  it("parks before it takes the batch's turn, so nothing of the batch waits behind it", async () => {
    const order: string[] = [];
    const fake = fakeHold(false);
    const { workstream, endSession } = await laneInBatch(fake.hold, recordingBase(order), order);
    fake.begin();
    endSession();
    await waitFor(() => fake.parked() === 1);
    expect(order).toEqual([]);
    fake.release();
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(order).toEqual(['turn', 'gate asked', 'base', 'gate spawned']);
  });

  it('starts no gate when the hold came on while its base came in', async () => {
    const order: string[] = [];
    const fake = fakeHold(false);
    const recording = recordingBase(order);
    let cameIn = false;
    const { workstream, endSession } = await laneInBatch(
      fake.hold,
      {
        ...recording,
        beforeGate: (batchId, signal, options) => {
          if (!cameIn) fake.begin();
          cameIn = true;
          return recording.beforeGate(batchId, signal, options);
        },
      },
      order,
    );
    endSession();
    await waitFor(() => fake.parked() === 1);
    expect(order).not.toContain('gate spawned');
    fake.release();
    await engine.runner.idle();
    expect(order).toContain('gate spawned');
    expect(ws(workstream.id).state).toBe('DONE');
  });
});

describe('without a gate command', () => {
  const approve = (opId: string) => ({
    do: 'mcp' as const,
    tool: 'complete_step',
    args: { opId, summary: 'Looks right.', verdict: 'approve' },
  });
  const implement = (opId: string) => [
    write('src/api/a.txt', opId),
    commit(opId, ['src/api/a.txt']),
    turn,
  ];
  const checkCards = () => listInbox(engine.store.db, {}).filter((i) => i.kind === 'check');
  const openChecks = () => checkCards().filter((i) => i.state === 'OPEN');
  const recover = () =>
    recoverOnStartup({
      state: engine.state,
      inbox: engine.inbox,
      git: createGit(),
      processes: systemProcesses,
      jobs: createDeliveryJobs(silentLogger),
      clock: engine.clock,
      maxRecoveryAttempts: 3,
      logger: silentLogger,
    });

  /** Runs the lane to wherever it stops; a workstream that waits stays WAITING_HUMAN. */
  const runToWait = async (id: Parameters<typeof ws>[0]) => {
    engine.launch(id);
    await engine.runner.idle();
  };

  const expectWaitingForTheBuilder = (
    id: Parameters<typeof ws>[0],
    title: string,
    commits: number,
  ) => {
    const [card] = openChecks();
    expect(openChecks()).toHaveLength(1);
    expect(ws(id)).toMatchObject({
      state: 'WAITING_HUMAN',
      currentSessionId: null,
      nextAction: { kind: 'builder_review', inboxId: card?.id },
    });
    expect(card).toMatchObject({
      kind: 'check',
      title: `Ready for you to check: ${title}`,
      options: [{ label: 'approve' }, { label: 'send_back' }],
      targets: [{ workstreamId: id }],
    });
    const row = getWorkstreamRow(engine.store.db, id);
    expect(card?.detail).toMatchObject({ workstreamId: id, baseHead: row.baseHead });
    const detail = card?.detail ?? {};
    const head = detail['head'];
    expect(typeof head === 'string' && /^[0-9a-f]{40}$/.test(head)).toBe(true);
    expect(detail['commits']).toHaveLength(commits);
    // The task still owns its areas, and no lane is held: no lease, no live runner.
    expect(activeClaims(engine.store.db, id).length).toBeGreaterThan(0);
    expect(row.leaseOwner).toBeNull();
    expect(engine.runner.isRunning(id)).toBe(false);
    expect(listEvidence(engine.store.db, id)).toEqual([]);
  };

  const neverDone = (id: Parameters<typeof ws>[0], taskId: Parameters<typeof getTask>[1]) => {
    expect(ws(id).state).not.toBe('DONE');
    expect(getTask(engine.store.db, taskId).status).not.toBe('done');
    expect(listInbox(engine.store.db, {}).filter((i) => i.kind === 'review')).toEqual([]);
  };

  /** The last step without a gate waits for the builder, with one check card and no lane held. */
  const waitsForTheBuilder = (id: Parameters<typeof ws>[0], task: ReturnType<typeof getTask>) => {
    expectWaitingForTheBuilder(id, 'Alpha', 1);
    expect(countLanes(engine.store.db).byProject.get(task.projectId) ?? 0).toBe(0);
    expect(openChecks()[0]?.body).toBe(
      '1 commit is ready. Approve to finish the task, or send it back with a note.',
    );
    neverDone(id, task.id);
  };

  it('a middle step advances without evidence, and a review step that is the last waits for the builder', async () => {
    engine = await createTestEngine(
      { Alpha: [implement('op-nogate-0001'), [approve('op-nogate-0002'), turn]] },
      { gateCommand: null },
    );
    const { task, workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
    await runToWait(workstream.id);
    expect(ws(workstream.id)).toMatchObject({ state: 'QUEUED', stepIndex: 1 });
    expect(ws(workstream.id).nextAction).toEqual({ kind: 'start' });
    expect(listEvidence(engine.store.db, workstream.id)).toEqual([]);
    expect(transitions(workstream.id).at(-1)).toBe('VERIFYING->QUEUED');
    const advance = listEventsAfter(engine.store.db, 0, 1000)
      .filter((e) => e.type === 'workstream.changed' && e.entityId === workstream.id)
      .at(-1);
    expect(advance?.data['reason']).toMatch(/^no gate command; next: /);
    expect(checkCards()).toEqual([]);

    await runToWait(workstream.id);
    waitsForTheBuilder(workstream.id, task);
  });

  it('an implement step that is the last waits for the builder, and an answer to another card targeting it, given live or redelivered by recovery, or a restart, leaves it WAITING_HUMAN with one card and the same next action', async () => {
    engine = await createTestEngine(
      { Alpha: [implement('op-nogate-0051')] },
      { gateCommand: null },
    );
    const { task, workstream } = engine.addTask('Alpha');
    await runToWait(workstream.id);
    waitsForTheBuilder(workstream.id, task);
    const before = ws(workstream.id);
    const sessions = engine.adapter.prompts.length;
    const stillWaiting = () => {
      expect(ws(workstream.id)).toMatchObject({
        state: 'WAITING_HUMAN',
        nextAction: before.nextAction,
      });
      expect(engine.adapter.prompts).toHaveLength(sessions);
      expect(openChecks()).toHaveLength(1);
      neverDone(workstream.id, task.id);
    };
    for (const { kind, choice } of [
      { kind: 'permission' as const, choice: 'allow_once' },
      { kind: 'question' as const, choice: 'Yes' },
    ]) {
      // The step ended before the builder answered this card, so no waiter is left for it.
      const other = engine.state.write((ctx) =>
        insertInboxItem(ctx, {
          projectId: task.projectId,
          kind,
          title: 'Late question',
          body: 'Asked before the step ended',
          options: [{ label: choice, description: '' }],
          recommendation: null,
          category: 'product',
          urgency: 'normal',
          detail: null,
          foldKey: null,
          targets: [{ workstreamId: workstream.id, sessionId: null }],
        }),
      );
      engine.inbox.answer(other.id, { choice });
      stillWaiting();
    }
    // Answered, but the daemon stopped before the answer reached its target.
    engine.state.write((ctx) => {
      const item = insertInboxItem(ctx, {
        projectId: task.projectId,
        kind: 'permission',
        title: 'Late permission',
        body: 'Asked before the step ended',
        options: [{ label: 'allow_once', description: '' }],
        recommendation: null,
        category: 'product',
        urgency: 'normal',
        detail: null,
        foldKey: null,
        targets: [{ workstreamId: workstream.id, sessionId: null }],
      });
      updateInboxItem(ctx, item.id, { state: 'ANSWERED', answer: { choice: 'allow_once' } });
    });
    const report = await recover();
    expect(report.redelivered).toHaveLength(1);
    stillWaiting();

    // Restarts while it waits keep its one card.
    for (let i = 0; i < 2; i += 1) {
      const restart = await recover();
      expect(restart.parked).toEqual([workstream.id]);
      expect(restart.requeued).toEqual([]);
      expect(ws(workstream.id)).toMatchObject({
        state: 'WAITING_HUMAN',
        nextAction: before.nextAction,
      });
      expect(openChecks()).toHaveLength(1);
      expect(openChecks()[0]?.id).toBe(
        before.nextAction.kind === 'builder_review' ? before.nextAction.inboxId : null,
      );
    }
    // Nothing verified again, nothing started, nothing completed.
    expect(engine.adapter.prompts).toHaveLength(sessions);
    expect(listEvidence(engine.store.db, workstream.id)).toEqual([]);
    neverDone(workstream.id, task.id);
  });

  it('a crash in VERIFYING with no gate raises the card once', async () => {
    engine = await createTestEngine({ Alpha: [[turn]] }, { gateCommand: null });
    const { task, workstream } = engine.addTask('Alpha');
    engine.state.write((ctx) => {
      for (const to of ['STARTING', 'RUNNING'] as const)
        transitionWorkstream(ctx, workstream.id, { to, fence: null });
      transitionWorkstream(ctx, workstream.id, {
        to: 'VERIFYING',
        fence: null,
        patch: { nextAction: { kind: 'verify' } },
      });
    });
    await recover();
    expect(ws(workstream.id)).toMatchObject({ state: 'QUEUED', nextAction: { kind: 'verify' } });
    expect(checkCards()).toEqual([]);
    await runToWait(workstream.id);
    expect(ws(workstream.id).state).toBe('WAITING_HUMAN');
    expect(checkCards()).toHaveLength(1);
    await recover();
    await recover();
    expect(checkCards()).toHaveLength(1);
    expect(ws(workstream.id).state).toBe('WAITING_HUMAN');
    neverDone(workstream.id, task.id);
  });

  describe('answering the check', () => {
    const note = 'Rename the badge prop';
    const answerCheck = (choice: string, withNote?: string) => {
      const [card] = openChecks();
      if (!card) throw new Error('no open check card');
      return engine.inbox.answer(card.id, {
        choice,
        ...(withNote === undefined ? {} : { note: withNote }),
      });
    };
    const waiting = async (op: string, options: Parameters<typeof createTestEngine>[2] = {}) => {
      engine = await createTestEngine(
        { Alpha: [implement(op), [turn], [turn], [turn], [turn], [turn]] },
        { gateCommand: null },
        options,
      );
      const added = engine.addTask('Alpha');
      await runToWait(added.workstream.id);
      return added;
    };
    const doneTransitions = (id: Parameters<typeof ws>[0]) =>
      transitions(id).filter((t) => t.endsWith('->DONE'));
    const reviewCards = () => listInbox(engine.store.db, {}).filter((i) => i.kind === 'review');
    /** The runner's own entry points, called as the inbox calls them: inside one write. */
    const approveDirect = (id: Parameters<typeof ws>[0]) => {
      engine.state.write((ctx) => engine.runner.approveCheck(ctx, id))();
    };
    const sendBackDirect = (id: Parameters<typeof ws>[0], withNote: string) => {
      engine.state.write((ctx) => engine.runner.sendBack(ctx, id, withNote))();
    };

    it('approve completes with no session started, frees the lane and raises no review card', async () => {
      let freed = 0;
      const { task, workstream } = await waiting('op-check-0001', {
        onLaneFreed: () => {
          freed += 1;
        },
      });
      const sessions = engine.adapter.prompts.length;
      const freedBefore = freed;
      answerCheck('approve');
      // Claims are released and the lane freed in the answer itself, before the runner settles.
      expect(ws(workstream.id).state).toBe('DONE');
      expect(activeClaims(engine.store.db, workstream.id)).toEqual([]);
      expect(freed).toBe(freedBefore + 1);
      expect(reviewCards()).toEqual([]);
      await engine.runner.idle();
      expect(ws(workstream.id)).toMatchObject({ state: 'DONE', currentSessionId: null });
      expect(getTask(engine.store.db, task.id).status).toBe('done');
      expect(activeClaims(engine.store.db, workstream.id)).toEqual([]);
      expect(getWorkstreamRow(engine.store.db, workstream.id).leaseOwner).toBeNull();
      expect(engine.adapter.prompts).toHaveLength(sessions);
      expect(checkCards().map((c) => c.state)).toEqual(['RESOLVED']);
      expect(transitions(workstream.id).slice(-2)).toEqual([
        'WAITING_HUMAN->VERIFYING',
        'VERIFYING->DONE',
      ]);
      expect(listEvidence(engine.store.db, workstream.id)).toEqual([]);
    });

    // Only Approve completes: an unanswered card is covered by the waiting tests above, a send back here.
    it('send back records builder evidence, queues a fix that carries the note and survives restarts, one that finds the fix session mid resume too', async () => {
      const { task, workstream } = await waiting('op-check-0005');
      const before = getWorkstreamRow(engine.store.db, workstream.id);
      answerCheck('send_back', note);
      neverDone(workstream.id, task.id);
      const [evidence] = listEvidence(engine.store.db, workstream.id);
      expect(evidence).toMatchObject({
        kind: 'builder',
        command: null,
        exitCode: null,
        summary: note,
      });
      expect(ws(workstream.id)).toMatchObject({
        state: 'QUEUED',
        currentSessionId: null,
        attempt: before.attempt + 1,
        nextAction: { kind: 'fix', evidenceId: evidence?.id },
      });
      expect(checkCards().map((c) => c.state)).toEqual(['RESOLVED']);
      expect(activeClaims(engine.store.db, workstream.id).length).toBeGreaterThan(0);
      expect(getWorkstreamRow(engine.store.db, workstream.id).leaseOwner).toBeNull();

      // Neither answer can be given again to a workstream already queued after a send back.
      const queued = ws(workstream.id);
      const events = listEventsAfter(engine.store.db, 0, 1000).length;
      expect(() => {
        approveDirect(workstream.id);
      }).toThrow(ConflictError);
      expect(() => {
        sendBackDirect(workstream.id, 'again');
      }).toThrow(ConflictError);
      expect(ws(workstream.id)).toEqual(queued);
      expect(listEvidence(engine.store.db, workstream.id)).toEqual([evidence]);
      expect(listEventsAfter(engine.store.db, 0, 1000)).toHaveLength(events);

      // A restart keeps the note once and the fix queued.
      await recover();
      await recover();
      expect(listEvidence(engine.store.db, workstream.id)).toHaveLength(1);
      expect(ws(workstream.id)).toMatchObject({
        state: 'QUEUED',
        attempt: 1,
        nextAction: queued.nextAction,
      });
      expect(checkCards().map((c) => c.state)).toEqual(['RESOLVED']);

      // A restart that finds the fix session mid resume still gives the next session the note.
      engine.state.write((ctx) => {
        transitionWorkstream(ctx, workstream.id, { to: 'STARTING', fence: null });
        transitionWorkstream(ctx, workstream.id, {
          to: 'RUNNING',
          fence: null,
          patch: { nextAction: { kind: 'resume', providerSessionId: 'p1', reason: 'test' } },
        });
      });
      await recover();
      expect(ws(workstream.id).nextAction).toEqual({ kind: 'fix', evidenceId: evidence?.id });

      // The fix prompt carries the note, and the fixed work comes back for a check.
      await runToWait(workstream.id);
      expect(engine.adapter.prompts.at(-1)?.prompt).toContain(
        `The builder sent the work back: ${note}`,
      );
      expect(ws(workstream.id).state).toBe('WAITING_HUMAN');
      expect(openChecks()).toHaveLength(1);
      neverDone(workstream.id, task.id);
    });

    it('past maxFixAttempts a send back fails the workstream and keeps the note', async () => {
      const { task, workstream } = await waiting('op-check-0007');
      engine.state.write((ctx) => {
        patchWorkstream(ctx, workstream.id, null, {
          attempt: DEFAULT_RUNNER_LIMITS.maxFixAttempts,
        });
      });
      answerCheck('send_back', note);
      const [evidence] = listEvidence(engine.store.db, workstream.id);
      expect(evidence).toMatchObject({ kind: 'builder', summary: note });
      expect(ws(workstream.id)).toMatchObject({ state: 'FAILED', failureKind: 'retry_limit' });
      expect(ws(workstream.id).nextAction.kind).not.toBe('builder_review');
      expect(ws(workstream.id).failureReason).toContain(
        String(DEFAULT_RUNNER_LIMITS.maxFixAttempts + 1),
      );
      expect(ws(workstream.id).failureReason).toContain(note);
      expect(checkCards().map((c) => c.state)).toEqual(['RESOLVED']);
      expect(activeClaims(engine.store.db, workstream.id)).toEqual([]);
      expect(getTask(engine.store.db, task.id).status).not.toBe('done');
      expect(
        listInbox(engine.store.db, {}).filter((i) => i.title.startsWith('Workstream failed')),
      ).toHaveLength(1);
    });

    describe('a retry after the limit keeps the note for a fresh session', () => {
      const noGate = { gateCommand: null } as const;
      const exhaust = (workstreamId: Parameters<typeof ws>[0]) => {
        engine.state.write((ctx) => {
          patchWorkstream(ctx, workstreamId, null, {
            attempt: DEFAULT_RUNNER_LIMITS.maxFixAttempts,
          });
        });
        answerCheck('send_back', note);
        // The test clock is frozen: the retry restarts the step later than the note.
        engine.clock.advance(1_000);
        engine.retry(workstreamId);
      };

      it('after a restart that finds the fix session mid resume', async () => {
        engine = await createTestEngine({ Alpha: [implement('op-check-0065')] }, noGate);
        const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'quick' });
        await runToWait(workstream.id);
        exhaust(workstream.id);
        const [evidence] = listEvidence(engine.store.db, workstream.id);
        engine.state.write((ctx) => {
          transitionWorkstream(ctx, workstream.id, { to: 'STARTING', fence: null });
          transitionWorkstream(ctx, workstream.id, {
            to: 'RUNNING',
            fence: null,
            patch: { nextAction: { kind: 'resume', providerSessionId: 'p1', reason: 'test' } },
          });
        });
        await recover();
        expect(ws(workstream.id).nextAction).toEqual({ kind: 'fix', evidenceId: evidence?.id });
      });
    });

    it('send back without a note, or for a workstream no longer waiting, is refused and changes nothing', async () => {
      const { task, workstream } = await waiting('op-check-0008');
      const before = ws(workstream.id);
      expect(() => answerCheck('send_back')).toThrow(InboxAnswerRefused);
      expect(() => answerCheck('send_back', '   ')).toThrow(InboxAnswerRefused);
      expect(ws(workstream.id)).toEqual(before);
      expect(openChecks()).toHaveLength(1);
      expect(listEvidence(engine.store.db, workstream.id)).toEqual([]);
      neverDone(workstream.id, task.id);

      // An answer for a workstream that is no longer waiting is a conflict that leaves the card open.
      engine.state.write((ctx) =>
        transitionWorkstream(ctx, workstream.id, {
          to: 'QUEUED',
          fence: null,
          patch: { nextAction: { kind: 'start' } },
        }),
      );
      expect(() => answerCheck('send_back', note)).toThrow(ConflictError);
      expect(openChecks()).toHaveLength(1);
      expect(listEvidence(engine.store.db, workstream.id)).toEqual([]);
    });

    it('answering the same card twice completes once, and a restart closes nothing twice', async () => {
      const { task, workstream } = await waiting('op-check-0009');
      const sessions = engine.adapter.prompts.length;
      const [card] = openChecks();
      answerCheck('approve');
      const done = ws(workstream.id);
      const evidence = listEvidence(engine.store.db, workstream.id);
      const events = listEventsAfter(engine.store.db, 0, 1000).length;
      expect(() =>
        engine.inbox.answer(card?.id ?? mintId('InboxItem'), { choice: 'approve' }),
      ).toThrow(ConflictError);
      expect(() => {
        approveDirect(workstream.id);
      }).toThrow(ConflictError);
      expect(() => {
        sendBackDirect(workstream.id, 'again');
      }).toThrow(ConflictError);
      expect(ws(workstream.id)).toEqual(done);
      expect(listEvidence(engine.store.db, workstream.id)).toEqual(evidence);
      expect(listEventsAfter(engine.store.db, 0, 1000)).toHaveLength(events);
      expect(doneTransitions(workstream.id)).toHaveLength(1);
      expect(getTask(engine.store.db, task.id).status).toBe('done');

      // Restarts leave the approved work done: nothing parked, requeued, started or raised again.
      for (let i = 0; i < 2; i += 1) {
        const report = await recover();
        expect(report.parked).toEqual([]);
        expect(report.requeued).toEqual([]);
      }
      expect(ws(workstream.id).state).toBe('DONE');
      expect(checkCards().map((c) => c.state)).toEqual(['RESOLVED']);
      expect(doneTransitions(workstream.id)).toHaveLength(1);
      expect(getTask(engine.store.db, task.id).status).toBe('done');
      expect(reviewCards()).toEqual([]);
      expect(engine.adapter.prompts).toHaveLength(sessions);
    });

    it('a stale Approve on a card whose work is mid fix is refused and changes nothing', async () => {
      const { task, workstream } = await waiting('op-check-0015');
      // The card is still open although the work was sent back: the state a split write once left.
      sendBackDirect(workstream.id, note);
      const before = ws(workstream.id);
      const [card] = openChecks();
      expect(card).toBeDefined();
      expect(() => answerCheck('approve')).toThrow(ConflictError);
      expect(ws(workstream.id)).toEqual(before);
      expect(getTask(engine.store.db, task.id).status).not.toBe('done');
      expect(openChecks().map((c) => c.id)).toEqual([card?.id]);
    });

    it('send back restarts a single step as running, one attempt on', async () => {
      engine = await createTestEngine(
        { Alpha: [implement('op-check-0024'), implement('op-check-0025')] },
        { gateCommand: null },
      );
      const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'quick' });
      await runToWait(workstream.id);
      expect(ws(workstream.id).steps.map((s) => s.status)).toEqual(['done']);
      answerCheck('send_back', note);
      expect(ws(workstream.id).steps.map((s) => [s.status, s.attempts])).toEqual([['running', 1]]);
    });
  });
});

describe("a Light task's review safety net", () => {
  const approve = (opId: string) => ({
    do: 'mcp' as const,
    tool: 'complete_step',
    args: { opId, summary: 'Looks right.', verdict: 'approve' },
  });
  const implement = (opId: string, path = 'src/api/a.txt', content = opId) => [
    write(path, content),
    commit(opId, [path]),
    turn,
  ];
  const step = (id: WorkstreamId, i: number) => ws(id).steps[i];
  const until = async (id: WorkstreamId, done: (state: string) => boolean) => {
    for (let i = 0; i < 10 && !done(ws(id).state); i += 1) {
      engine.launch(id);
      await engine.runner.idle();
    }
  };
  const reasons = (id: WorkstreamId) =>
    listEventsAfter(engine.store.db, 0, 1000)
      .filter((e) => e.type === 'workstream.changed' && e.entityId === id)
      .map((e) => e.data['reason']);

  it('adds a review to a Light task that changes a manifest, and runs it', async () => {
    engine = await createTestEngine({
      Alpha: [
        implement('op-net-0001', 'src/api/package.json', '{}'),
        [approve('op-net-0002'), turn],
      ],
    });
    // The dependencies area is the claim a manifest needs.
    const { workstream } = engine.addTask('Alpha', ['api', 'deps'], [], { flow: 'quick' });
    expect(ws(workstream.id).steps.map((s) => s.role)).toEqual(['implement']);
    await until(workstream.id, (s) => s === 'DONE');
    expect(ws(workstream.id).state).toBe('DONE');
    expect(ws(workstream.id).steps.map((s) => [s.role, s.status])).toEqual([
      ['implement', 'done'],
      ['review', 'done'],
    ]);
    expect(engine.adapter.prompts).toHaveLength(2);
    // The review runs on the Light row's rounds, on the cell of the lowest stronger rigor that reviews.
    expect(step(workstream.id, 1)).toMatchObject({ reviewRounds: 1 });
    // The drawer shows the step's own reason, so it says why the review was added.
    expect(step(workstream.id, 1)?.reason).toMatch(
      /^review added: changes `src\/api\/package\.json`/,
    );
    expect(
      reasons(workstream.id).some(
        (r) =>
          typeof r === 'string' &&
          r.includes('review added: changes `src/api/package.json`') &&
          r.includes('next: review'),
      ),
    ).toBe(true);
  });

  it("judges only the task's own commits when the builder commits a migration between them", async () => {
    engine = await createTestEngine({
      Alpha: [
        [
          write('src/api/a.txt'),
          commit('op-net-own-01', ['src/api/a.txt']),
          { do: 'await_signal', name: 'builder-committed' },
          write('src/api/b.txt'),
          commit('op-net-own-02', ['src/api/b.txt']),
          turn,
        ],
      ],
    });
    const repoGit = (...args: string[]) =>
      execFileSync('git', ['-C', engine.repoPath, ...args], {
        env: isolatedGitEnv(),
        encoding: 'utf8',
      }).trim();
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'quick' });
    engine.launch(workstream.id);
    // The builder commits a migration on the shared branch between the task's two commits.
    // Once the commit tool has answered, so the builder's commit does not race it.
    await waitFor(
      () =>
        engine.adapter.observations.find(
          (o) => o.kind === 'mcp_result' && o.detail['tool'] === 'commit',
        ) ?? undefined,
    );
    mkdirSync(join(engine.repoPath, 'db/migrations'), { recursive: true });
    writeFileSync(join(engine.repoPath, 'db/migrations/0001_theirs.sql'), 'select 1;');
    repoGit('add', 'db/migrations/0001_theirs.sql');
    repoGit('commit', '-q', '-m', 'Builder migration');
    engine.adapter.signal('builder-committed');
    await engine.runner.idle();

    const [first, builders, second] = repoGit('rev-list', '--reverse', 'HEAD~3..HEAD').split('\n');
    expect(repoGit('log', '-1', '--format=%s', builders ?? '')).toBe('Builder migration');
    // The builder's migration forces no review of the task's work.
    expect(ws(workstream.id).state).toBe('DONE');
    expect(ws(workstream.id).steps.map((s) => s.role)).toEqual(['implement']);
    const gate = listEvidence(engine.store.db, workstream.id).filter((e) => e.kind === 'gate');
    expect(gate.map((e) => e.commitShas)).toEqual([[first, second]]);
    const changes = await workstreamChanges(
      { db: engine.store.db, git: createGit() },
      workstream.id,
    );
    expect(changes.commits).toEqual([first, second]);
    expect(changes.files.map((f) => f.path)).toEqual(['src/api/a.txt', 'src/api/b.txt']);
    expect(changes.diff).not.toContain('0001_theirs.sql');
  });

  it('ends cancelled, and adds no review, when a cancel lands while the safety net reads the change', async () => {
    const real = createGit();
    let reading = false;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const git: Git = {
      ...real,
      diffSince: async (...args) => {
        reading = true;
        await gate;
        return real.diffSince(...args);
      },
    };
    engine = await createTestEngine(
      { Alpha: [implement('op-net-0071', 'src/api/package.json', '{}')] },
      {},
      { git },
    );
    const { workstream } = engine.addTask('Alpha', ['api', 'deps'], [], { flow: 'quick' });
    engine.launch(workstream.id);
    await waitFor(() => reading);
    // The cancel waits for the lane, which is held in the read until it is let go.
    const cancelling = engine.runner.cancel(workstream.id);
    release();
    await cancelling;
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('CANCELLED');
    expect(ws(workstream.id).steps.map((s) => s.role)).toEqual(['implement']);
    expect(engine.adapter.prompts).toHaveLength(1);
  });
});

describe("a task's plan anchors at session start", () => {
  /** The excerpt of the fixture's f1 anchor (`src/runner.ts:3`), three lines lower in the base. */
  function commitMovedAnchor(): void {
    const env = isolatedGitEnv();
    mkdirSync(join(engine.repoPath, 'src'), { recursive: true });
    writeFileSync(
      join(engine.repoPath, 'src', 'runner.ts'),
      ['a', 'b', 'c', '// runner', '', 'const pack = build();', 'emit(pack);', ''].join('\n'),
    );
    execFileSync('git', ['-C', engine.repoPath, 'add', '-A'], { env });
    execFileSync('git', ['-C', engine.repoPath, 'commit', '-q', '-m', 'move the anchor'], { env });
  }

  /** Adds the task, pinned to p1#task-1 of the fixture Plan and citing f1. */
  function pinnedTask(title: string) {
    const bundle = parseBundle(bundleJson(engine.project.id));
    const bodies = inlineBodies(bundle);
    const added = engine.addTask(title);
    engine.state.write((ctx) => {
      const { shapeId } = importBundle(ctx, {
        projectId: engine.project.id,
        bundle,
        bodies,
        changes: planImportChanges(null, bundle, bodies),
      });
      const doc = findDocument(ctx.tx, shapeId, 'p1');
      const revision = doc && getAttachmentRevision(ctx.tx, doc.id, 1);
      if (!revision) throw new Error('no p1 revision');
      upsertTaskContext(ctx, {
        taskId: added.task.id,
        shapeId,
        revisionId: revision.id,
        section: 'task-1',
        shared: [],
        cites: ['f1'],
      });
    });
    return added;
  }

  it("a lane's first session checks its task's anchors before the pack, and its prompt shows the result", async () => {
    engine = await createTestEngine({ Alpha: [[turn]] });
    commitMovedAnchor();
    const { workstream } = pinnedTask('Alpha');
    engine.launch(workstream.id);
    await waitFor(() => engine.adapter.prompts.length > 0);
    const prompt = engine.adapter.prompts[0]?.prompt ?? '';
    expect(prompt).toContain('Anchor moved: src/runner.ts:3→6');
    expect(prompt).not.toContain('checked at');
    await engine.runner.cancel(workstream.id);
  });
});
