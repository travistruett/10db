import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ACCOUNT_CARD_DETAIL,
  ConflictError,
  InboxAnswerRefused,
  mintId,
  ToolAccess,
  AccountCardChoice,
  MCP_APPROVAL_DETAIL,
  rejectionsSentBack,
  ReviewCardDetail,
  reviewRounds,
  type AccountId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  acquireLease,
  activeClaims,
  countLanes,
  deleteAppSetting,
  getAccount,
  getProject,
  getTask,
  getWorkstream,
  getWorkstreamRow,
  insertBatch,
  insertInboxItem,
  listEventsAfter,
  listEvidence,
  listInbox,
  listSessions,
  patchAccount,
  patchProject,
  patchWorkstream,
  schema,
  seedAccount,
  transitionBatch,
  transitionWorkstream,
  updateInboxItem,
} from '@10db/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HANDOFF_FIRM_NUDGE,
  HANDOFF_FIRM_NUDGE_ACCOUNT,
  HANDOFF_NUDGE,
  HANDOFF_NUDGE_ACCOUNT,
  RESULT_NUDGE,
} from '../briefing';
import { createLauncher, KeychainError } from '../environment';
import { recoverOnStartup, systemProcesses } from '../recovery';
import { DEFAULT_RUNNER_LIMITS } from '../runner';
import { createGit } from '../git';
import { silentLogger } from '../log';
import { createGateRunner, type GateRequest, type GateResult } from '../verify';
import type { BaseUpdate, BaseUpdates, MigrationsBase, MigrationsBaseTake } from '../delivery';
import { allowedToolsFor, listNetworkHosts } from '../permissions';
import {
  createLaneSandbox,
  SandboxedMcpServer,
  SandboxProfileError,
  SandboxTempDirError,
  type LaneSandbox,
  type LaneSession,
  type LaneSessionInput,
} from '../sandbox';
import type { FakeScriptBook, SessionEvent, SessionHandle, SessionSpec } from '../sessions';
import {
  createMemoryKeychain,
  FAKE_SRT,
  handoffArgs,
  isolatedGitEnv,
  SANDBOXED,
  tempDir,
  waitFor,
} from '../../test/fixtures';
import { createTestEngine, type TestEngine } from '../../test/engine';
import { captureLogs } from '../../test/log-capture';

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

let current: Parameters<typeof getWorkstream>[1];
const ws0 = () => current;
const ws = (id: Parameters<typeof getWorkstream>[1]) => getWorkstream(engine.store.db, id);
const openCard = () => listInbox(engine.store.db, { states: ['OPEN'] })[0];
const transitions = (id: Parameters<typeof getWorkstream>[1]) =>
  listEventsAfter(engine.store.db, 0, 1000)
    .filter((e) => e.type === 'workstream.changed' && e.entityId === id)
    .map((e) =>
      [e.data['from'], e.data['to']].map((s) => (typeof s === 'string' ? s : '?')).join('->'),
    );

