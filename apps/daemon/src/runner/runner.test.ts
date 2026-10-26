import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ACCOUNT_CARD_DETAIL,
  AccountCardChoice,
  MCP_APPROVAL_DETAIL,
  type AccountId,
} from '@10db/contracts';
import {
  acquireLease,
  activeClaims,
  getAccount,
  getProject,
  getTask,
  getWorkstream,
  listEventsAfter,
  listEvidence,
  listInbox,
  listSessions,
  patchAccount,
  patchProject,
  schema,
  seedAccount,
  transitionWorkstream,
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
import type { SessionHandle } from '../sessions';
import { createMemoryKeychain, handoffArgs, waitFor } from '../../test/fixtures';
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
    expect(listInbox(engine.store.db, { states: ['OPEN'] }).map((i) => i.kind)).toEqual(['review']);
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
      expect(listInbox(engine.store.db, { states: ['OPEN'] }).map((i) => i.kind)).toEqual([
        'review',
      ]);
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
    expect(listInbox(engine.store.db, { states: ['OPEN'] }).map((i) => i.kind)).toEqual(['review']);
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
    expect(listInbox(engine.store.db, { states: ['OPEN'] }).map((i) => i.kind)).toEqual(['review']);
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

    it('passes an approved server with only PATH, HOME and the variables the builder approved', async () => {
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
      expect(spec.projectMcpServers).toEqual({
        docs: {
          type: 'http',
          url: 'https://docs.example/mcp',
          headers: { Authorization: 'Bearer tok-1' },
        },
        mantine: {
          type: 'stdio',
          command: 'npx',
          args: MANTINE.args,
          env: { PATH: '/usr/bin:/bin', HOME: '/h' },
        },
      });
      const mantine = spec.projectMcpServers['mantine'];
      expect(mantine?.type === 'stdio' ? Object.keys(mantine.env).sort() : null).toEqual([
        'HOME',
        'PATH',
      ]);
      for (const secret of ['sk-ant-x', 'oauth-x', 'aws-x'])
        expect(JSON.stringify(spec.projectMcpServers)).not.toContain(secret);
      expect(spec.prompt).not.toContain('Note from 10db');
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
      expect(Object.keys(spec.projectMcpServers)).toEqual(['mantine']);
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
        expect(listInbox(engine.store.db, { states: ['OPEN'] }).map((i) => i.kind)).toEqual([
          'review',
        ]);
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

describe('moving accounts', () => {
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

  it('ends a review step that never gives a verdict as FAILED with a flag, and marks the step failed', async () => {
    engine = await createTestEngine({
      Alpha: [
        implement('op-flow-0021'),
        [turn, { do: 'await_message', contains: RESULT_NUDGE }, turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
    await until(workstream.id, (s) => s === 'FAILED');
    expect(ws(workstream.id)).toMatchObject({
      state: 'FAILED',
      failureReason: 'The review step ended without calling complete_step',
    });
    expect(step(workstream.id, 1)?.status).toBe('failed');
    expect(listInbox(engine.store.db, { states: ['OPEN'] }).map((i) => i.kind)).toContain('flag');
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

  it('fails after the fix limit when the reviewer keeps rejecting, then retries the review cleanly', async () => {
    const round = (n: number) => [[turn], [reject(`op-flow-04${String(n)}0`), turn]];
    engine = await createTestEngine({
      Alpha: [...[1, 2, 3, 4].flatMap(round), [approve('op-flow-0499'), turn]],
    });
    const { workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
    await until(workstream.id, (s) => s === 'FAILED');
    expect(ws(workstream.id)).toMatchObject({
      state: 'FAILED',
      failureReason: 'The review step rejected the work and the retry limit (3) is used up',
    });
    expect(listInbox(engine.store.db, { states: ['OPEN'] }).map((i) => i.kind)).toContain('flag');
    // The builder retries: the review starts clean (no stale verdict) and approves.
    engine.retry(workstream.id);
    expect(step(workstream.id, 1)).toMatchObject({ status: 'running', result: null, attempts: 0 });
    await until(workstream.id, (s) => s === 'DONE');
    expect(ws(workstream.id).state).toBe('DONE');
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
      'The plan step ended without calling complete_step',
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