describe('runner', () => {
  it("logs each gate run's start and end, with its exit code, duration and log path", async () => {
    const logs = captureLogs();
    engine = await createTestEngine(
      { Alpha: [[write('src/api/a.txt'), commit('op-alpha-log-1', ['src/api/a.txt']), turn]] },
      {},
      { logger: logs.logger },
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();

    const [gate] = listEvidence(engine.store.db, workstream.id);
    const gateLines = logs.lines().filter((line) => String(line['msg']).startsWith('gate '));
    expect(gateLines.map((line) => line['msg'])).toEqual(['gate started', 'gate finished']);
    const [started, finished] = gateLines;
    expect(started).toMatchObject({
      workstreamId: workstream.id,
      command: 'true',
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
  });

  it('runs a task to DONE with gate evidence, and the guard blocks an out-of-claim write', async () => {
    engine = await createTestEngine({
      Alpha: [
        [
          write('src/ui/nope.txt'),
          write('src/api/a.txt'),
          commit('op-alpha-001', ['src/api/a.txt']),
          turn,
        ],
      ],
    });
    const { task, workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();

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
  });

  it('hands off at the threshold, nudges firmly near the limit, and continues in a fresh session', async () => {
    engine = await createTestEngine({
      Alpha: [
        [
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
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(ws(workstream.id).state).toBe('DONE');
    expect(listSessions(engine.store.db, workstream.id).map((s) => s.exitReason)).toEqual([
      'handoff',
      'step_done',
    ]);
    expect(engine.adapter.prompts[1]?.prompt).toContain('Next action: Write the second file');
    const states = listEventsAfter(engine.store.db, 0, 1000)
      .filter((e) => e.type === 'workstream.changed')
      .map((e) => e.data['to']);
    expect(states).toContain('HANDING_OFF');
  });

  it("checks a step with the project's changed-packages command, not its gate command", async () => {
    engine = await createTestEngine(
      { Alpha: [[write('src/api/a.txt'), commit('op-alpha-chg-1', ['src/api/a.txt']), turn]] },
      { gateCommand: 'echo FULL-GATE-RAN; exit 3', changedCheckCommand: 'true' },
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(ws(workstream.id).state).toBe('DONE');
    const [check] = listEvidence(engine.store.db, workstream.id);
    expect(check).toMatchObject({ kind: 'gate', command: 'true', exitCode: 0 });
  });

  it('sends a failed changed-packages check back as a fix with its output', async () => {
    engine = await createTestEngine(
      {
        Alpha: [
          [turn],
          [write('src/api/fixed.txt'), commit('op-chg-fix-1', ['src/api/fixed.txt']), turn],
        ],
      },
      {
        gateCommand: 'true',
        changedCheckCommand: 'test -f src/api/fixed.txt || { echo MISSING-CHANGED-FILE; exit 2; }',
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
  });

  it('sends a failed gate back as a fix with the output, then passes', async () => {
    engine = await createTestEngine(
      {
        Alpha: [
          [turn],
          [write('src/api/fixed.txt'), commit('op-fix-0001', ['src/api/fixed.txt']), turn],
        ],
      },
      { gateCommand: 'test -f src/api/fixed.txt || { echo MISSING-FIXED-FILE; exit 2; }' },
    );
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
    expect(ws(workstream.id).state).toBe('DONE');
    expect(engine.adapter.prompts[1]?.prompt).toContain('MISSING-FIXED-FILE');
  });

  it('raises one card for a host the sandbox blocked from a failed gate, naming the host and the command', async () => {
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
      { Alpha: [[turn]] },
      { gateCommand: 'cargo test' },
      { gate: { run: () => Promise.resolve(blocked) } },
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();

    const cards = listInbox(engine.store.db, { states: ['OPEN'] }).filter(
      (c) => c.title === 'Allow network access to index.crates.io?',
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.body).toContain('cargo test');
    expect(cards[0]?.options.map((o) => o.label)).toContain('Allow for the project');
    // The answer allows the host for the whole project, so the card is the project's, not the lane's.
    expect(cards[0]?.targets).toEqual([]);
    const [gate] = listEvidence(engine.store.db, workstream.id);
    expect(gate?.summary).toContain('The gate was blocked from reaching index.crates.io');
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

  it("keeps a blocked host's card open when the lane whose gate raised it is cancelled, while another lane's gate needs the host", async () => {
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
      { Alpha: [[turn]], Beta: [[turn]] },
      { gateCommand: 'cargo test' },
      { gate: { run: () => Promise.resolve(blocked) } },
    );
    const alpha = engine.addTask('Alpha');
    const beta = engine.addTask('Beta', ['ui']);
    engine.launch(alpha.workstream.id);
    await engine.runner.idle();
    engine.launch(beta.workstream.id);
    await engine.runner.idle();
    const hostCards = () =>
      listInbox(engine.store.db, { states: ['OPEN'] }).filter(
        (c) => c.title === 'Allow network access to index.crates.io?',
      );
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
  });

  it('pins the branch at the first session, so a later session never commits where HEAD moved', async () => {
    engine = await createTestEngine({
      Alpha: [
        [askShip, turn],
        [write('src/api/a.txt'), commit('op-pin-0001', ['src/api/a.txt']), turn],
      ],
    });
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

  it('delivers a live answer to the same session', async () => {
    engine = await createTestEngine({
      Alpha: [[askShip, write('src/api/a.txt'), commit('op-live-0001', ['src/api/a.txt']), turn]],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    engine.inbox.answer((await waitFor(openCard)).id, { choice: 'Yes' });
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(listSessions(engine.store.db, workstream.id)).toHaveLength(1);
    expect(engine.adapter.observations).toContainEqual(
      expect.objectContaining({
        kind: 'tool_allowed',
        detail: { toolName: 'AskUserQuestion', answers: { 'Ship it?': 'Yes' } },
      }),
    );
  });

  it('goes STARTING -> RUNNING -> WAITING_HUMAN when the first step is a question', async () => {
    engine = await createTestEngine({ Alpha: [[askShip, turn]] });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    engine.inbox.answer((await waitFor(openCard)).id, { choice: 'Yes' });
    await engine.runner.idle();
    expect(transitions(workstream.id).slice(0, 4)).toEqual([
      'QUEUED->STARTING',
      'STARTING->RUNNING',
      'RUNNING->WAITING_HUMAN',
      'WAITING_HUMAN->RUNNING',
    ]);
    expect(ws(workstream.id)).toMatchObject({ state: 'DONE', recoveryAttempts: 0 });
  });

  it('keeps an answer that arrives while the parked session is still stopping', async () => {
    engine = await createTestEngine({
      Alpha: [
        [askShip, turn],
        [write('src/api/a.txt'), commit('op-grace-0001', ['src/api/a.txt']), turn],
      ],
    });
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

  it.each(['allow_project', 'allow_once'])(
    'applies %s answered after parking, without asking again',
    async (choice) => {
      engine = await createTestEngine({
        Alpha: [
          [curl, turn],
          [curl, write('src/api/a.txt'), commit('op-perm-0001', ['src/api/a.txt']), turn],
        ],
      });
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      const card = await waitFor(openCard);
      engine.clock.advance(10 * 60_000);
      await engine.runner.idle();
      engine.inbox.answer(card.id, { choice });
      engine.launch(workstream.id);
      await engine.runner.idle();

      expect(ws(workstream.id).state).toBe('DONE');
      expect(listInbox(engine.store.db, { states: ['OPEN'] })).toEqual([]);
      expect(
        engine.adapter.observations.filter(
          (o) => o.kind === 'tool_allowed' && o.detail['toolName'] === 'Bash',
        ),
      ).toHaveLength(1);
      expect(engine.adapter.prompts[1]?.prompt).toContain(
        'Allow Bash? curl -s https://example.com',
      );
    },
  );

  it('treats allow_project on a command with no storable rule as allow-once after parking', async () => {
    const unstorable = {
      do: 'tool' as const,
      toolName: 'Bash',
      input: { command: 'echo $(date)' },
    };
    engine = await createTestEngine({
      Alpha: [
        [unstorable, turn],
        [unstorable, write('src/api/a.txt'), commit('op-null-0001', ['src/api/a.txt']), turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const card = await waitFor(openCard);
    engine.clock.advance(10 * 60_000);
    await engine.runner.idle();
    engine.inbox.answer(card.id, { choice: 'allow_project' });
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(ws(workstream.id).state).toBe('DONE');
    expect(listInbox(engine.store.db, { states: ['OPEN'] })).toEqual([]);
    expect(
      engine.adapter.observations.filter(
        (o) => o.kind === 'tool_allowed' && o.detail['toolName'] === 'Bash',
      ),
    ).toHaveLength(1);
  });

  it('runs a listed allowed command without a permission card', async () => {
    engine = await createTestEngine(
      {
        Alpha: [
          [
            shell('pnpm exec prettier --write src/api/a.txt && git status --short && git diff'),
            write('src/api/a.txt'),
            commit('op-allow-0001', ['src/api/a.txt']),
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
    expect(listInbox(engine.store.db, { states: ['OPEN'] })).toEqual([]);
    expect(
      engine.adapter.observations.filter(
        (o) => o.kind === 'tool_allowed' && o.detail['toolName'] === 'Bash',
      ),
    ).toHaveLength(1);
  });

  it('still raises a permission card for a command the project does not allow', async () => {
    engine = await createTestEngine(
      { Alpha: [[shell('pnpm lint'), turn]] },
      { allowedCommands: ['pnpm exec prettier'] },
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const card = await waitFor(openCard);
    expect(card).toMatchObject({ kind: 'permission', title: 'Allow Bash?', body: 'pnpm lint' });
    // The lane waits on the card until a person answers it.
    await waitFor(() => ws(workstream.id).state === 'WAITING_HUMAN');
  });

  it('runs the gate in the session environment, never the daemon process environment', async () => {
    process.env['TENDB_PROBE'] = 'leaked';
    try {
      engine = await createTestEngine(
        { Alpha: [[write('src/api/a.txt'), commit('op-gate-env-1', ['src/api/a.txt']), turn]] },
        { gateCommand: 'test -z "$TENDB_PROBE" && test "$GATE_MARK" = yes' },
        launcherOver({ GATE_MARK: 'yes' }),
      );
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await engine.runner.idle();
      expect(ws(workstream.id).state).toBe('DONE');
    } finally {
      delete process.env['TENDB_PROBE'];
    }
  });

  it('does not hand a continuation session off until it grows past its own starting context', async () => {
    engine = await createTestEngine(
      {
        Alpha: [
          [
            { do: 'context', percentage: 20 },
            { do: 'await_message', contains: 'write_handoff' },
            { do: 'mcp', tool: 'write_handoff', args: handoffArgs('op-base-001', 'Keep going') },
            turn,
          ],
          [
            { do: 'context', percentage: 30 },
            { do: 'context', percentage: 33 },
            { do: 'context', percentage: 36 },
            { do: 'await_message', contains: 'write_handoff' },
            {
              do: 'mcp',
              tool: 'write_handoff',
              args: handoffArgs('op-base-002', 'Write the file'),
            },
            turn,
          ],
          [write('src/api/a.txt'), commit('op-base-003', ['src/api/a.txt']), turn],
        ],
      },
      { handoffPct: 12, nudgePct: 90 },
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');

    const second = listSessions(engine.store.db, workstream.id)[1];
    const events = listEventsAfter(engine.store.db, 0, 1000);
    const handoffs = events.filter(
      (e) => e.type === 'workstream.changed' && e.data['to'] === 'HANDING_OFF',
    );
    const secondHandoff = handoffs[1]?.seq ?? 0;
    const readingsBefore = events
      .filter(
        (e) => e.type === 'session.context' && e.entityId === second?.id && e.seq < secondHandoff,
      )
      .map((e) => e.data['percentage']);
    // 30% + the 5-point margin = 35%: the 30% and 33% readings must not trigger it.
    expect(readingsBefore).toEqual([30, 33, 36]);
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

    it.each<Row>([
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
    ])('$name', async ({ sessions, drive, gateCommand, reasons, resumedSession, baselines }) => {
      engine = await createTestEngine(
        { Alpha: sessions },
        { handoffPct: 12, nudgePct: 90, ...(gateCommand ? { gateCommand } : {}) },
      );
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await drive(workstream.id);

      await waitFor(() => handoffReasons(workstream.id).length === reasons.length, 3_000);
      await engine.runner.idle();
      expect(ws(workstream.id).state).toBe('DONE');
      expect(handoffReasons(workstream.id)).toEqual(reasons);
      const rows = listSessions(engine.store.db, workstream.id);
      expect(rows.map((r) => r.briefingBaselinePct)).toEqual(baselines);
      if (resumedSession === null) {
        expect(engine.adapter.prompts.at(-2)?.resume).toBeNull();
      } else {
        expect(engine.adapter.prompts[resumedSession]).toMatchObject({
          resume: rows[resumedSession - 1]?.providerSessionId,
        });
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
    const BOOK = { Alpha: [[turn]], Beta: [[turn]] };
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
      const start = vi.spyOn(engine.adapter, 'start');
      const { workstream } = engine.addTask(title);
      engine.launch(workstream.id);
      await engine.runner.idle();
      const spec = start.mock.calls.at(-1)?.[0];
      start.mockRestore();
      if (!spec) throw new Error(`${title} never started a session`);
      return spec;
    }

    it('asks once for a server it has not seen, and starts the session without it', async () => {
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

    it("asks again when the server's config changes, and runs without it meanwhile", async () => {
      engine = await createTestEngine(BOOK);
      writeMcp({ mantine: MANTINE });
      await runTask('Alpha');
      answerAll('approve');
      writeMcp({ mantine: { ...MANTINE, args: ['-y', '@mantine/mcp-server@9.8.0'] } });
      const spec = await runTask('Beta');
      expect(spec.projectMcpServers).toEqual({});
      expect(approvalCards().map((c) => c.detail?.[MCP_APPROVAL_DETAIL])).toEqual([
        expect.objectContaining({ args: ['-y', '@mantine/mcp-server@9.8.0'] }),
      ]);
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

  it('parks on the card that is still open when two waits overlap and the first is answered', async () => {
    engine = await createTestEngine({ Alpha: [[{ do: 'hang' }]] });
    const start = vi.spyOn(engine.adapter, 'start');
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
    const first = ask('curl -s https://one.example', 'toolu_1');
    const second = ask('curl -s https://two.example', 'toolu_2');
    const cards = await waitFor(() => {
      const open = listInbox(engine.store.db, { states: ['OPEN'] });
      return open.length === 2 ? open : undefined;
    });
    const one = cards.find((c) => c.body.includes('one.example'));
    const two = cards.find((c) => c.body.includes('two.example'));
    if (!one || !two) throw new Error('expected a card per command');
    engine.inbox.answer(one.id, { choice: 'allow_once' });
    expect(await first).toMatchObject({ behavior: 'allow' });
    engine.clock.advance(10 * 60_000);
    await engine.runner.idle();
    await second;
    expect(ws(workstream.id)).toMatchObject({
      state: 'WAITING_HUMAN',
      nextAction: { kind: 'answer', inboxId: two.id },
    });
  });

  it('hands an answer and its one-time permission to one session only, so a restart cannot grant it again', async () => {
    engine = await createTestEngine({
      Alpha: [
        [curl, turn],
        [curl, { do: 'hang' }],
      ],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const card = await waitFor(openCard);
    engine.clock.advance(10 * 60_000);
    await engine.runner.idle();
    engine.inbox.answer(card.id, { choice: 'allow_once' });
    engine.launch(workstream.id);
    await waitFor(() => ws(workstream.id).state === 'RUNNING');
    // The running session has the answer. Recovery after a restart reads this action, so it must no
    // longer be `answer`; with no handoff yet it is a fresh start, which recovery turns into a resume.
    expect(ws(workstream.id).nextAction).toEqual({ kind: 'start' });
    await engine.runner.stopAll('shutdown');
  });

  describe('lifecycle edges', () => {
    /** Wraps every handle the fake adapter returns; the wrapper sees each call the runner makes. */
    const interceptStart = (wrap: (handle: SessionHandle) => SessionHandle) => {
      const real = engine.adapter.start.bind(engine.adapter);
      return vi.spyOn(engine.adapter, 'start').mockImplementation((spec) => wrap(real(spec)));
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

    it('honours a cancel that arrives before the session starts', async () => {
      engine = await createTestEngine({ Alpha: [doneScript] });
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await engine.runner.cancel(workstream.id);
      expect(ws(workstream.id).state).toBe('CANCELLED');
      expect(engine.adapter.prompts).toEqual([]);
      expect(activeClaims(engine.store.db, workstream.id)).toEqual([]);
    });

    it.each([
      ['a cancel', 'CANCELLED', () => engine.runner.cancel(ws0())],
      [
        'an account pause',
        'DONE',
        () => engine.runner.stopAccount(engine.project.accountId, 'paused'),
      ],
    ])(
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

    it.each([
      ['while the card is open', false, 'WAITING_HUMAN'],
      ['when the card was answered during the stop', true, 'QUEUED'],
    ])(
      'parks normally when the turn completes after the wait timer fired, %s',
      async (_name, answerEarly, expected) => {
        engine = await createTestEngine({ Alpha: [[askShip, turn]] });
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

        expect(ws(workstream.id)).toMatchObject({
          state: expected,
          currentSessionId: null,
          recoveryAttempts: 0,
          nextAction: { kind: 'answer', inboxId: card.id },
        });
        expect(listSessions(engine.store.db, workstream.id)[0]?.exitReason).toBe('parked');
        if (!answerEarly) {
          engine.inbox.answer(card.id, { choice: 'Yes' });
          expect(ws(workstream.id).state).toBe('QUEUED');
        }
      },
    );

    it.each([
      ['an account pause', () => engine.runner.stopAccount(engine.project.accountId, 'paused')],
      ['a shutdown', () => engine.runner.stopAll('shutdown')],
    ])(
      'keeps an answer that lands while %s is still stopping a waiting session',
      async (_name, act) => {
        engine = await createTestEngine({
          Alpha: [
            [askShip, { do: 'hang' }],
            [write('src/api/a.txt'), commit('op-slow-0001', ['src/api/a.txt']), turn],
          ],
        });
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

    it.each([
      ['a question answer', askShip, 'Yes', [...doneScript], 'Answer: Yes'],
      [
        'an allow_once permission',
        curl,
        'allow_once',
        [curl, ...doneScript],
        'Allow Bash? curl -s https://example.com',
      ],
    ])(
      'carries %s into the next session when the answered session crashes before it starts',
      async (_name, ask, choice, finalScript, promptText) => {
        engine = await createTestEngine({ Alpha: [[ask, turn], [crash], finalScript] });
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

    it('carries the gate failure into the next session when the fix session crashes before it starts', async () => {
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
      engine.launch(workstream.id);
      await engine.runner.idle();
      expect(ws(workstream.id)).toMatchObject({
        state: 'QUEUED',
        recoveryAttempts: 1,
        nextAction: { kind: 'fix' },
      });

      engine.launch(workstream.id);
      await engine.runner.idle();
      expect(ws(workstream.id).state).toBe('DONE');
      expect(engine.adapter.prompts[2]?.prompt).toContain('MISSING-FIXED-FILE');
    });

    it('keeps a rejected usage limit when the turn completes afterwards', async () => {
      engine = await createTestEngine({
        Alpha: [[{ do: 'rate_limit', status: 'rejected', resetsInSeconds: 600 }]],
      });
      interceptStart((h) => ({
        ...h,
        events: (async function* () {
          for await (const event of h.events) {
            yield event;
            if (event.type === 'rate_limit')
              yield {
                type: 'turn_complete' as const,
                inputTokens: 1,
                outputTokens: 1,
                cachedTokens: 0,
                costUsd: 0,
              };
          }
        })(),
      }));
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await engine.runner.idle();
      expect(ws(workstream.id).state).toBe('PAUSED_LIMIT');
      expect(engine.rateLimited).toHaveLength(1);
    });
  });

  it('resets the crash count once a session makes progress', async () => {
    engine = await createTestEngine({
      Alpha: [
        [{ do: 'crash', message: 'boom' }],
        [write('src/api/a.txt'), commit('op-reset-0001', ['src/api/a.txt']), turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).recoveryAttempts).toBe(1);
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({ state: 'DONE', recoveryAttempts: 0 });
  });

  it('cancels during verification by killing the gate', async () => {
    engine = await createTestEngine({ Alpha: [[turn]] }, { gateCommand: 'sleep 30' });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await waitFor(() => ws(workstream.id).state === 'VERIFYING');
    const started = Date.now();
    await engine.runner.cancel(workstream.id);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(ws(workstream.id).state).toBe('CANCELLED');
    expect(listEvidence(engine.store.db, workstream.id)).toEqual([]);
  });

  describe('while the Mac is overloaded', () => {
    /** A hold the test opens, as the load guard does; `asked` counts the sessions that waited on it. */
    function fakeHold() {
      let open: () => void = () => undefined;
      let overloaded = true;
      const asked: (AbortSignal | undefined)[] = [];
      return {
        asked,
        release: () => {
          overloaded = false;
          open();
        },
        hold: {
          untilClear: (signal?: AbortSignal) => {
            asked.push(signal);
            if (!overloaded) return Promise.resolve(true);
            return new Promise<boolean>((resolve) => {
              open = () => {
                resolve(true);
              };
              signal?.addEventListener('abort', () => {
                resolve(false);
              });
            });
          },
        },
      };
    }

    it('starts no session until the load falls, then runs the lane as usual', async () => {
      const fake = fakeHold();
      engine = await createTestEngine({ Alpha: [[turn]] }, {}, { hold: fake.hold });
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await waitFor(() => fake.asked.length > 0);
      expect(listSessions(engine.store.db, workstream.id)).toEqual([]);
      expect(engine.adapter.prompts).toHaveLength(0);
      fake.release();
      await engine.runner.idle();
      expect(ws(workstream.id).state).toBe('DONE');
      expect(listSessions(engine.store.db, workstream.id)).toHaveLength(1);
    });

    it('ends a held lane at once when it is cancelled, with no session started', async () => {
      const fake = fakeHold();
      engine = await createTestEngine({ Alpha: [[turn]] }, {}, { hold: fake.hold });
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await waitFor(() => fake.asked.length > 0);
      await engine.runner.cancel(workstream.id);
      expect(ws(workstream.id).state).toBe('CANCELLED');
      expect(listSessions(engine.store.db, workstream.id)).toEqual([]);
    });
  });

  it('retries crashes as resume, then fresh, and fails after the limit with a flag', async () => {
    const crash = { do: 'crash' as const, message: 'boom' };
    engine = await createTestEngine({ Alpha: [[crash], [crash], [crash], [crash]] });
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
    expect(listInbox(engine.store.db, { states: ['OPEN'] }).map((i) => i.kind)).toEqual(['flag']);
  });

  it('hands the builder’s retry note to the next session after crashes failed the workstream', async () => {
    const crash = { do: 'crash' as const, message: 'boom' };
    engine = await createTestEngine({
      Alpha: [[crash], [crash], [crash], [crash], [turn]],
    });
    const { workstream } = engine.addTask('Alpha');
    for (let i = 0; i < 4; i += 1) {
      engine.launch(workstream.id);
      await engine.runner.idle();
    }
    expect(ws(workstream.id).state).toBe('FAILED');
    engine.retry(workstream.id, 'The fixture server needs port 4100.');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(engine.adapter.prompts.at(-1)?.prompt).toContain(
      'The builder sent the work back: The fixture server needs port 4100.',
    );
  });

  it('fails at once on a billing refusal, without retrying it as a crash', async () => {
    const refusal =
      "Billing check failed: expected the Claude subscription, got an API key. No prompt was sent. <b>Check</b> the project's billing mode.";
    engine = await createTestEngine({
      Alpha: [[{ do: 'billing_refused', message: refusal }], [turn]],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({ state: 'FAILED', failureReason: refusal });
    expect(listSessions(engine.store.db, workstream.id)).toHaveLength(1);
    expect(transitions(workstream.id).filter((t) => t.endsWith('->RECOVERING'))).toEqual([]);
    const cards = listInbox(engine.store.db, { states: ['OPEN'] });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: 'flag', body: refusal });
  });

  it('cancels a running workstream, releasing claims', async () => {
    engine = await createTestEngine({
      Alpha: [[{ do: 'activity', summary: 'working' }, { do: 'hang' }]],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await waitFor(
      () => listSessions(engine.store.db, workstream.id)[0]?.providerSessionId ?? undefined,
    );
    await engine.runner.cancel(workstream.id);
    expect(ws(workstream.id).state).toBe('CANCELLED');
    expect(activeClaims(engine.store.db, workstream.id)).toEqual([]);
  });

  it('pauses on a usage limit until the reported reset', async () => {
    engine = await createTestEngine({
      Alpha: [[{ do: 'rate_limit', status: 'rejected', resetsInSeconds: 600 }]],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('PAUSED_LIMIT');
    expect(ws(workstream.id).pausedUntil).not.toBeNull();
    expect(engine.rateLimited).toHaveLength(1);
  });

  it('logs emergency compaction as a deviation and re-sends the context pack', async () => {
    engine = await createTestEngine({
      Alpha: [[{ do: 'compact' }, { do: 'await_message', contains: 'context pack' }, turn]],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(engine.store.db.select().from(schema.deviations).all()).toHaveLength(1);
  });

  it('runs the after-session check once per session, and survives it throwing', async () => {
    const seen: string[] = [];
    engine = await createTestEngine(
      { Alpha: [[write('src/api/a.txt'), commit('op-after-001', ['src/api/a.txt']), turn]] },
      {},
      {
        afterSession: (id) => {
          seen.push(id);
          return Promise.reject(new Error('watcher broke'));
        },
      },
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(seen).toEqual([workstream.id]);
    expect(ws(workstream.id).state).toBe('DONE');
  });

  it('stops a lane at its next session once its account reaches the monthly cap', async () => {
    engine = await createTestEngine(
      {
        Alpha: [
          [{ do: 'mcp', tool: 'write_handoff', args: handoffArgs('op-cap-0001', 'finish') }, turn],
          [turn],
        ],
      },
      {},
      {},
      {
        account: { kind: 'anthropic_api_key', label: 'Capped', monthlyCapUsd: 0.01 },
        secret: 'sk-ant-api03-cap-test-key',
      },
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(listSessions(engine.store.db, workstream.id)).toHaveLength(1);
    expect(ws(workstream.id)).toMatchObject({
      state: 'PAUSED_LIMIT',
      nextAction: { kind: 'continue_from_handoff' },
    });
    expect(listInbox(engine.store.db, { states: ['OPEN'] }).map((i) => i.title)).toEqual([
      'Capped reached its monthly cap',
    ]);
  });
});

describe('accounts', () => {
  it('pauses the account and sends no prompt when the identity differs, then resumes after Resume', async () => {
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

  it('pauses the account when its Keychain cannot be read, and retries the lane after Resume', async () => {
    engine = await createTestEngine(
      { Alpha: [[turn]] },
      {},
      {},
      {
        account: { kind: 'anthropic_api_key', label: 'Client key' },
        secret: 'sk-ant-api03-original-key',
      },
    );
    const unlocked = engine.keychain.read.bind(engine.keychain);
    let locked = true;
    engine.keychain.read = (account) => {
      if (!locked) return unlocked(account);
      throw new KeychainError(`Reading the Keychain item ${account} failed (timed out after 5 s)`);
    };
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(listSessions(engine.store.db, workstream.id)).toEqual([]);
    expect(ws(workstream.id)).toMatchObject({
      state: 'PAUSED_LIMIT',
      nextAction: { kind: 'start' },
    });
    expect(transitions(workstream.id).filter((t) => t.endsWith('->FAILED'))).toEqual([]);
    expect(engine.accounts.isPaused(engine.project.accountId)).toBe(true);
    const [card, ...others] = listInbox(engine.store.db, { states: ['OPEN'] });
    expect(others).toEqual([]);
    expect(card?.title).toBe('Client key: sessions refused');
    expect(card?.body).toContain('Unlock the login Keychain');
    expect(card?.detail?.[ACCOUNT_CARD_DETAIL]).toMatchObject({
      reason: 'refused',
      problem: 'keychain_unavailable',
    });

    locked = false;
    if (!card) throw new Error('no refusal card');
    engine.inbox.answer(card.id, { choice: AccountCardChoice.Resume });
    expect(engine.accounts.isPaused(engine.project.accountId)).toBe(false);
    expect(ws(workstream.id).state).toBe('QUEUED');
  });

  it('resumes the same conversation after credentials expired mid-session', async () => {
    engine = await createTestEngine({
      Alpha: [
        [
          { do: 'activity', summary: 'working' },
          { do: 'auth_error', error: 'authentication_failed' },
        ],
      ],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({
      state: 'PAUSED_LIMIT',
      nextAction: { kind: 'resume' },
    });
    expect(listInbox(engine.store.db, { states: ['OPEN'] })[0]?.body).toContain('claude /login');
  });

  it('fails the workstream at once when the model differs', async () => {
    engine = await createTestEngine({ Alpha: [[turn]] });
    engine.adapter.seen = () => ({ model: 'claude-opus-5-5' });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({ state: 'FAILED' });
    expect(ws(workstream.id).failureReason).toMatch(/Model check failed/);
    // A model mismatch is the work's, not the account's: the account isn't paused and no account card opens.
    expect(engine.accounts.isPaused(engine.project.accountId)).toBe(false);
    expect(
      listInbox(engine.store.db, { states: ['OPEN'] }).filter(
        (i) => i.detail?.[ACCOUNT_CARD_DETAIL] !== undefined,
      ),
    ).toEqual([]);
  });

  it('keeps a parked answer for the next session when the account is refused before it starts', async () => {
    engine = await createTestEngine({
      Alpha: [
        [askShip, turn],
        [write('src/api/a.txt'), commit('op-ans-0001', ['src/api/a.txt']), turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const card = await waitFor(openCard);
    engine.clock.advance(10 * 60_000);
    await engine.runner.idle();
    engine.inbox.answer(card.id, { choice: 'Yes' });
    // The answer session resumes a conversation, so it has a provider session id from the start.
    engine.adapter.seen = () => ({ email: 'someone-else@example.com' });
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({
      state: 'PAUSED_LIMIT',
      nextAction: { kind: 'answer', inboxId: card.id },
    });
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

  it('starts one session at a time on a subscription account', async () => {
    engine = await createTestEngine({ Alpha: [[turn]] });
    const release = await engine.startGate.acquire(engine.project.accountId);
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await waitFor(() => engine.startGate.waiting(engine.project.accountId) === 1);
    expect(engine.adapter.prompts).toEqual([]);
    release();
    await engine.runner.idle();
    expect(engine.adapter.prompts).toHaveLength(1);
    expect(engine.startGate.waiting(engine.project.accountId)).toBe(0);
  });

  it('re-queues a lane whose subscription account lost its identity, and asks the preparer', async () => {
    engine = await createTestEngine({ Alpha: [[turn]] });
    engine.state.write((ctx) =>
      patchAccount(ctx, engine.project.accountId, { expectedIdentity: null }),
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(listSessions(engine.store.db, workstream.id)).toEqual([]);
    expect(ws(workstream.id)).toMatchObject({ state: 'QUEUED', nextAction: { kind: 'start' } });
    expect(engine.prepared).toEqual([
      { accountId: engine.project.accountId, projectId: engine.project.id },
    ]);
    // Unready is prepared, never refused: no pause and no refusal card.
    expect(engine.accounts.isPaused(engine.project.accountId)).toBe(false);
    expect(listInbox(engine.store.db, { states: ['OPEN'] })).toEqual([]);
  });

  it('re-queues a lane between sessions when its account lost its identity, keeping the handoff', async () => {
    engine = await createTestEngine(
      {
        Alpha: [
          [{ do: 'mcp', tool: 'write_handoff', args: handoffArgs('op-ready-001', 'finish') }, turn],
          [turn],
        ],
      },
      {},
      {
        afterSession: () => {
          engine.state.write((ctx) =>
            patchAccount(ctx, engine.project.accountId, { expectedIdentity: null }),
          );
          return Promise.resolve();
        },
      },
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(listSessions(engine.store.db, workstream.id)).toHaveLength(1);
    expect(ws(workstream.id)).toMatchObject({
      state: 'QUEUED',
      nextAction: { kind: 'continue_from_handoff' },
    });
    expect(engine.prepared).toEqual([
      { accountId: engine.project.accountId, projectId: engine.project.id },
    ]);
    expect(engine.accounts.isPaused(engine.project.accountId)).toBe(false);
    expect(listInbox(engine.store.db, { states: ['OPEN'] })).toEqual([]);
  });

  it('confirms a different identity from a refusal card, resumes the account and re-queues the lane', async () => {
    engine = await createTestEngine({ Alpha: [[turn]] });
    engine.adapter.seen = () => ({ email: 'someone-else@example.com' });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(engine.accounts.isPaused(engine.project.accountId)).toBe(true);
    const card = listInbox(engine.store.db, { states: ['OPEN'] })[0];
    if (!card) throw new Error('no refusal card');
    expect(card.options.map((o) => o.label)).toContain('Confirm');
    engine.inbox.answer(card.id, { choice: AccountCardChoice.Confirm });
    expect(getAccount(engine.store.db, engine.project.accountId).expectedIdentity).toBe(
      'someone-else@example.com',
    );
    expect(engine.accounts.isPaused(engine.project.accountId)).toBe(false);
    expect(ws(workstream.id).state).toBe('QUEUED');
  });

  it('releases the start gate when the adapter throws on a subscription account', async () => {
    engine = await createTestEngine({ Alpha: [[turn]] });
    engine.adapter.start = () => {
      throw new Error('spawn failed');
    };
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(engine.startGate.waiting(engine.project.accountId)).toBe(0);
    // A leaked holder would leave this acquire pending forever.
    (await engine.startGate.acquire(engine.project.accountId))();
  });
});

/** A second subscription, confirmed, so a session on it is ready and reports what it expects. */
const secondPlan = () => {
  const account = seedAccount(engine.store, {
    kind: 'claude_subscription',
    label: 'Second plan',
  });
  engine.state.write((ctx) =>
    patchAccount(ctx, account.id, { expectedIdentity: 'second@example.com' }),
  );
  return account;
};
const moveTo = (accountId: AccountId) =>
  engine.state.write((ctx) => patchProject(ctx, engine.project.id, { accountId }));
/** What the scheduler does once the new account isn't paused. */
const requeue = (id: Parameters<typeof getWorkstream>[1]) =>
  engine.state.write((ctx) => transitionWorkstream(ctx, id, { to: 'QUEUED', fence: null }));

describe('moving accounts', () => {
  const accountsOf = (id: Parameters<typeof getWorkstream>[1]) =>
    listSessions(engine.store.db, id).map((s) => s.accountId);

  it('starts a fresh session from the handoff when the project moved off the account its conversation ran on', async () => {
    engine = await createTestEngine({
      Alpha: [
        [
          {
            do: 'mcp',
            tool: 'write_handoff',
            args: handoffArgs('op-move-0001', 'Write the second file'),
          },
          { do: 'rate_limit', status: 'rejected', resetsInSeconds: 600 },
        ],
        [write('src/api/b.txt'), commit('op-move-0002', ['src/api/b.txt']), turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({
      state: 'PAUSED_LIMIT',
      nextAction: { kind: 'resume' },
    });

    const second = secondPlan();
    moveTo(second.id);
    requeue(workstream.id);
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(accountsOf(workstream.id)).toEqual([engine.project.accountId, second.id]);
    expect(engine.adapter.prompts[1]).toMatchObject({ resume: null });
    expect(engine.adapter.prompts[1]?.prompt).toContain('Next action: Write the second file');
  });

  it("brings the builder's answer to a fresh session after the project moved", async () => {
    engine = await createTestEngine({
      Alpha: [
        [askShip, turn],
        [write('src/api/a.txt'), commit('op-moveask-01', ['src/api/a.txt']), turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const card = await waitFor(openCard);
    engine.clock.advance(10 * 60_000);
    await engine.runner.idle();
    expect(ws(workstream.id).nextAction).toMatchObject({ kind: 'answer', inboxId: card.id });

    moveTo(secondPlan().id);
    engine.inbox.answer(card.id, { choice: 'Yes' });
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(engine.adapter.prompts[1]).toMatchObject({ resume: null });
    expect(engine.adapter.prompts[1]?.prompt).toContain('Answer: Yes');
    expect(engine.adapter.prompts[1]?.prompt).toContain('inspect git status first');
  });

  it('keeps the gate failure a lane was fixing when the project moved', async () => {
    engine = await createTestEngine(
      {
        Alpha: [
          [turn],
          [
            {
              do: 'mcp',
              tool: 'write_handoff',
              args: handoffArgs('op-movefix-00', 'Create src/api/fixed.txt'),
            },
            { do: 'rate_limit', status: 'rejected', resetsInSeconds: 600 },
          ],
          [write('src/api/fixed.txt'), commit('op-movefix-01', ['src/api/fixed.txt']), turn],
        ],
      },
      { gateCommand: 'test -f src/api/fixed.txt || { echo MISSING-FIXED-FILE; exit 2; }' },
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).nextAction).toMatchObject({ kind: 'fix' });
    // The test clock is frozen: the fix session's handoff is written after the gate failure.
    engine.clock.advance(1_000);
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({
      state: 'PAUSED_LIMIT',
      nextAction: { kind: 'resume' },
    });

    moveTo(secondPlan().id);
    requeue(workstream.id);
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(engine.adapter.prompts[2]).toMatchObject({ resume: null });
    expect(engine.adapter.prompts[2]?.prompt).toContain('MISSING-FIXED-FILE');
    expect(engine.adapter.prompts[2]?.prompt).toContain('Next action: Create src/api/fixed.txt');
  });

  it("runs a lane's next session on the account its project moved to while the first one ran", async () => {
    const moved: { to: AccountId | null } = { to: null };
    engine = await createTestEngine(
      {
        Alpha: [
          [
            { do: 'context', percentage: 75 },
            { do: 'await_message', contains: 'write_handoff' },
            {
              do: 'mcp',
              tool: 'write_handoff',
              args: handoffArgs('op-movelane-1', 'Write the second file'),
            },
            turn,
          ],
          [write('src/api/b.txt'), commit('op-movelane-2', ['src/api/b.txt']), turn],
        ],
      },
      {},
      {
        // The builder moves the project while the first session runs; it ends on the old account.
        afterSession: () => {
          if (moved.to === null) {
            moved.to = secondPlan().id;
            moveTo(moved.to);
          }
          return Promise.resolve();
        },
      },
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    // What each session was launched on, and what its row records, are the same account.
    const launchedOn = engine.adapter.prompts.map((p) => p.accountId);
    expect(launchedOn).toEqual([engine.project.accountId, moved.to]);
    expect(accountsOf(workstream.id)).toEqual(launchedOn);
  });

  it('runs on the account the project moved to while the lane waited for its start', async () => {
    engine = await createTestEngine({
      Alpha: [[write('src/api/a.txt'), commit('op-movegate-1', ['src/api/a.txt']), turn]],
    });
    const release = await engine.startGate.acquire(engine.project.accountId);
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await waitFor(() => engine.startGate.waiting(engine.project.accountId) === 1);
    const second = secondPlan();
    moveTo(second.id);
    release();
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(engine.adapter.prompts.map((p) => p.accountId)).toEqual([second.id]);
    expect(accountsOf(workstream.id)).toEqual([second.id]);
    // The slot the lane gave back is free: a leak would leave every later session on that account waiting.
    const slot = engine.startGate.acquire(engine.project.accountId);
    await waitFor(() => engine.startGate.waiting(engine.project.accountId) === 0);
    (await slot)();
  });

  it('keeps the gate failure a fix session was answered on after the project moved', async () => {
    engine = await createTestEngine(
      {
        Alpha: [
          [turn],
          [askShip, turn],
          [write('src/api/fixed.txt'), commit('op-moveans-01', ['src/api/fixed.txt']), turn],
        ],
      },
      { gateCommand: 'test -f src/api/fixed.txt || { echo MISSING-FIXED-FILE; exit 2; }' },
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).nextAction).toMatchObject({ kind: 'fix' });
    engine.launch(workstream.id);
    const card = await waitFor(openCard);
    engine.clock.advance(10 * 60_000);
    await engine.runner.idle();
    expect(ws(workstream.id).nextAction).toMatchObject({ kind: 'answer', inboxId: card.id });

    moveTo(secondPlan().id);
    engine.inbox.answer(card.id, { choice: 'Yes' });
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(engine.adapter.prompts[2]).toMatchObject({ resume: null });
    expect(engine.adapter.prompts[2]?.prompt).toContain('MISSING-FIXED-FILE');
    expect(engine.adapter.prompts[2]?.prompt).toContain('Answer: Yes');
  });

  it('resumes the conversation when the project moves away and back before a session launches', async () => {
    engine = await createTestEngine({
      Alpha: [
        [
          { do: 'mcp', tool: 'write_handoff', args: handoffArgs('op-moveback-1', 'Write b') },
          { do: 'rate_limit', status: 'rejected', resetsInSeconds: 600 },
        ],
        [write('src/api/b.txt'), commit('op-moveback-2', ['src/api/b.txt']), turn],
      ],
    });
    const home = engine.project.accountId;
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).nextAction).toMatchObject({ kind: 'resume' });
    const first = listSessions(engine.store.db, workstream.id)[0]?.providerSessionId;

    // The new account has no confirmed identity, so no session launches on it.
    const unconfirmed = seedAccount(engine.store, {
      kind: 'claude_subscription',
      label: 'Unconfirmed plan',
    });
    moveTo(unconfirmed.id);
    requeue(workstream.id);
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(engine.adapter.prompts).toHaveLength(1);

    moveTo(home);
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(engine.adapter.prompts[1]?.resume).toBe(first);
  });

  it('does not settle the lane on the account the project left while its head was read', async () => {
    engine = await createTestEngine(
      {
        Alpha: [[write('src/api/a.txt'), commit('op-movehead-1', ['src/api/a.txt']), turn]],
      },
      {},
      {},
      { account: { kind: 'claude_subscription', label: 'Unconfirmed plan' } },
    );
    const { workstream } = engine.addTask('Alpha');
    // launch runs the lane up to its first await, the read of the repository head.
    engine.launch(workstream.id);
    const second = secondPlan();
    moveTo(second.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(engine.prepared).toEqual([]);
    expect(accountsOf(workstream.id)).toEqual([second.id]);
  });

  it('honours a cancel that lands while the head is read, before the account is checked', async () => {
    engine = await createTestEngine(
      { Alpha: [[turn]] },
      {},
      {},
      { account: { kind: 'anthropic_api_key', label: 'Client key' } },
    );
    const { workstream } = engine.addTask('Alpha');
    // launch runs the lane up to its first await, the read of the repository head.
    engine.launch(workstream.id);
    await engine.runner.cancel(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('CANCELLED');
    // The account has no secret, so a lane that went on would have been sent back to be prepared.
    expect(engine.prepared).toEqual([]);
    expect(engine.adapter.prompts).toEqual([]);
  });

  it('lets a running session finish on its account when the project moves, and runs the next on the new one', async () => {
    engine = await createTestEngine({
      Alpha: [
        [askShip, { do: 'rate_limit', status: 'rejected', resetsInSeconds: 600 }],
        [write('src/api/b.txt'), commit('op-moverun-02', ['src/api/b.txt']), turn],
      ],
    });
    const home = engine.project.accountId;
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const card = await waitFor(openCard);
    const second = secondPlan();
    moveTo(second.id);
    // The running session isn't stopped by the move; it ends on the account it started on.
    expect(engine.adapter.prompts).toHaveLength(1);
    engine.inbox.answer(card.id, { choice: 'Yes' });
    await engine.runner.idle();
    expect(engine.rateLimited.map((r) => r.accountId)).toEqual([home]);
    expect(engine.sessionsEnded.map((e) => e.accountId)).toEqual([home]);
    expect(ws(workstream.id).state).toBe('PAUSED_LIMIT');

    requeue(workstream.id);
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(engine.adapter.prompts.map((p) => p.accountId)).toEqual([home, second.id]);
    expect(accountsOf(workstream.id)).toEqual([home, second.id]);
    expect(engine.sessionsEnded.map((e) => e.accountId)).toEqual([home, second.id]);
  });

  it('resumes the conversation when the lane was stopped waiting for the new account and the project moves back', async () => {
    engine = await createTestEngine({
      Alpha: [
        [
          { do: 'mcp', tool: 'write_handoff', args: handoffArgs('op-movestop-1', 'Write b') },
          { do: 'rate_limit', status: 'rejected', resetsInSeconds: 600 },
        ],
        [write('src/api/b.txt'), commit('op-movestop-2', ['src/api/b.txt']), turn],
      ],
    });
    const home = engine.project.accountId;
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    const first = listSessions(engine.store.db, workstream.id)[0]?.providerSessionId;

    const second = secondPlan();
    const hold = await engine.startGate.acquire(second.id);
    moveTo(second.id);
    requeue(workstream.id);
    engine.launch(workstream.id);
    await waitFor(() => engine.startGate.waiting(second.id) === 1);
    // The new account hits its usage limit: its lanes are stopped, this one before any session ran there.
    const stopped = engine.runner.stopAccount(second.id, 'paused');
    hold();
    await stopped;
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({
      state: 'PAUSED_LIMIT',
      nextAction: { kind: 'resume', providerSessionId: first },
    });

    moveTo(home);
    requeue(workstream.id);
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(engine.adapter.prompts[1]?.resume).toBe(first);
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

  it('nudges a lane once however often it is asked, then firmly in the account words', async () => {
    engine = await createTestEngine({
      Alpha: [
        [
          { do: 'await_message', contains: 'near its usage limit' },
          // The turn ends with no handoff written: the firm nudge follows.
          turn,
          { do: 'await_message', contains: 'about to reach its usage limit' },
          {
            do: 'mcp',
            tool: 'write_handoff',
            args: handoffArgs('op-usage-0003', 'Write the second file'),
          },
          turn,
        ],
        [write('src/api/b.txt'), commit('op-usage-0004', ['src/api/b.txt']), turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await waitFor(() => engine.adapter.prompts.length === 1);
    const { accountId, id: projectId } = engine.project;
    engine.runner.handOff(projectId, accountId, 'first');
    engine.runner.handOff(projectId, accountId, 'second');
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    const sent = engine.adapter.sent.map((m) => m.text);
    expect(sent.filter((text) => text === HANDOFF_NUDGE_ACCOUNT)).toHaveLength(1);
    expect(sent.filter((text) => text === HANDOFF_FIRM_NUDGE_ACCOUNT)).toHaveLength(1);
    expect(sent).not.toContain(HANDOFF_NUDGE);
    expect(sent).not.toContain(HANDOFF_FIRM_NUDGE);
  });

  it('moves a project with a fallback when a session ends rate limited with no report', async () => {
    engine = await createTestEngine({
      Alpha: [[{ do: 'end', reason: 'rate_limited' }]],
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
    expect(engine.usageReports.map((r) => r.report.status)).toEqual(['rejected']);
    expect(getProject(engine.store.db, engine.project.id).accountId).toBe(fallback.id);
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

  it('runs implement then review to DONE when the reviewer approves', async () => {
    engine = await createTestEngine({
      Alpha: [implement('op-flow-0001'), [approve('op-flow-0002'), turn]],
    });
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({
      state: 'QUEUED',
      stepIndex: 1,
      model: 'opus',
      effort: 'medium',
    });
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(ws(workstream.id).steps.map((s) => s.status)).toEqual(['done', 'done']);
    expect(engine.adapter.prompts[1]?.prompt).toContain('Your step: 2 of 2, review, as Reviewer.');
    expect(
      listEvidence(engine.store.db, workstream.id).filter((e) => e.kind === 'gate'),
    ).toHaveLength(1);
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
      model: 'opus',
      effort: 'low',
      attempts: 1,
      reason: 'escalated from sonnet@high after the review step rejected it',
    });
    expect(ws(workstream.id).attempt).toBe(1);
    engine.launch(workstream.id); // the second gate passed; review again
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
  });

  const noVerdict = [turn, { do: 'await_message' as const, contains: RESULT_NUDGE }, turn];

  describe('a review session that ends without a verdict', () => {
    it('runs the review once more by itself, and the second session can approve', async () => {
      engine = await createTestEngine({
        Alpha: [implement('op-flow-0021'), noVerdict, [approve('op-flow-0022'), turn]],
      });
      const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
      await until(workstream.id, (s) => s === 'DONE', 2);
      expect(ws(workstream.id).state).toBe('DONE');
      expect(step(workstream.id, 1)?.result?.verdict).toBe('approve');
      expect(listSessions(engine.store.db, workstream.id).map((s) => s.exitReason)).toEqual([
        'step_done',
        'step_done',
        'step_done',
      ]);
      expect(listInbox(engine.store.db, { states: ['OPEN'] }).map((i) => i.kind)).not.toContain(
        'flag',
      );
    });

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
      });
      expect(listSessions(engine.store.db, workstream.id)).toHaveLength(3);
      expect(step(workstream.id, 1)?.status).toBe('failed');
      expect(listInbox(engine.store.db, { states: ['OPEN'] }).map((i) => i.kind)).toContain('flag');
    });

    it('says in the failure how the last session ended: its turn limit and the context it used', async () => {
      engine = await createTestEngine(
        {
          Alpha: [
            implement('op-flow-0024'),
            noVerdict,
            [
              { do: 'context', percentage: 63 },
              { do: 'turn_complete', result: 'max_turns' },
              { do: 'await_message', contains: RESULT_NUDGE },
              { do: 'turn_complete', result: 'max_turns' },
            ],
          ],
        },
        { handoffPct: 80, nudgePct: 95 }, // below the line: this session was never asked to hand off
      );
      const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
      await until(workstream.id, (s) => s === 'FAILED', 2);
      expect(ws(workstream.id).failureReason).toBe(
        'The review step ended without calling complete_step: its last turn stopped at the turn limit, with 63% of its context used.',
      );
    });

    it('says when the last turn ended with an error', async () => {
      engine = await createTestEngine({
        Alpha: [
          implement('op-flow-0025'),
          noVerdict,
          [
            { do: 'turn_complete', result: 'error' },
            { do: 'await_message', contains: RESULT_NUDGE },
            { do: 'turn_complete', result: 'error' },
          ],
        ],
      });
      const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
      await until(workstream.id, (s) => s === 'FAILED', 2);
      expect(ws(workstream.id).failureReason).toBe(
        'The review step ended without calling complete_step: its last turn ended with an error.',
      );
    });

    it('gives a review the builder retried its own rerun again', async () => {
      engine = await createTestEngine({
        Alpha: [
          implement('op-flow-002a'),
          noVerdict,
          noVerdict,
          noVerdict,
          [approve('op-flow-002b'), turn],
        ],
      });
      const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
      await until(workstream.id, (s) => s === 'FAILED', 3);
      expect(ws(workstream.id).state).toBe('FAILED');
      engine.retry(workstream.id);
      // The retried review ends without a verdict once more: it runs again rather than failing.
      engine.launch(workstream.id);
      await engine.runner.idle();
      expect(ws(workstream.id).state).toBe('DONE');
      expect(step(workstream.id, 1)?.result?.verdict).toBe('approve');
      expect(listSessions(engine.store.db, workstream.id)).toHaveLength(5);
    });

    it('gives each review its own rerun after the work is sent back', async () => {
      engine = await createTestEngine({
        Alpha: [
          implement('op-flow-0026'),
          noVerdict,
          [reject('op-flow-0027'), turn],
          implement('op-flow-0028'),
          noVerdict,
          [approve('op-flow-0029'), turn],
        ],
      });
      const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
      await until(workstream.id, (s) => s === 'DONE');
      expect(ws(workstream.id).state).toBe('DONE');
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

    it('hands off with its findings so far, and a fresh session continues from them', async () => {
      engine = await createTestEngine(
        {
          Alpha: [
            implement('op-flow-0141'),
            lowOnContext('op-flow-0142'),
            [approve('op-flow-0143'), turn],
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
      ]);
      const continued = engine.adapter.prompts[2]?.prompt ?? '';
      expect(continued).toContain('Continue from the handoff below');
      expect(continued).toContain('Next action: Check the empty state, then give the verdict');
      expect(continued).toContain('Your step: 2 of 2, review');
    });

    it('a rerun after a handoff continues from that handoff', async () => {
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
      expect(engine.adapter.prompts[3]?.prompt).toContain('Continue from the handoff below');
    });
  });

  it('accepts a verdict given after the nudge', async () => {
    engine = await createTestEngine({
      Alpha: [
        implement('op-flow-0031'),
        [turn, { do: 'await_message', contains: RESULT_NUDGE }, approve('op-flow-0032'), turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
    // The script waits for the exact nudge text, so a nudge that was never sent hangs the review.
    await until(workstream.id, (s) => s === 'DONE');
    expect(ws(workstream.id).state).toBe('DONE');
    expect(ws(workstream.id).steps.map((s) => s.status)).toEqual(['done', 'done']);
    expect(step(workstream.id, 1)?.result?.verdict).toBe('approve');
  });

  it('records a verdict whose opId an earlier session of the task already used', async () => {
    // Two incident reviews reused one readable opId: the daemon answered "Recorded" from the first
    // session's reply and wrote nothing, so the step failed for a verdict the reviewer had given.
    engine = await createTestEngine({
      Alpha: [
        implement('op-flow-0033'),
        [turn, { do: 'await_message', contains: RESULT_NUDGE }, reject('op-review-same'), turn],
        implement('op-flow-0034'),
        [turn, { do: 'await_message', contains: RESULT_NUDGE }, approve('op-review-same'), turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
    await until(workstream.id, (s) => s === 'DONE');
    expect(ws(workstream.id).state).toBe('DONE');
    expect(step(workstream.id, 1)?.result?.verdict).toBe('approve');
  });

  describe('a review that wrote its findings as text and never recorded them', () => {
    const FINDINGS = '1. BLOCKING src/api/a.txt:3 the empty state has no test.\n   Add one.';
    const wrote = (text: string) => [
      { do: 'turn_complete' as const, text },
      { do: 'await_message' as const, contains: RESULT_NUDGE },
      { do: 'turn_complete' as const, text: 'The findings are above.' },
    ];

    it('fails with a card that carries what it wrote, so the builder can act on it', async () => {
      engine = await createTestEngine({
        Alpha: [implement('op-flow-0035'), wrote(FINDINGS), wrote(FINDINGS)],
      });
      const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
      await until(workstream.id, (s) => s === 'FAILED', 2);
      expect(ws(workstream.id).failureReason).toBe(
        'The review step ended without calling complete_step: its last turn ended normally. What it wrote is on the card.',
      );
      const card = listInbox(engine.store.db, { states: ['OPEN'] }).find((i) => i.kind === 'flag');
      const detail = ReviewCardDetail.parse(card?.detail?.['reviewRejection']);
      expect(detail).toMatchObject({
        role: 'review',
        personaName: 'Reviewer',
        summary: FINDINGS,
        findings: [{ severity: 'BLOCKING', location: 'src/api/a.txt:3' }],
      });
      expect(card?.body).toContain('What it wrote is on the card.');
    });

    it('keeps the failure as before when the review wrote nothing', async () => {
      engine = await createTestEngine({
        Alpha: [implement('op-flow-0036'), noVerdict, noVerdict],
      });
      const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
      await until(workstream.id, (s) => s === 'FAILED', 2);
      const card = listInbox(engine.store.db, { states: ['OPEN'] }).find((i) => i.kind === 'flag');
      expect(card?.detail?.['reviewRejection']).toBeUndefined();
    });
  });

  describe('when the reviewer keeps rejecting', () => {
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
      const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
      await until(workstream.id, (s) => s === 'FAILED');
      return workstream;
    };

    it('fails after the fix limit with a flag that carries the last review’s findings', async () => {
      const workstream = await failed();
      expect(ws(workstream.id)).toMatchObject({
        state: 'FAILED',
        failureReason: 'The review step rejected the work and the retry limit (3) is used up',
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
    });

    it('keeps every round the reviewer gave', async () => {
      const workstream = await failed();
      expect(reviewRounds(ws(workstream.id).steps).map((r) => r.result.summary)).toEqual([
        FINAL,
        '1. NOTE round 3',
        '1. NOTE round 2',
        '1. NOTE round 1',
      ]);
      expect(rejectionsSentBack(ws(workstream.id))).toBe(3);
    });

    it('sends a retry to the implement step with the findings, and the review runs after it', async () => {
      const workstream = await failed();
      engine.retry(workstream.id);
      expect(ws(workstream.id)).toMatchObject({
        state: 'QUEUED',
        stepIndex: 0,
        attempt: 0,
        nextAction: { kind: 'revise', reviewStep: 1 },
      });
      // The review has not run since the retry, so nothing it said before counts.
      expect(rejectionsSentBack(ws(workstream.id))).toBe(0);
      expect(reviewRounds(ws(workstream.id).steps)).toHaveLength(4);
      expect(step(workstream.id, 0)).toMatchObject({ status: 'running', result: null });
      await until(workstream.id, (s) => s === 'DONE');
      const prompt = engine.adapter.prompts.at(-2)?.prompt ?? '';
      expect(prompt).toContain('Your step: 1 of 2, implement');
      expect(prompt).toContain('rejected the work');
      expect(prompt).toContain('the card hides what the reviewer found');
      expect(ws(workstream.id).state).toBe('DONE');
    });

    it('hands the builder’s note to that implement session with the findings', async () => {
      const workstream = await failed();
      engine.retry(workstream.id, 'Use the existing card component.');
      expect(ws(workstream.id)).toMatchObject({ state: 'QUEUED', stepIndex: 0 });
      await until(workstream.id, (s) => s === 'DONE');
      const prompt = engine.adapter.prompts.at(-2)?.prompt ?? '';
      expect(prompt).toContain('Use the existing card component.');
      expect(prompt).toContain('the card hides what the reviewer found');
      expect(
        listEvidence(engine.store.db, workstream.id).filter((e) => e.kind === 'builder'),
      ).toMatchObject([{ summary: 'Use the existing card component.' }]);
    });
  });

  it('escalates the implement step when the gate fails', async () => {
    engine = await createTestEngine(
      { Alpha: [[turn], implement('op-flow-0051'), [approve('op-flow-0052'), turn]] },
      { gateCommand: 'test -f src/api/a.txt' },
    );
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({
      state: 'QUEUED',
      nextAction: { kind: 'fix' },
      model: 'opus',
      effort: 'low',
    });
    expect(step(workstream.id, 0)?.reason).toBe('escalated from sonnet@high after the gate failed');
    expect(ws(workstream.id).attempt).toBe(1);
    expect(step(workstream.id, 0)?.attempts).toBe(1);
    await until(workstream.id, (s) => s === 'DONE');
    expect(ws(workstream.id).state).toBe('DONE');
  });

  it('gives the implementer the plan', async () => {
    engine = await createTestEngine({
      Alpha: [
        [
          {
            do: 'mcp',
            tool: 'complete_step',
            args: { opId: 'op-flow-0061', summary: '1. Put it in src/api/a.txt.', verdict: null },
          },
          turn,
        ],
        implement('op-flow-0062'),
        [approve('op-flow-0063'), turn],
        [approve('op-flow-0064'), turn],
      ],
    });
    // Four criteria run the full flow's plan and QA steps; with no risk tag the plan review is skipped.
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'full', criteria: 4 });
    expect(ws(workstream.id).steps.map((s) => s.role)).toEqual([
      'plan',
      'implement',
      'review',
      'qa',
    ]);
    await until(workstream.id, (s) => s === 'DONE');
    expect(engine.adapter.prompts[1]?.prompt).toContain('1. Put it in src/api/a.txt.');
    expect(ws(workstream.id).state).toBe('DONE');
  });

  it('shows a plan sent back by plan review the plan it is told to fix', async () => {
    const plan = (opId: string, text: string) => ({
      do: 'mcp' as const,
      tool: 'complete_step',
      args: { opId, summary: text, verdict: null },
    });
    engine = await createTestEngine({
      Alpha: [
        [plan('op-flow-0101', 'PLAN ONE: edit src/api/a.txt.'), turn],
        [reject('op-flow-0102', 'Plan review: name the test file.'), turn],
        [plan('op-flow-0103', 'PLAN TWO: edit src/api/a.txt and test it.'), turn],
        [approve('op-flow-0104'), turn],
        implement('op-flow-0105'),
        [approve('op-flow-0106'), turn],
        [approve('op-flow-0107'), turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha', ['api'], [], {
      flow: 'full',
      criteria: 4,
      riskTags: ['security'],
    });
    expect(ws(workstream.id).steps.map((s) => s.role)).toEqual([
      'plan',
      'plan_review',
      'implement',
      'review',
      'qa',
    ]);
    await until(workstream.id, (s) => s === 'DONE');
    expect(ws(workstream.id).state).toBe('DONE');
    const second = engine.adapter.prompts[2]?.prompt ?? '';
    expect(second).toContain('Your step: 1 of 5, plan');
    expect(second).toContain('PLAN ONE: edit src/api/a.txt.');
    expect(second).toContain('Plan review: name the test file.');
    // The kept plan is not the revised session's own result: the revision must still be recorded.
    expect(step(workstream.id, 0)?.result?.summary).toBe(
      'PLAN TWO: edit src/api/a.txt and test it.',
    );
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

  it('resumes the step it was on after a crash', async () => {
    engine = await createTestEngine({
      Alpha: [
        implement('op-flow-0071'),
        [{ do: 'crash', message: 'boom' }],
        [approve('op-flow-0072'), turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
    engine.launch(workstream.id);
    await engine.runner.idle();
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({
      state: 'QUEUED',
      stepIndex: 1,
      nextAction: { kind: 'resume' },
    });
    await until(workstream.id, (s) => s === 'DONE');
    const sessions = listSessions(engine.store.db, workstream.id);
    expect(engine.adapter.prompts[2]).toMatchObject({ resume: sessions[1]?.providerSessionId });
  });

  it('never gives a later step an earlier step’s handoff', async () => {
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
    await until(workstream.id, (s) => s === 'DONE');
    // The review crashed twice: once resumed, then started fresh. A fresh review starts, not continues.
    expect(engine.adapter.prompts[4]?.prompt).not.toContain('Continue from the handoff');
    expect(engine.adapter.prompts[4]?.prompt).toContain('Your step: 2 of 2, review');
    expect(engine.adapter.prompts[4]?.prompt).not.toContain('Commit the file');
    // The implementer's handoff reached the implement step's own continuation.
    expect(engine.adapter.prompts[1]?.prompt).toContain('Commit the file');
  });

  it('runs a workstream with no stored steps as one implement step', async () => {
    engine = await createTestEngine({ Alpha: [implement('op-flow-0091')] });
    const { workstream } = engine.addTask('Alpha');
    expect(ws(workstream.id).steps).toEqual([]);
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
  });

  it('flags a read-only step that leaves changes in its claims, and the flow still completes', async () => {
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
      listInbox(engine.store.db, { states: ['OPEN'] })
        .filter((i) => i.kind === 'flag')
        .map((i) => ({ title: i.title, body: i.body })),
    ).toEqual([
      {
        title: 'The review step left changes in its claims',
        body: 'src/api/review-note.txt',
      },
    ]);
  });
});

describe('a step that ends with changes in its claims', () => {
  const gateEvidence = (id: Parameters<typeof ws>[0]) =>
    listEvidence(engine.store.db, id).filter((e) => e.kind === 'gate');

  it('goes back to the same step, naming the files, and no gate runs on them', async () => {
    engine = await createTestEngine({
      Alpha: [
        [write('src/api/a.txt'), turn],
        [commit('op-uncom-0001', ['src/api/a.txt']), turn],
      ],
    });
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

  it('leaves a change outside its claims to the watcher, so the step still goes to the gate', async () => {
    engine = await createTestEngine({
      Alpha: [[write('src/api/a.txt'), commit('op-uncom-0002', ['src/api/a.txt']), turn]],
    });
    mkdirSync(join(engine.repoPath, 'src/ui'), { recursive: true });
    writeFileSync(join(engine.repoPath, 'src/ui/elsewhere.txt'), 'x');
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(ws(workstream.id).state).toBe('DONE');
    expect(gateEvidence(workstream.id)).toHaveLength(1);
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
  it('lets a session read its own saved output', async () => {
    await start([
      read(() => {
        // Claude Code has written the output by the time the model reads it.
        const path = results(ownSession());
        mkdirSync(dirname(path), { recursive: true });
        return path;
      }),
    ]);
    await waitFor(openCard);
    expect(denials().map((d) => d.detail['reason'])).toEqual([]);
  });

  it("refuses a read of another session's saved output", async () => {
    await start([read(() => results('someone-else'))]);
    await waitFor(() => denials().length > 0);
    expect(String(denials()[0]?.detail['reason'])).toContain('sign-in');
  });
});

// The probe's temp root is a short path under the shared `/tmp`, which no sandbox can write.
describe.skipIf(SANDBOXED)('lane sandbox', () => {
  const lanesGit = createGit();
  /** A real lane sandbox over a short temp root and a temp home, recording each session it makes. */
  interface SandboxProbe {
    readonly laneSandbox: LaneSandbox;
    readonly inputs: LaneSessionInput[];
    readonly sessions: LaneSession[];
    readonly home: string;
    readonly tmpRoot: string;
  }
  let probeRoot: string | null = null;
  afterEach(() => {
    if (probeRoot !== null) rmSync(probeRoot, { recursive: true, force: true });
    probeRoot = null;
  });
  const sandboxProbe = (fail?: () => never): SandboxProbe => {
    probeRoot = realpathSync(mkdtempSync('/tmp/sbr-'));
    const home = join(probeRoot, 'h');
    const tmpRoot = join(probeRoot, 't');
    mkdirSync(home);
    mkdirSync(tmpRoot);
    const real = createLaneSandbox({
      home,
      dataDir: join(probeRoot, 'd'),
      loginConfigDir: null,
      tmpRoot,
      gitDirs: (path) => lanesGit.gitDirs(path),
      runtime: FAKE_SRT,
    });
    const inputs: LaneSessionInput[] = [];
    const sessions: LaneSession[] = [];
    return {
      laneSandbox: {
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
    };
  };
  /** Every spec the fake adapter is started with. */
  const recordSpecs = (): SessionSpec[] => {
    const specs: SessionSpec[] = [];
    engine.adapter.seen = (spec) => {
      specs.push(spec);
      return {};
    };
    return specs;
  };
  const hostCall = (host: string) => ({
    do: 'tool' as const,
    toolName: 'SandboxNetworkAccess',
    input: { host },
  });

  it('runs the session under its profile in default mode, with checkout-scoped reads and the sandbox briefing', async () => {
    const probe = sandboxProbe();
    engine = await createTestEngine({ Alpha: [[turn]] }, {}, { laneSandbox: probe.laneSandbox });
    const specs = recordSpecs();
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();

    const [laneSession] = probe.sessions;
    const [spec] = specs;
    const [session] = listSessions(engine.store.db, workstream.id);
    expect(spec?.sandbox).toBe(laneSession?.spec);
    expect(spec?.allowedTools).toContain(`Read(/${realpathSync(engine.repoPath)}/**)`);
    expect(spec?.allowedTools).not.toContain('Read');
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
    // The session ended, so its temp dir is gone.
    expect(readdirSync(probe.tmpRoot)).toEqual([]);
    expect(ws(workstream.id).state).toBe('DONE');
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

  it.each([
    ['null', { laneSandbox: null }],
    ['absent', {}],
  ])(
    'with the lane sandbox %s, a session gets no sandbox and the unscoped tools',
    async (_name, overrides) => {
      engine = await createTestEngine({ Alpha: [[turn]] }, {}, overrides);
      const specs = recordSpecs();
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await engine.runner.idle();
      expect(specs[0]?.sandbox).toBeNull();
      expect(specs[0]?.allowedTools).toEqual(allowedToolsFor(engine.project, ToolAccess.Edit));
      expect(specs[0]?.prompt).not.toContain('mktemp');
    },
  );

  it("reads the project's localhost switch when each session starts, so a change applies at the next one", async () => {
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
    engine.state.write((ctx) => patchProject(ctx, engine.project.id, { sandboxLoopback: true }));
    const second = engine.addTask('Beta');
    engine.launch(second.workstream.id);
    await engine.runner.idle();
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

  it.each([
    [
      'SandboxProfileError',
      () => new SandboxProfileError('checkout', "the checkout can't be read"),
    ],
    [
      'SandboxTempDirError',
      () => new SandboxTempDirError('Could not create the lane temp directory'),
    ],
  ])(
    'fails the workstream at once when the sandbox refuses with a %s, writing no session',
    async (_name, error) => {
      const probe = sandboxProbe(() => {
        throw error();
      });
      engine = await createTestEngine({ Alpha: [[turn]] }, {}, { laneSandbox: probe.laneSandbox });
      const { workstream } = engine.addTask('Alpha');
      engine.launch(workstream.id);
      await engine.runner.idle();

      const row = ws(workstream.id);
      expect(row.state).toBe('FAILED');
      expect(row.failureReason).toMatch(/^The lane sandbox could not start: /);
      expect(listSessions(engine.store.db, workstream.id)).toEqual([]);
      expect(engine.adapter.prompts).toEqual([]);
      expect(transitions(workstream.id).filter((t) => t.endsWith('->RECOVERING'))).toEqual([]);
      const cards = listInbox(engine.store.db, { states: ['OPEN'] });
      expect(cards.map((card) => card.kind)).toEqual(['flag']);
      expect(cards[0]?.body).toMatch(/^The lane sandbox could not start: /);
      // A leaked start slot would leave this acquire pending forever.
      (await engine.startGate.acquire(engine.project.accountId))();
    },
  );

  it('leaves no temp dir behind when the adapter throws on start', async () => {
    const probe = sandboxProbe();
    engine = await createTestEngine({ Alpha: [[turn]] }, {}, { laneSandbox: probe.laneSandbox });
    engine.adapter.start = () => {
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
    vi.spyOn(engine.adapter, 'start').mockImplementation(() => ({
      events: refused(),
      send: () => undefined,
      stop: () => Promise.resolve(),
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

    it('the session runs in the worktree', async () => {
      const { specs, path } = await run(() => [[turn]]);
      expect(specs.map((spec) => spec.cwd)).toEqual([path]);
    });

    it('the lane sandbox gets the worktree as the checkout and every checkout in checkouts', async () => {
      const { probe, specs, path } = await run(() => [[turn]]);
      expect(probe.inputs[0]?.project.repoPath).toBe(path);
      expect(probe.inputs[0]?.checkouts).toEqual([engine.repoPath, path]);
      expect(specs[0]?.allowedTools).toContain(`Read(/${realpathSync(path)}/**)`);
    });

    it('the gate runs in the worktree', async () => {
      const { workstream, path } = await run(() => [
        [write('src/api/a.txt'), commit('op-wt-gate-1', ['src/api/a.txt']), turn],
      ]);
      expect(ws(workstream.id).state).toBe('DONE');
      expect(gateRequests.map((request) => request.project.repoPath)).toEqual([path]);
      expect(gateRequests[0]?.checkouts).toEqual([engine.repoPath, path]);
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
    });
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

  async function run(migrationsBase: MigrationsBase, areas: string[]) {
    engine = await createTestEngine({ Alpha: [[turn]] }, {}, { migrationsBase });
    const { workstream } = engine.addTask('Alpha', areas);
    engine.launch(workstream.id);
    await engine.runner.idle();
    return workstream;
  }

  it('is brought in before its first session, which keeps the hazard', async () => {
    const { asked, migrationsBase } = recordingMigrationsBase({ kind: 'ready' });
    const workstream = await run(migrationsBase, ['api', 'migrations']);
    expect(asked).toEqual([{ id: workstream.id, sessions: 0 }]);
    expect(engine.adapter.prompts[0]?.prompt).toContain(
      'Your claims: area api, hazard migrations.',
    );
  });

  it("gives the hazard back when the branch can't take its base, and the session starts without it", async () => {
    const { asked, migrationsBase } = recordingMigrationsBase({
      kind: 'held',
      inboxId: mintId('InboxItem'),
      instruction: 'origin/main conflicts with this branch in README.md',
    });
    const workstream = await run(migrationsBase, ['api', 'migrations']);
    expect(asked).toEqual([{ id: workstream.id, sessions: 0 }]);
    expect(engine.adapter.prompts[0]?.prompt).toContain('Your claims: area api.');
  });

  it('is not asked for a task without the hazard', async () => {
    const { asked, migrationsBase } = recordingMigrationsBase({ kind: 'ready' });
    await run(migrationsBase, ['api']);
    expect(asked).toEqual([]);
    expect(engine.adapter.prompts).toHaveLength(1);
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

  it('a middle step advances without evidence', async () => {
    engine = await createTestEngine(
      { Alpha: [implement('op-nogate-0001'), [approve('op-nogate-0002'), turn]] },
      { gateCommand: null },
    );
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
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
  });

  it.each([
    {
      name: 'an implement step that is the last',
      flow: undefined,
      script: [implement('op-nogate-0011')],
      launches: 1,
      commits: 1,
    },
    {
      name: 'a review step that is the last',
      flow: 'standard',
      script: [implement('op-nogate-0012'), [approve('op-nogate-0013'), turn]],
      launches: 2,
      commits: 1,
    },
  ])('last step without a gate waits for the builder: $name', async (row) => {
    engine = await createTestEngine({ Alpha: row.script }, { gateCommand: null });
    const { task, workstream } = engine.addTask(
      'Alpha',
      ['api'],
      [],
      row.flow ? { flow: row.flow } : undefined,
    );
    for (let i = 0; i < row.launches; i += 1) await runToWait(workstream.id);
    expectWaitingForTheBuilder(workstream.id, 'Alpha', row.commits);
    expect(countLanes(engine.store.db).byProject.get(task.projectId) ?? 0).toBe(0);
    expect(openChecks()[0]?.body).toBe(
      `${row.commits === 1 ? '1 commit is ready.' : `${String(row.commits)} commits are ready.`} Approve to finish the task, or send it back with a note.`,
    );
    neverDone(workstream.id, task.id);
  });

  it.each([
    { name: 'a permission card', kind: 'permission' as const, choice: 'allow_once' },
    { name: 'a question card', kind: 'question' as const, choice: 'Yes' },
  ])(
    'an answer to another card targeting a waiting workstream leaves it WAITING_HUMAN with the same next action: $name',
    async ({ kind, choice }) => {
      engine = await createTestEngine(
        { Alpha: [implement('op-nogate-0051')] },
        { gateCommand: null },
      );
      const { task, workstream } = engine.addTask('Alpha');
      await runToWait(workstream.id);
      const before = ws(workstream.id);
      const sessions = engine.adapter.prompts.length;
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
      expect(ws(workstream.id)).toMatchObject({
        state: 'WAITING_HUMAN',
        nextAction: before.nextAction,
      });
      expect(engine.adapter.prompts).toHaveLength(sessions);
      expect(openChecks()).toHaveLength(1);
      neverDone(workstream.id, task.id);
    },
  );

  it('an answer to another card redelivered by recovery leaves a waiting workstream WAITING_HUMAN with the same next action', async () => {
    engine = await createTestEngine(
      { Alpha: [implement('op-nogate-0052')] },
      { gateCommand: null },
    );
    const { task, workstream } = engine.addTask('Alpha');
    await runToWait(workstream.id);
    const before = ws(workstream.id);
    const sessions = engine.adapter.prompts.length;
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
    expect(ws(workstream.id)).toMatchObject({
      state: 'WAITING_HUMAN',
      nextAction: before.nextAction,
    });
    expect(engine.adapter.prompts).toHaveLength(sessions);
    neverDone(workstream.id, task.id);
  });

  it('a restart while waiting keeps one card and the same next action', async () => {
    engine = await createTestEngine(
      { Alpha: [implement('op-nogate-0021')] },
      { gateCommand: null },
    );
    const { task, workstream } = engine.addTask('Alpha');
    await runToWait(workstream.id);
    const before = ws(workstream.id);
    const sessions = engine.adapter.prompts.length;
    for (let i = 0; i < 2; i += 1) {
      const report = await recover();
      expect(report.parked).toEqual([workstream.id]);
      expect(report.requeued).toEqual([]);
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

  it('verifying again beside an open card raises no second one', async () => {
    engine = await createTestEngine(
      { Alpha: [implement('op-nogate-0031')] },
      { gateCommand: null },
    );
    const { task, workstream } = engine.addTask('Alpha');
    await runToWait(workstream.id);
    const [card] = openChecks();
    engine.state.write((ctx) =>
      transitionWorkstream(ctx, workstream.id, {
        to: 'VERIFYING',
        fence: null,
        patch: { nextAction: { kind: 'verify' } },
      }),
    );
    const fence = engine.state.write((ctx) =>
      acquireLease(ctx, workstream.id, 'test-daemon', new Date(Date.now() + 60_000).toISOString()),
    );
    engine.runner.launch(workstream.id, fence);
    await engine.runner.idle();
    expect(checkCards()).toHaveLength(1);
    expect(ws(workstream.id)).toMatchObject({
      state: 'WAITING_HUMAN',
      nextAction: { kind: 'builder_review', inboxId: card?.id },
    });
    neverDone(workstream.id, task.id);
  });

  it('with a gate, a finished task still completes on the gate and raises no check', async () => {
    engine = await createTestEngine({ Alpha: [implement('op-nogate-0041')] });
    const { workstream } = engine.addTask('Alpha');
    await runToWait(workstream.id);
    expect(ws(workstream.id).state).toBe('DONE');
    expect(listEvidence(engine.store.db, workstream.id)).toHaveLength(1);
    expect(checkCards()).toEqual([]);
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
    const waiting = async (op: string) => {
      engine = await createTestEngine(
        { Alpha: [implement(op), [turn], [turn], [turn], [turn], [turn]] },
        { gateCommand: null },
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

    it('approve completes with no session started', async () => {
      const { task, workstream } = await waiting('op-check-0001');
      const sessions = engine.adapter.prompts.length;
      answerCheck('approve');
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

    it('approve raises no review card', async () => {
      const { workstream } = await waiting('op-check-0002');
      answerCheck('approve');
      expect(ws(workstream.id).state).toBe('DONE');
      expect(reviewCards()).toEqual([]);
    });

    it('with a gate, a finished task raises no card: the pull request is where it is reviewed', async () => {
      engine = await createTestEngine({ Alpha: [implement('op-check-0003')] });
      const { workstream } = engine.addTask('Alpha');
      await runToWait(workstream.id);
      expect(ws(workstream.id).state).toBe('DONE');
      expect(reviewCards()).toEqual([]);
      expect(listInbox(engine.store.db, { states: ['OPEN'] })).toEqual([]);
    });

    it.each([
      { name: 'send back', act: () => answerCheck('send_back', note), state: 'QUEUED' },
      { name: 'an unanswered card', act: () => undefined, state: 'WAITING_HUMAN' },
    ])('only Approve completes: $name does not', async ({ act, state }) => {
      const { task, workstream } = await waiting('op-check-0004');
      act();
      expect(ws(workstream.id).state).toBe(state);
      neverDone(workstream.id, task.id);
      expect(activeClaims(engine.store.db, workstream.id).length).toBeGreaterThan(0);
    });

    it('send back records builder evidence and queues a fix', async () => {
      const { workstream } = await waiting('op-check-0005');
      const before = getWorkstreamRow(engine.store.db, workstream.id);
      answerCheck('send_back', note);
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
    });

    it('the fix prompt carries the builder note, and the fixed work comes back for a check', async () => {
      const { task, workstream } = await waiting('op-check-0006');
      answerCheck('send_back', note);
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
      expect(ws(workstream.id)).toMatchObject({ state: 'FAILED' });
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

    it('past maxFixAttempts on a review flow, the lane is freed and a retry fixes the note', async () => {
      let freed = 0;
      engine = await createTestEngine(
        {
          Alpha: [
            implement('op-check-0042'),
            [approve('op-check-0043'), turn],
            implement('op-check-0044'),
          ],
        },
        { gateCommand: null },
        {
          onLaneFreed: () => {
            freed += 1;
          },
        },
      );
      const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
      await runToWait(workstream.id);
      await runToWait(workstream.id);
      engine.state.write((ctx) => {
        patchWorkstream(ctx, workstream.id, null, {
          attempt: DEFAULT_RUNNER_LIMITS.maxFixAttempts,
        });
      });
      const before = freed;
      answerCheck('send_back', note);
      const [evidence] = listEvidence(engine.store.db, workstream.id);
      expect(freed).toBe(before + 1);
      expect(ws(workstream.id)).toMatchObject({
        state: 'FAILED',
        stepIndex: 0,
        nextAction: { kind: 'fix', evidenceId: evidence?.id },
      });
      expect(ws(workstream.id).steps.map((s) => s.status)).toEqual(['failed', 'pending']);
      engine.retry(workstream.id);
      expect(ws(workstream.id)).toMatchObject({
        state: 'QUEUED',
        stepIndex: 0,
        nextAction: { kind: 'fix', evidenceId: evidence?.id },
      });
      expect(ws(workstream.id).steps[0]).toMatchObject({ status: 'running', attempts: 0 });
      await runToWait(workstream.id);
      expect(engine.adapter.prompts[2]?.prompt).toContain(
        `The builder sent the work back: ${note}`,
      );
      expect(ws(workstream.id)).toMatchObject({ state: 'QUEUED', stepIndex: 1 });
    });

    it("after the limit, the fix runs on the implement step's model and effort, not the review's", async () => {
      engine = await createTestEngine(
        {
          Alpha: [
            implement('op-check-0050'),
            [approve('op-check-0051'), turn],
            implement('op-check-0052'),
          ],
        },
        { gateCommand: null },
      );
      const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
      await runToWait(workstream.id);
      await runToWait(workstream.id);
      const implementStep = ws(workstream.id).steps[0];
      const reviewStep = ws(workstream.id).steps[1];
      expect([implementStep?.model, implementStep?.effort]).not.toEqual([
        reviewStep?.model,
        reviewStep?.effort,
      ]);
      engine.state.write((ctx) => {
        patchWorkstream(ctx, workstream.id, null, {
          attempt: DEFAULT_RUNNER_LIMITS.maxFixAttempts,
        });
      });
      answerCheck('send_back', note);
      expect(ws(workstream.id)).toMatchObject({
        state: 'FAILED',
        model: implementStep?.model,
        effort: implementStep?.effort,
      });
      engine.retry(workstream.id);
      expect(ws(workstream.id)).toMatchObject({
        model: implementStep?.model,
        effort: implementStep?.effort,
      });
    });

    describe('a retry after the limit keeps the note for a fresh session', () => {
      const noGate = { gateCommand: null } as const;
      const sentBack = `The builder sent the work back: ${note}`;
      // The failure the exhausted send back raised stays open beside the question.
      const askedCard = () =>
        listInbox(engine.store.db, { states: ['OPEN'] }).find((i) => i.kind !== 'flag');
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

      it('after the project moved, to a fresh session that takes the builder answer', async () => {
        engine = await createTestEngine(
          { Alpha: [implement('op-check-0060'), [askShip, turn], implement('op-check-0061')] },
          noGate,
        );
        const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'quick' });
        await runToWait(workstream.id);
        exhaust(workstream.id);
        engine.launch(workstream.id);
        const card = await waitFor(askedCard);
        engine.clock.advance(10 * 60_000);
        await engine.runner.idle();
        expect(ws(workstream.id).nextAction).toMatchObject({ kind: 'answer', inboxId: card.id });
        moveTo(secondPlan().id);
        engine.inbox.answer(card.id, { choice: 'Yes' });
        engine.launch(workstream.id);
        await engine.runner.idle();
        expect(engine.adapter.prompts[2]).toMatchObject({ resume: null });
        expect(engine.adapter.prompts[2]?.prompt).toContain(sentBack);
      });

      it('after the project moved, to a fresh session that was resuming the fix', async () => {
        engine = await createTestEngine(
          {
            Alpha: [
              implement('op-check-0062'),
              [
                {
                  do: 'mcp',
                  tool: 'write_handoff',
                  args: handoffArgs('op-check-0063', 'Finish the rename'),
                },
                { do: 'rate_limit', status: 'rejected', resetsInSeconds: 600 },
              ],
              implement('op-check-0064'),
            ],
          },
          noGate,
        );
        const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'quick' });
        await runToWait(workstream.id);
        exhaust(workstream.id);
        engine.clock.advance(1_000);
        await runToWait(workstream.id);
        expect(ws(workstream.id).nextAction).toMatchObject({ kind: 'resume' });
        moveTo(secondPlan().id);
        requeue(workstream.id);
        await runToWait(workstream.id);
        expect(engine.adapter.prompts[2]).toMatchObject({ resume: null });
        expect(engine.adapter.prompts[2]?.prompt).toContain(sentBack);
      });

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

    it('the last send back the limit allows still queues a fix', async () => {
      const { workstream } = await waiting('op-check-0018');
      engine.state.write((ctx) => {
        patchWorkstream(ctx, workstream.id, null, {
          attempt: DEFAULT_RUNNER_LIMITS.maxFixAttempts - 1,
        });
      });
      answerCheck('send_back', note);
      expect(ws(workstream.id)).toMatchObject({
        state: 'QUEUED',
        attempt: DEFAULT_RUNNER_LIMITS.maxFixAttempts,
      });
    });

    it('send back without a note is refused and changes nothing', async () => {
      const { task, workstream } = await waiting('op-check-0008');
      const before = ws(workstream.id);
      expect(() => answerCheck('send_back')).toThrow(InboxAnswerRefused);
      expect(() => answerCheck('send_back', '   ')).toThrow(InboxAnswerRefused);
      expect(ws(workstream.id)).toEqual(before);
      expect(openChecks()).toHaveLength(1);
      expect(listEvidence(engine.store.db, workstream.id)).toEqual([]);
      neverDone(workstream.id, task.id);
    });

    it('answering the same card twice completes once', async () => {
      const { task, workstream } = await waiting('op-check-0009');
      const [card] = openChecks();
      answerCheck('approve');
      expect(() =>
        engine.inbox.answer(card?.id ?? mintId('InboxItem'), { choice: 'approve' }),
      ).toThrow(ConflictError);
      expect(() => {
        approveDirect(workstream.id);
      }).toThrow(ConflictError);
      expect(doneTransitions(workstream.id)).toHaveLength(1);
      expect(ws(workstream.id).state).toBe('DONE');
      expect(getTask(engine.store.db, task.id).status).toBe('done');
    });

    it.each([
      { name: 'queued after a send back', setup: 'send_back' },
      { name: 'done after an approval', setup: 'approve' },
    ])('approve or send back on a workstream that is $name does nothing', async ({ setup }) => {
      const { workstream } = await waiting('op-check-0010');
      answerCheck(setup, setup === 'send_back' ? note : undefined);
      const before = ws(workstream.id);
      const evidence = listEvidence(engine.store.db, workstream.id);
      const events = listEventsAfter(engine.store.db, 0, 1000).length;
      expect(() => {
        approveDirect(workstream.id);
      }).toThrow(ConflictError);
      expect(() => {
        sendBackDirect(workstream.id, 'again');
      }).toThrow(ConflictError);
      expect(ws(workstream.id)).toEqual(before);
      expect(listEvidence(engine.store.db, workstream.id)).toEqual(evidence);
      expect(listEventsAfter(engine.store.db, 0, 1000)).toHaveLength(events);
    });

    it('approve and send back on a workstream that never waited do nothing', async () => {
      engine = await createTestEngine(
        { Alpha: [implement('op-check-0011')] },
        { gateCommand: null },
      );
      const { workstream } = engine.addTask('Alpha');
      const before = ws(workstream.id);
      expect(() => {
        approveDirect(workstream.id);
      }).toThrow(ConflictError);
      expect(() => {
        sendBackDirect(workstream.id, note);
      }).toThrow(ConflictError);
      expect(ws(workstream.id)).toEqual(before);
      expect(listEvidence(engine.store.db, workstream.id)).toEqual([]);
    });

    it('a restart after approving closes nothing twice and raises no new card', async () => {
      const { task, workstream } = await waiting('op-check-0012');
      answerCheck('approve');
      await recover();
      await recover();
      expect(ws(workstream.id).state).toBe('DONE');
      expect(checkCards().map((c) => c.state)).toEqual(['RESOLVED']);
      expect(doneTransitions(workstream.id)).toHaveLength(1);
      expect(getTask(engine.store.db, task.id).status).toBe('done');
      expect(reviewCards()).toEqual([]);
    });

    it('a restart after sending back keeps the note once and the fix queued', async () => {
      const { workstream } = await waiting('op-check-0013');
      answerCheck('send_back', note);
      const queued = ws(workstream.id);
      await recover();
      await recover();
      expect(listEvidence(engine.store.db, workstream.id)).toHaveLength(1);
      expect(ws(workstream.id)).toMatchObject({
        state: 'QUEUED',
        attempt: 1,
        nextAction: queued.nextAction,
      });
      expect(checkCards().map((c) => c.state)).toEqual(['RESOLVED']);
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

    it('an answer for a workstream that is no longer waiting is a conflict that leaves the card open', async () => {
      const { workstream } = await waiting('op-check-0016');
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

    it('approve frees the lane after releasing the claims', async () => {
      let freed = 0;
      engine = await createTestEngine(
        { Alpha: [implement('op-check-0017')] },
        { gateCommand: null },
        {
          onLaneFreed: () => {
            freed += 1;
          },
        },
      );
      const { workstream } = engine.addTask('Alpha');
      await runToWait(workstream.id);
      const before = freed;
      answerCheck('approve');
      expect(activeClaims(engine.store.db, workstream.id)).toEqual([]);
      expect(freed).toBe(before + 1);
    });

    it('send back on a review flow reruns the implement step, then returns the work for a check', async () => {
      engine = await createTestEngine(
        {
          Alpha: [
            implement('op-check-0020'),
            [approve('op-check-0021'), turn],
            implement('op-check-0022'),
            [approve('op-check-0023'), turn],
          ],
        },
        { gateCommand: null },
      );
      const { task, workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
      await runToWait(workstream.id);
      await runToWait(workstream.id);
      expect(ws(workstream.id)).toMatchObject({ state: 'WAITING_HUMAN', stepIndex: 1 });
      answerCheck('send_back', note);
      const [evidence] = listEvidence(engine.store.db, workstream.id);
      expect(ws(workstream.id)).toMatchObject({
        state: 'QUEUED',
        stepIndex: 0,
        attempt: 1,
        nextAction: { kind: 'fix', evidenceId: evidence?.id },
      });
      expect(ws(workstream.id).steps.map((s) => s.status)).toEqual(['running', 'pending']);
      await runToWait(workstream.id);
      expect(engine.adapter.prompts[2]?.prompt).toContain(
        `The builder sent the work back: ${note}`,
      );
      expect(engine.adapter.prompts[2]?.prompt).toContain('Your step: 1 of 2, implement');
      expect(ws(workstream.id)).toMatchObject({ state: 'QUEUED', stepIndex: 1 });
      await runToWait(workstream.id);
      expect(ws(workstream.id)).toMatchObject({ state: 'WAITING_HUMAN', stepIndex: 1 });
      expect(openChecks()).toHaveLength(1);
      neverDone(workstream.id, task.id);
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

    describe('after a send back the next session still knows the note', () => {
      const noGate = { gateCommand: null } as const;
      const sentBack = `The builder sent the work back: ${note}`;

      it('after the project moved, to a fresh session that takes the builder answer', async () => {
        engine = await createTestEngine(
          { Alpha: [implement('op-check-0030'), [askShip, turn], implement('op-check-0031')] },
          noGate,
        );
        const { workstream } = engine.addTask('Alpha');
        await runToWait(workstream.id);
        answerCheck('send_back', note);
        engine.launch(workstream.id);
        const card = await waitFor(openCard);
        engine.clock.advance(10 * 60_000);
        await engine.runner.idle();
        expect(ws(workstream.id).nextAction).toMatchObject({ kind: 'answer', inboxId: card.id });
        moveTo(secondPlan().id);
        engine.inbox.answer(card.id, { choice: 'Yes' });
        engine.launch(workstream.id);
        await engine.runner.idle();
        expect(engine.adapter.prompts[2]).toMatchObject({ resume: null });
        expect(engine.adapter.prompts[2]?.prompt).toContain(sentBack);
        expect(engine.adapter.prompts[2]?.prompt).toContain('Answer: Yes');
      });

      it('after the project moved, to a fresh session that was resuming the fix', async () => {
        engine = await createTestEngine(
          {
            Alpha: [
              implement('op-check-0032'),
              [
                {
                  do: 'mcp',
                  tool: 'write_handoff',
                  args: handoffArgs('op-check-0033', 'Finish the rename'),
                },
                { do: 'rate_limit', status: 'rejected', resetsInSeconds: 600 },
              ],
              implement('op-check-0034'),
            ],
          },
          noGate,
        );
        const { workstream } = engine.addTask('Alpha');
        await runToWait(workstream.id);
        answerCheck('send_back', note);
        // The test clock is frozen: the fix session's handoff is written after the note.
        engine.clock.advance(1_000);
        await runToWait(workstream.id);
        expect(ws(workstream.id).nextAction).toMatchObject({ kind: 'resume' });
        moveTo(secondPlan().id);
        requeue(workstream.id);
        await runToWait(workstream.id);
        expect(engine.adapter.prompts[2]).toMatchObject({ resume: null });
        expect(engine.adapter.prompts[2]?.prompt).toContain(sentBack);
      });

      it('not once the work has been fixed and a reviewer sent it back again', async () => {
        const reject = {
          do: 'mcp' as const,
          tool: 'complete_step',
          args: { opId: 'op-check-0038', summary: '1. Add a test.', verdict: 'reject' },
        };
        engine = await createTestEngine(
          {
            Alpha: [
              implement('op-check-0036'),
              [
                {
                  do: 'mcp',
                  tool: 'complete_step',
                  args: { opId: 'op-check-0037', summary: 'Fine.', verdict: 'approve' },
                },
                turn,
              ],
              implement('op-check-0039'),
              [reject, turn],
              [
                {
                  do: 'mcp',
                  tool: 'write_handoff',
                  args: handoffArgs('op-check-0040', 'Add the test'),
                },
                { do: 'rate_limit', status: 'rejected', resetsInSeconds: 600 },
              ],
              implement('op-check-0041'),
            ],
          },
          noGate,
        );
        const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
        await runToWait(workstream.id);
        await runToWait(workstream.id);
        answerCheck('send_back', note);
        // The test clock is frozen: each step is entered later than the note.
        engine.clock.advance(1_000);
        await runToWait(workstream.id);
        engine.clock.advance(1_000);
        await runToWait(workstream.id);
        expect(ws(workstream.id).nextAction).toMatchObject({ kind: 'resume' });
        moveTo(secondPlan().id);
        requeue(workstream.id);
        await runToWait(workstream.id);
        expect(engine.adapter.prompts[5]).toMatchObject({ resume: null });
        expect(engine.adapter.prompts[5]?.prompt).not.toContain(sentBack);
        expect(engine.adapter.prompts[5]?.prompt).toContain('1. Add a test.');
      });

      it('after a restart that finds the fix session mid resume', async () => {
        const { workstream } = await waiting('op-check-0035');
        answerCheck('send_back', note);
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

    it('a restart after the answer leaves the approved work done and starts nothing', async () => {
      const { workstream } = await waiting('op-check-0014');
      const sessions = engine.adapter.prompts.length;
      answerCheck('approve');
      const report = await recover();
      expect(report.parked).toEqual([]);
      expect(report.requeued).toEqual([]);
      expect(ws(workstream.id).state).toBe('DONE');
      expect(engine.adapter.prompts).toHaveLength(sessions);
    });
  });
});
