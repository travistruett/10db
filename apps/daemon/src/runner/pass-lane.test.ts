import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConflictError,
  InvalidError,
  mintId,
  PassCheckDetail,
  EventType,
  SHARED_ASK_ALLOW_CHOICE,
  SHARED_ASK_REPLY_CHOICE,
  SharedAskDetail,
  type PassDto,
  type TaskDto,
  type TaskMessageId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  acquireClaims,
  activeClaims,
  getWorkstreamRow,
  insertBuilderMessage,
  insertPass,
  insertPassTurn,
  insertTask,
  insertWorkstream,
  listInbox,
  listPassTurns,
  listSharedChanges,
  openHolds,
  listSessions,
  endPassTurn,
  listTaskThread,
  leavePass,
  listWorkstreams,
  openPassTurn,
  patchProject,
  patchWorkstream,
  type WorkstreamRow,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEngine, type TestEngine } from '../../test/engine';
import { createDeliveryJobs } from '../delivery';
import { createGit } from '../git';
import { silentLogger } from '../log';
import { recoverOnStartup, systemProcesses } from '../recovery';
import { untakenMessages } from './lane-messages';
import { finishEndedTurn } from './pass-turn';
import { closeHoldsOf, grantSharedHold, type PassWorkDeps } from '../pass';
import { DEFAULT_RUNNER_LIMITS } from './runner';
import { handoffArgs, isolatedGitEnv, waitFor } from '../../test/fixtures';
import type { FakeScriptBook } from '../sessions';

/** One step of a fake session's script. */
type FakeStep = FakeScriptBook[string][number][number];

// Workbench spec §6.2, §6.3: a pass task's session runs turn after turn. A turn ends Ready with its
// work kept, never as a step; the session stays open for the builder's next message.

const PAGE_AREAS = {
  gateCommand: null,
  areas: [{ name: 'settings', globs: ['src/settings/**'], role: 'page' as const, route: '/x' }],
};
const PAGE_FILE = 'src/settings/page.tsx';
const TITLE = 'Settings: tidy the form';

let engine: TestEngine;
afterEach(async () => {
  await engine.close();
});

function git(...args: string[]): string {
  return execFileSync('git', ['-C', engine.repoPath, ...args], {
    env: isolatedGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
}

/** A turn of the fake agent: it takes the messages, writes the page and says what it did. */
const turn = (content: string, text: string): FakeStep[] => [
  { do: 'consume' },
  { do: 'tool', toolName: 'Write', input: { file_path: PAGE_FILE, content } },
  { do: 'turn_complete', text },
];

/** An open pass in the engine's folder, holding one page whose task the builder has written to. */
async function openPage(
  sessions: FakeStep[][],
  first = 'Make the form tidy',
  beforeLaunch: () => void = () => undefined,
  project: Parameters<typeof createTestEngine>[1] = PAGE_AREAS,
): Promise<{ task: TaskDto; pass: PassDto; id: WorkstreamId }> {
  engine = await createTestEngine({ [TITLE]: sessions }, project);
  const branch = '10db/polish-abc123';
  const startSha = git('rev-parse', 'HEAD');
  git('switch', '-q', '-c', branch);
  const { task, pass, ws } = engine.state.write((ctx) => {
    const t = insertTask(ctx, engine.project.id, {
      title: TITLE,
      acceptanceCriteria: ['x'],
      areas: ['settings'],
    });
    const opened = insertPass(ctx, {
      id: mintId('Pass'),
      projectId: engine.project.id,
      name: 'Polish',
      pageCap: 4,
      returnBranch: 'main',
      startSha,
      branch,
      baseBranch: 'main',
      repo: null,
      taskIds: [t.id],
      dirt: [],
    });
    const w = insertWorkstream(ctx, t.id, {
      batchId: opened.batch.id,
      first: { model: 'claude-sonnet-5-5', effort: 'medium' },
    });
    insertBuilderMessage(ctx, t.id, { body: first, files: [] });
    return { task: t, pass: opened.pass, ws: w };
  });
  beforeLaunch();
  engine.launch(ws.id);
  return { task, pass, id: ws.id };
}

const row = (id: WorkstreamId): WorkstreamRow => getWorkstreamRow(engine.store.db, id);
const readyItems = () =>
  listInbox(engine.store.db, {}).filter((i) => PassCheckDetail.safeParse(i.detail).success);
const isWaiting = (id: WorkstreamId) =>
  row(id).state === 'WAITING_HUMAN' && row(id).nextAction.kind === 'pass_review';
const isReady = (id: WorkstreamId, items: number) => () =>
  isWaiting(id) && readyItems().length === items;

/** A session that takes the message, writes the page and works on until it is stopped. */
const working: FakeStep[] = [
  { do: 'consume' },
  { do: 'tool', toolName: 'Write', input: { file_path: PAGE_FILE, content: 'one\n' } },
  { do: 'await_message', contains: 'never sent' },
];

/** What a pass task's turns keep their work with, as the runner's are. */
const passWork = (): PassWorkDeps => ({
  state: engine.state,
  git: createGit(),
  inbox: engine.inbox,
  jobs: createDeliveryJobs(silentLogger),
  logger: silentLogger,
  clock: engine.clock,
});

/** The agent has written the page in its turn. */
const wrote = () => engine.adapter.observations.some((o) => o.kind === 'tool_allowed');

/** The builder writes to the page, as the thread's route does. */
async function write(task: TaskDto, body: string): Promise<void> {
  const message = engine.state.write((ctx) =>
    insertBuilderMessage(ctx, task.id, { body, files: [] }),
  );
  await engine.runner.deliverMessage(task.id, message.id, { redo: false });
}

describe('a pass task turn by turn', () => {
  it('runs three turns in one session, each Ready with its work kept, never failing or verifying', async () => {
    const { task, pass, id } = await openPage([
      [
        ...turn('one\n', 'Tidied the form.'),
        { do: 'await_message', contains: 'Second' },
        ...turn('two\n', 'Moved the button.'),
        { do: 'await_message', contains: 'Third' },
        ...turn('three\n', 'Fixed the label.'),
        { do: 'await_message', contains: 'never sent' },
      ],
    ]);
    await waitFor(isReady(id, 1));
    await write(task, 'Second: move the button');
    await waitFor(isReady(id, 2));
    await write(task, 'Third: fix the label');
    await waitFor(isReady(id, 3));

    expect(engine.adapter.prompts).toHaveLength(1);
    expect(row(id)).toMatchObject({ attempt: 0, state: 'WAITING_HUMAN' });
    expect(row(id).currentSessionId).not.toBeNull();
    const turns = listPassTurns(engine.store.db, pass.id);
    expect(turns.map((t) => [t.seq, t.ending, t.settledAt !== null])).toEqual([
      [1, 'ready', true],
      [2, 'ready', true],
      [3, 'ready', true],
    ]);
    // Each turn's kept commit holds the page as the turn left it; the branch never moved.
    expect(turns.map((t) => git('show', `${t.keptSha ?? ''}:${PAGE_FILE}`))).toEqual([
      'one',
      'two',
      'three',
    ]);
    expect(git('rev-parse', 'HEAD')).toBe(turns[0]?.keptBaseSha);
    // The agent's last words are its reply on the thread, one per turn.
    expect(
      listTaskThread(engine.store.db, task.id)
        .filter((m) => m.author === 'agent')
        .map((m) => m.body),
    ).toEqual(['Tidied the form.', 'Moved the button.', 'Fixed the label.']);
    // Each turn raised its own Ready item, and the next turn withdrew it; the open one shows the
    // last turn's kept commit and what it changed.
    const items = readyItems();
    expect(items.map((i) => i.state)).toEqual(['CANCELLED', 'CANCELLED', 'OPEN']);
    expect(PassCheckDetail.parse(items[2]?.detail)).toMatchObject({
      turnId: turns[2]?.id,
      keptSha: turns[2]?.keptSha,
      turnFiles: [{ path: PAGE_FILE, added: 1, removed: 1 }],
    });
    // A warm Ready page is never approved or sent back.
    const open = items[2];
    if (!open) throw new Error('no Ready item');
    expect(() => engine.inbox.answer(open.id, { choice: 'approve' })).toThrow();
    expect(() => engine.inbox.answer(open.id, { choice: 'send_back', note: 'more' })).toThrow();
    expect(row(id)).toMatchObject({ state: 'WAITING_HUMAN', attempt: 0 });
  });

  it('a message kept as a turn ends, before it is handed over, holds the page out of Ready until the next turn ends', async () => {
    const { task, pass, id } = await openPage([
      [
        { do: 'consume' },
        { do: 'tool', toolName: 'Write', input: { file_path: PAGE_FILE, content: 'one\n' } },
        { do: 'await_signal', name: 'end the turn' },
        { do: 'turn_complete', text: 'Tidied the form.' },
        { do: 'await_message', contains: 'Also' },
        ...turn('two\n', 'Made it bigger too.'),
        { do: 'await_message', contains: 'never sent' },
      ],
    ]);
    await waitFor(wrote);
    // The builder's message is kept, as the thread's route keeps it, and the turn ends before the
    // runner hands it over (while it folds the builder's hand edits).
    const message = engine.state.write((ctx) =>
      insertBuilderMessage(ctx, task.id, { body: 'Also make it bigger', files: [] }),
    );
    engine.adapter.signal('end the turn');
    await waitFor(() => listSessions(engine.store.db, id)[0]?.inputTokens === 1000);
    await engine.runner.deliverMessage(task.id, message.id, { redo: false });
    await waitFor(
      () =>
        isWaiting(id) &&
        untakenMessages(engine.store.db, task.id).length === 0 &&
        !openPassTurn(engine.store.db, task.id),
    );

    // One turn, Ready once, when the turn that took the message ended.
    const turns = listPassTurns(engine.store.db, pass.id);
    expect(turns.map((t) => [t.seq, t.ending])).toEqual([[1, 'ready']]);
    expect(git('show', `${turns[0]?.keptSha ?? ''}:${PAGE_FILE}`)).toBe('two');
    expect(readyItems().map((i) => i.state)).toEqual(['OPEN']);
    // Its reply is what the agent said once it had read the message, not before.
    expect(
      listTaskThread(engine.store.db, task.id)
        .filter((m) => m.author === 'agent')
        .map((m) => m.body),
    ).toEqual(['Made it bigger too.']);
  });

  it('raises no Ready for a turn whose end the next turn overtook before it was settled', async () => {
    const { task, pass, id } = await openPage([working]);
    await waitFor(wrote);
    await engine.runner.stopAll('shutdown');
    // The turn ended; a message then opened the next turn while the first one's work was kept.
    const ended = engine.state.write((ctx) => {
      const open = openPassTurn(ctx.tx, task.id);
      if (!open) throw new Error('no open turn');
      const done = endPassTurn(ctx, open.id, { ending: 'ready', replyBody: 'Tidied.' });
      const next = insertBuilderMessage(ctx, task.id, { body: 'Also bigger', files: [] });
      insertPassTurn(ctx, {
        taskId: task.id,
        workstreamId: id,
        sessionId: null,
        messageId: next.id,
      });
      return done;
    });
    await finishEndedTurn(passWork(), ended, { fence: null, providerSessionId: null, reason: '' });

    expect(
      listPassTurns(engine.store.db, pass.id).map((t) => [t.seq, t.ending, t.settledAt !== null]),
    ).toEqual([
      [1, 'ready', true],
      [2, null, false],
    ]);
    expect(readyItems()).toEqual([]);
    expect(row(id).state).not.toBe('WAITING_HUMAN');
  });

  it('a message folded mid-turn: the page is Ready when that turn ends', async () => {
    const { task, pass, id } = await openPage([
      [
        { do: 'consume' },
        { do: 'await_message', contains: 'Also' },
        ...turn('one\n', 'Tidied it and made it bigger.'),
        { do: 'await_message', contains: 'never sent' },
      ],
    ]);
    await waitFor(() => listPassTurns(engine.store.db, pass.id).length === 1);
    await write(task, 'Also make it bigger');
    await waitFor(isReady(id, 1));

    expect(listPassTurns(engine.store.db, pass.id).map((t) => [t.seq, t.ending])).toEqual([
      [1, 'ready'],
    ]);
    expect(
      listTaskThread(engine.store.db, task.id)
        .filter((m) => m.author === 'builder')
        .every((m) => m.deliveredAt !== null),
    ).toBe(true);
  });
});

describe("a builder message's hand-over to a warm session", () => {
  const twoTurns = (): FakeStep[][] => [
    [
      ...turn('one\n', 'Tidied the form.'),
      { do: 'await_message', contains: 'Bigger' },
      { do: 'await_signal', name: 'go on' },
      ...turn('two\n', 'Made it bigger.'),
      { do: 'await_message', contains: 'never sent' },
    ],
  ];

  it('hands the message over without the hand-edit note when the hand edits cannot be kept', async () => {
    const { task, id } = await openPage(twoTurns());
    await waitFor(isReady(id, 1));
    // The builder edits the page by hand and switches Your folder away, so the edit cannot be kept.
    writeFileSync(join(engine.repoPath, PAGE_FILE), 'one by hand\n');
    git('switch', '-q', 'main');

    await write(task, 'Bigger please');

    expect(engine.adapter.sent.map((m) => m.text).some((t) => t.includes('Bigger please'))).toBe(
      true,
    );
    git('switch', '-q', '10db/polish-abc123');
    engine.adapter.signal('go on');
    await waitFor(isReady(id, 2));
  });

  it('hands over with the next message every one no turn took that the session was never handed', async () => {
    const { task, id } = await openPage(twoTurns());
    await waitFor(isReady(id, 1));
    // A message kept whose hand-over never happened.
    engine.state.write((ctx) => insertBuilderMessage(ctx, task.id, { body: 'Left', files: [] }));

    await write(task, 'Bigger please');
    engine.adapter.signal('go on');
    await waitFor(isReady(id, 2));

    expect(engine.adapter.sent.map((m) => m.text.split('\n')[1])).toEqual([
      'Left',
      'Bigger please',
    ]);
    expect(untakenMessages(engine.store.db, task.id)).toEqual([]);
  });
});

describe('a pass task turn that ends otherwise', () => {
  it('parks a refused turn on a flag with Retry Turn, never failing, and Retry Turn runs it again', async () => {
    const { pass, id } = await openPage([
      [{ do: 'billing_refused', message: 'a billing check refused the session' }],
      [...turn('one\n', 'Tidied the form.'), { do: 'await_message', contains: 'never sent' }],
    ]);
    await waitFor(() => listPassTurns(engine.store.db, pass.id)[0]?.settledAt);
    await engine.runner.idle();

    const failed = listInbox(engine.store.db, {}).find((i) => i.title.startsWith('Turn failed'));
    expect(failed).toMatchObject({ kind: 'flag', state: 'OPEN' });
    expect(failed?.options.map((o) => o.label)).toEqual(['retry_turn']);
    expect(failed?.body).toContain('a billing check refused the session');
    expect(row(id)).toMatchObject({
      state: 'WAITING_HUMAN',
      nextAction: { kind: 'pass_review', inboxId: failed?.id },
      currentSessionId: null,
    });
    expect(listPassTurns(engine.store.db, pass.id).map((t) => [t.seq, t.ending])).toEqual([
      [1, 'failed'],
    ]);

    // Only Retry Turn answers the flag; any other answer is refused and leaves it open.
    if (!failed) throw new Error('no failed turn flag');
    expect(() => {
      engine.runner.retryTurn(failed, { choice: 'dismiss' });
    }).toThrow(InvalidError);
    expect(row(id).nextAction).toEqual({ kind: 'pass_review', inboxId: failed.id });

    engine.inbox.answer(failed.id, { choice: 'retry_turn' });
    expect(row(id)).toMatchObject({ state: 'QUEUED', nextAction: { kind: 'feedback' } });
    engine.launch(id);
    await waitFor(isReady(id, 1));
    expect(listPassTurns(engine.store.db, pass.id).map((t) => [t.seq, t.ending])).toEqual([
      [1, 'failed'],
      [2, 'ready'],
    ]);
    expect(engine.adapter.prompts[1]?.prompt).toContain('Make the form tidy');
  });

  it.each<{ name: string; session: FakeStep[]; attempts: number }>([
    {
      name: 'refused as it starts',
      session: [{ do: 'billing_refused', message: 'a billing check refused the session' }],
      attempts: 0,
    },
    {
      // Its Ready end cannot keep the work, which is a crash, and the page is out of attempts.
      name: 'out of attempts as its Ready end fails',
      session: [...turn('one\n', 'Tidied.'), { do: 'await_message', contains: 'never sent' }],
      attempts: 3,
    },
  ])(
    'parks a turn $name on its flag though its work cannot be kept, with no turn made up',
    async ({ session, attempts }) => {
      const { pass, id } = await openPage([session], 'Make the form tidy', () => {
        // Your folder is off the pass's branch, so nothing of the turn can be kept now.
        git('switch', '-q', 'main');
        engine.state.write((ctx) => {
          const [ws] = listWorkstreams(ctx.tx, {});
          if (ws) patchWorkstream(ctx, ws.id, null, { recoveryAttempts: attempts });
        });
      });
      await waitFor(() => !engine.runner.isRunning(id) && engine.adapter.prompts.length === 1);

      expect(
        listPassTurns(engine.store.db, pass.id).map((t) => [t.seq, t.settledAt !== null]),
      ).toEqual([[1, true]]);
      expect(row(id)).toMatchObject({
        state: 'WAITING_HUMAN',
        nextAction: { kind: 'pass_review' },
        leaseOwner: null,
      });
      expect(
        listInbox(engine.store.db, {}).filter((i) => i.title.startsWith('Turn failed')),
      ).toHaveLength(1);
    },
  );

  it('is Ready at once with a command left running, and says on the thread when it finishes', async () => {
    const { task, id } = await openPage([
      [
        { do: 'consume' },
        { do: 'background', tasks: ['pnpm dev'] },
        { do: 'tool', toolName: 'Write', input: { file_path: PAGE_FILE, content: 'one\n' } },
        { do: 'turn_complete', text: 'Tidied the form.' },
        { do: 'background', tasks: [] },
        { do: 'await_message', contains: 'never sent' },
      ],
    ]);
    await waitFor(isReady(id, 1));
    await waitFor(() =>
      listTaskThread(engine.store.db, task.id).find((m) => m.body.includes('"pnpm dev"')),
    );
    // Nothing was sent to the session: a nudge would be a turn nobody wrote.
    expect(engine.adapter.sent).toEqual([]);
    expect(row(id).nextAction.kind).toBe('pass_review');
  });

  it('queues a message the session never took when it ends, so it is not lost', async () => {
    const { task, id } = await openPage([
      [
        ...turn('one\n', 'Tidied the form.'),
        { do: 'await_message', contains: 'Next' },
        { do: 'end' },
      ],
    ]);
    await waitFor(isReady(id, 1));
    await write(task, 'Next: make it bigger');
    await waitFor(() => row(id).state === 'QUEUED');
    const next = listTaskThread(engine.store.db, task.id).find((m) => m.body.startsWith('Next'));
    expect(row(id).nextAction).toMatchObject({ kind: 'feedback', messageId: next?.id });
    expect(next?.deliveredAt).toBeNull();
  });
});

describe('the guard of a pass lane', () => {
  it('denies a page of the pass another task holds, though a shared hold covers it', async () => {
    engine = await createTestEngine(
      {
        [TITLE]: [
          [
            { do: 'consume' },
            {
              do: 'tool',
              toolName: 'Write',
              input: { file_path: 'src/people/list.tsx', content: 'x' },
            },
            { do: 'tool', toolName: 'Write', input: { file_path: PAGE_FILE, content: 'one\n' } },
            { do: 'turn_complete', text: 'Tidied the form.' },
            { do: 'await_message', contains: 'never sent' },
          ],
        ],
      },
      {
        gateCommand: null,
        areas: [
          { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
          // An area with no role is a page in a pass: the task holding it is its one writer.
          { name: 'people', globs: ['src/people/**'] },
          { name: 'src', globs: ['src/**'], role: 'shared' },
        ],
      },
    );
    const branch = '10db/polish-abc123';
    const startSha = git('rev-parse', 'HEAD');
    git('switch', '-q', '-c', branch);
    const lease = new Date(Date.now() + 60_000).toISOString();
    const ids = engine.state.write((ctx) => {
      const settings = insertTask(ctx, engine.project.id, {
        title: TITLE,
        acceptanceCriteria: ['x'],
        areas: ['settings'],
      });
      const people = insertTask(ctx, engine.project.id, {
        title: 'People: list',
        acceptanceCriteria: ['x'],
        areas: ['people'],
      });
      const opened = insertPass(ctx, {
        id: mintId('Pass'),
        projectId: engine.project.id,
        name: 'Polish',
        pageCap: 4,
        returnBranch: 'main',
        startSha,
        branch,
        baseBranch: 'main',
        repo: null,
        taskIds: [settings.id, people.id],
        dirt: [],
      });
      const first = { model: 'claude-sonnet-5-5', effort: 'medium' } as const;
      const mine = insertWorkstream(ctx, settings.id, { batchId: opened.batch.id, first });
      const theirs = insertWorkstream(ctx, people.id, { batchId: opened.batch.id, first });
      acquireClaims(ctx, {
        projectId: engine.project.id,
        workstreamId: theirs.id,
        requests: [{ kind: 'area', name: 'people' }],
        leaseExpiresAt: lease,
      });
      // This page's agent holds the shared area, as request_claim grants it for a turn.
      acquireClaims(ctx, {
        projectId: engine.project.id,
        workstreamId: mine.id,
        requests: [{ kind: 'area', name: 'src' }],
        leaseExpiresAt: lease,
      });
      insertBuilderMessage(ctx, settings.id, { body: 'Make the form tidy', files: [] });
      return { mine: mine.id };
    });
    engine.launch(ids.mine);
    await waitFor(isReady(ids.mine, 1));
    const denied = engine.adapter.observations.filter((o) => o.kind === 'denied_by_guard');
    expect(denied.map((o) => o.step)).toEqual([1]);
    expect(engine.adapter.observations.some((o) => o.kind === 'tool_allowed' && o.step === 2)).toBe(
      true,
    );
  });
});

describe("a pass turn's shared area", () => {
  const WITH_SHARED = {
    gateCommand: null,
    areas: [...PAGE_AREAS.areas, { name: 'src', globs: ['src/**'], role: 'shared' as const }],
  };
  /** The agent asks for the shared area, writes a shared file, then ends as `end` says. */
  const sharedTurn = (end: FakeStep[]): FakeStep[] => [
    { do: 'consume' },
    {
      do: 'mcp',
      tool: 'request_claim',
      args: { opId: 'op-shared-src', kind: 'area', name: 'src', reason: 'a shared button' },
    },
    { do: 'tool', toolName: 'Write', input: { file_path: 'src/button.ts', content: 'button\n' } },
    ...end,
  ];

  it.each<{
    name: string;
    end: FakeStep[];
    settled: (id: WorkstreamId) => boolean;
    act?: (id: WorkstreamId) => Promise<void>;
  }>([
    {
      name: 'at a stop',
      end: [{ do: 'await_message', contains: 'never sent' }],
      act: async (id) => {
        await waitFor(wrote);
        await engine.runner.stopPassLane(id);
      },
      settled: (id) => row(id).state === 'QUEUED' && !engine.runner.isRunning(id),
    },
    {
      name: 'at Ready',
      end: [
        { do: 'turn_complete', text: 'Added a button.' },
        { do: 'await_message', contains: 'never sent' },
      ],
      settled: (id) => isWaiting(id) && readyItems().length === 1,
    },
    {
      name: 'at a failed turn',
      end: [{ do: 'billing_refused', message: 'a billing check refused the session' }],
      settled: (id) => isWaiting(id) && !engine.runner.isRunning(id),
    },
    {
      name: 'at a usage pause',
      end: [{ do: 'rate_limit', status: 'rejected', resetsInSeconds: 600 }],
      settled: (id) => row(id).state === 'PAUSED_LIMIT' && !engine.runner.isRunning(id),
    },
  ])('is kept on the chain and released $name', async ({ end, settled, act }) => {
    const { pass, id } = await openPage(
      [sharedTurn(end)],
      'Make the form tidy',
      () => undefined,
      WITH_SHARED,
    );
    await act?.(id);
    await waitFor(() => settled(id));
    await waitFor(() => listSharedChanges(engine.store.db, pass.id).length === 1);

    expect(activeClaims(engine.store.db, id).map((c) => c.name)).not.toContain('src');
    expect(openHolds(engine.store.db, pass.id)).toEqual([]);
    expect(listSharedChanges(engine.store.db, pass.id)[0]?.paths).toEqual(['src/button.ts']);
    expect(git('show', `refs/10db/passes/${pass.id}/shared:src/button.ts`)).toBe('button');
  });
});

describe("a pass turn's question about a shared area", () => {
  const PEOPLE = 'People: list';
  /** People's agent asks for the shared area another page changed. */
  const asks: FakeStep = {
    do: 'mcp',
    tool: 'request_claim',
    args: { opId: 'op-people-src', kind: 'area', name: 'src', reason: 'a wider button' },
  };

  /**
   * Settings and People in a pass, Settings having changed the shared button in a turn of its own;
   * People's session takes its message, asks for `src`, then runs `rest`.
   */
  async function askingAfterSettings(rest: FakeStep[]) {
    engine = await createTestEngine(
      {
        [PEOPLE]: [[{ do: 'consume' }, asks, ...rest]],
      },
      {
        gateCommand: null,
        areas: [
          { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
          { name: 'people', globs: ['src/people/**'], role: 'page', route: '/people' },
          { name: 'src', globs: ['src/**'], role: 'shared' },
        ],
      },
      {},
      { claims: { sliceMs: 200, pollMs: 20 } },
    );
    const branch = '10db/polish-abc123';
    const startSha = git('rev-parse', 'HEAD');
    git('switch', '-q', '-c', branch);
    const { settings, people, passId } = engine.state.write((ctx) => {
      const tasks = ['Settings: form', PEOPLE].map((title, at) =>
        insertTask(ctx, engine.project.id, {
          title,
          acceptanceCriteria: ['x'],
          areas: [at === 0 ? 'settings' : 'people'],
        }),
      );
      const [s, p] = tasks;
      if (!s || !p) throw new Error('no tasks');
      const opened = insertPass(ctx, {
        id: mintId('Pass'),
        projectId: engine.project.id,
        name: 'Polish',
        pageCap: 4,
        returnBranch: 'main',
        startSha,
        branch,
        baseBranch: 'main',
        repo: null,
        taskIds: [s.id, p.id],
        dirt: [],
      });
      const first = { model: 'claude-sonnet-5-5', effort: 'medium' } as const;
      const sw = insertWorkstream(ctx, s.id, { batchId: opened.batch.id, first });
      const pw = insertWorkstream(ctx, p.id, { batchId: opened.batch.id, first });
      insertPassTurn(ctx, { taskId: s.id, workstreamId: sw.id, sessionId: null, messageId: null });
      insertBuilderMessage(ctx, p.id, { body: 'Make the list wider', files: [] });
      return { settings: sw.id, people: pw.id, passId: opened.pass.id };
    });
    // Settings changed the shared button in a turn of its own.
    const granted = await grantSharedHold(passWork(), { workstreamId: settings, area: 'src' });
    if (!granted?.ok) throw new Error('src was not granted');
    mkdirSync(join(engine.repoPath, 'src'), { recursive: true });
    writeFileSync(join(engine.repoPath, 'src/button.ts'), 'button\n');
    await closeHoldsOf(passWork(), settings);
    return { people, passId, peopleTask: getWorkstreamRow(engine.store.db, people).taskId };
  }

  it('is withdrawn when the turn ends, and the area is never granted to a Ready page', async () => {
    const { people, passId } = await askingAfterSettings([
      { do: 'turn_complete', text: 'Kept it to the page.' },
      { do: 'await_message', contains: 'never sent' },
    ]);
    engine.launch(people);
    await waitFor(() => isWaiting(people));

    const asked = listInbox(engine.store.db, {}).find(
      (i) => SharedAskDetail.safeParse(i.detail).success,
    );
    expect(asked?.state).toBe('CANCELLED');
    if (!asked) throw new Error('no question');
    expect(() => engine.inbox.answer(asked.id, { choice: SHARED_ASK_ALLOW_CHOICE })).toThrow(
      ConflictError,
    );
    expect(openHolds(engine.store.db, passId)).toEqual([]);
    expect(activeClaims(engine.store.db, people).map((c) => c.name)).not.toContain('src');
    const result = engine.adapter.observations.find((o) => o.kind === 'mcp_result');
    expect(result?.detail).toMatchObject({ tool: 'request_claim', isError: false });
  });

  it("starts the page's next turn with a reply that came as its turn ended", async () => {
    const { people, passId, peopleTask } = await askingAfterSettings([
      { do: 'turn_complete', text: 'Kept it to the page.' },
      { do: 'await_message', contains: 'Use the page one' },
      { do: 'consume' },
      { do: 'turn_complete', text: 'Used the page one.' },
      { do: 'await_message', contains: 'never sent' },
    ]);
    // The builder answers as the turn's end is written, before its step 2 withdraws the question.
    const unsubscribe = engine.bus.subscribe((event) => {
      if (event.type !== EventType.PassTurnEnded) return;
      unsubscribe();
      const asked = listInbox(engine.store.db, {}).find(
        (i) => SharedAskDetail.safeParse(i.detail).success && i.state === 'OPEN',
      );
      if (asked)
        engine.inbox.answer(asked.id, {
          choice: SHARED_ASK_REPLY_CHOICE,
          note: 'Use the page one',
        });
    });

    engine.launch(people);
    await waitFor(
      () =>
        listPassTurns(engine.store.db, passId).filter(
          (t) => t.taskId === peopleTask && t.settledAt !== null,
        ).length === 2 && isWaiting(people),
    );

    const reply = listTaskThread(engine.store.db, peopleTask).find(
      (m) => m.author === 'builder' && m.body === 'Use the page one',
    );
    expect(reply).toBeDefined();
    expect(
      listPassTurns(engine.store.db, passId)
        .filter((t) => t.taskId === peopleTask)
        .map((t) => [t.seq, t.ending, t.messageId]),
    ).toEqual([
      [1, 'ready', expect.anything()],
      [2, 'ready', reply?.id],
    ]);
  });
});

describe("the builder's Stop", () => {
  it('ends a working turn as stopped, its work kept, with nothing Ready, and queues nothing to run', async () => {
    const { task, pass, id } = await openPage([
      [
        { do: 'consume' },
        { do: 'tool', toolName: 'Write', input: { file_path: PAGE_FILE, content: 'half\n' } },
        { do: 'await_message', contains: 'never sent' },
      ],
    ]);
    await waitFor(() => engine.adapter.observations.some((o) => o.kind === 'tool_allowed'));

    await engine.runner.stopPassLane(id);

    const [stopped] = listPassTurns(engine.store.db, pass.id);
    expect(stopped).toMatchObject({ seq: 1, ending: 'stopped', readyAt: null });
    expect(stopped?.settledAt).not.toBeNull();
    expect(git('show', `${stopped?.keptSha ?? ''}:${PAGE_FILE}`)).toBe('half');
    expect(readyItems()).toEqual([]);
    expect(row(id)).toMatchObject({
      state: 'QUEUED',
      currentSessionId: null,
      leaseOwner: null,
      nextAction: { kind: 'resume', reason: 'stopped' },
    });
    // Nothing waits for a turn, so the launch rule starts none until the builder writes.
    expect(untakenMessages(engine.store.db, task.id)).toEqual([]);
    expect(engine.runner.isRunning(id)).toBe(false);
  });

  it('stops a page whose session is starting, spending no recovery attempt', async () => {
    const { pass, id } = await openPage([
      [...turn('one\n', 'Tidied.'), { do: 'await_message', contains: 'never sent' }],
    ]);
    // The lane has been granted and has not opened its turn yet.
    expect(engine.runner.isRunning(id)).toBe(true);
    expect(listPassTurns(engine.store.db, pass.id)).toEqual([]);

    await engine.runner.stopPassLane(id);

    expect(engine.adapter.prompts).toEqual([]);
    expect(
      listPassTurns(engine.store.db, pass.id).map((t) => [t.seq, t.ending, t.settledAt !== null]),
    ).toEqual([[1, 'stopped', true]]);
    expect(row(id)).toMatchObject({ state: 'QUEUED', recoveryAttempts: 0, leaseOwner: null });
    expect(readyItems()).toEqual([]);
  });

  it('resolves at once for a page with no session, changing nothing', async () => {
    const { id } = await openPage([[...turn('one\n', 'Tidied.')]]);
    await waitFor(() => !engine.runner.isRunning(id) && row(id).state === 'WAITING_HUMAN');
    const before = row(id);
    await engine.runner.stopPassLane(id);
    expect(row(id)).toEqual(before);
  });
});

describe('a message that meets a stop', () => {
  it('goes to no session that is stopping, and waits in the thread for the next', async () => {
    const { task, pass, id } = await openPage([working]);
    await waitFor(wrote);
    let release: () => void = () => undefined;
    engine.adapter.laneStopGate = new Promise((resolve) => {
      release = resolve;
    });
    const message = engine.state.write((ctx) =>
      insertBuilderMessage(ctx, task.id, { body: 'Bigger please', files: [] }),
    );
    // The builder stops the page while the message is on its way in.
    const delivering = engine.runner.deliverMessage(task.id, message.id, { redo: false });
    const stopping = engine.runner.stopPassLane(id);
    await delivering;
    release();
    await stopping;

    expect(engine.adapter.sent.some((m) => m.text.includes('Bigger please'))).toBe(false);
    expect(untakenMessages(engine.store.db, task.id)).toEqual([message.id]);
    expect(listPassTurns(engine.store.db, pass.id).map((t) => [t.seq, t.ending])).toEqual([
      [1, 'stopped'],
    ]);
    expect(row(id).state).toBe('QUEUED');
  });

  it('is refused once the pass no longer holds the page', async () => {
    const { task, id } = await openPage([
      [...turn('one\n', 'Tidied.'), { do: 'await_message', contains: 'never sent' }],
    ]);
    await waitFor(isReady(id, 1));
    engine.state.write((ctx) => {
      leavePass(ctx, task.id);
    });
    const message = engine.state.write((ctx) =>
      insertBuilderMessage(ctx, task.id, { body: 'Bigger please', files: [] }),
    );

    await expect(
      engine.runner.deliverMessage(task.id, message.id, { redo: false }),
    ).rejects.toThrow(ConflictError);
    expect(engine.adapter.sent).toEqual([]);
  });
});

describe('Stop and Redo', () => {
  it('interrupts the running turn and goes on with the message in the same turn, never Ready between', async () => {
    const { task, pass, id } = await openPage([
      [
        { do: 'consume' },
        { do: 'tool', toolName: 'Write', input: { file_path: PAGE_FILE, content: 'half\n' } },
        { do: 'await_message', contains: 'Instead' },
        ...turn('other\n', 'Did it the other way.'),
        { do: 'await_message', contains: 'never sent' },
      ],
    ]);
    await waitFor(() => engine.adapter.observations.some((o) => o.kind === 'tool_allowed'));
    const message = engine.state.write((ctx) =>
      insertBuilderMessage(ctx, task.id, { body: 'Instead: the other way', files: [] }),
    );
    await engine.runner.deliverMessage(task.id, message.id, { redo: true });
    await waitFor(isReady(id, 1));

    expect(engine.adapter.interrupts).toHaveLength(1);
    expect(listPassTurns(engine.store.db, pass.id).map((t) => [t.seq, t.ending])).toEqual([
      [1, 'ready'],
    ]);
  });
});

describe("a pass task's warm session", () => {
  const warm = (): FakeStep[][] => [
    [...turn('one\n', 'Tidied the form.'), { do: 'await_message', contains: 'Bigger' }],
    [...turn('two\n', 'Made it bigger.'), { do: 'await_message', contains: 'never sent' }],
  ];

  it('closes once idle after a Ready turn, freeing its lane, and the next message resumes it', async () => {
    const { task, id } = await openPage(warm());
    await waitFor(isReady(id, 1));
    expect(engine.runner.isRunning(id)).toBe(true);

    engine.clock.advance(DEFAULT_RUNNER_LIMITS.warmIdleMs);
    await waitFor(() => !engine.runner.isRunning(id));

    expect(row(id)).toMatchObject({
      state: 'WAITING_HUMAN',
      nextAction: { kind: 'pass_review' },
      currentSessionId: null,
      leaseOwner: null,
    });
    expect(readyItems().map((i) => i.state)).toEqual(['OPEN']);

    await write(task, 'Bigger please');
    expect(row(id)).toMatchObject({ state: 'QUEUED', nextAction: { kind: 'feedback' } });
    engine.launch(id);
    await waitFor(isReady(id, 2));
    // The second session resumes the conversation the first one had.
    expect(engine.adapter.prompts[1]?.resume).toBe(
      `fake-${engine.adapter.prompts[0]?.sessionId ?? ''}`,
    );
  });

  it.each([
    {
      name: 'the message is kept first: the session stays open and takes it',
      messageFirst: true,
    },
    {
      name: 'the close decides first: the session closes, and the message resumes it',
      messageFirst: false,
    },
  ])('a message as the idle close decides, $name', async ({ messageFirst }) => {
    const { task, id } = await openPage([
      [
        ...turn('one\n', 'Tidied the form.'),
        { do: 'await_message', contains: 'Bigger' },
        ...turn('two\n', 'Made it bigger.'),
        { do: 'await_message', contains: 'never sent' },
      ],
      [...turn('two\n', 'Made it bigger.'), { do: 'await_message', contains: 'never sent' }],
    ]);
    await waitFor(isReady(id, 1));
    const keep = () =>
      engine.state.write((ctx) =>
        insertBuilderMessage(ctx, task.id, { body: 'Bigger please', files: [] }),
      );
    // The close decides in one write as it is called; the message is kept before it is handed over.
    const message = messageFirst ? keep() : null;
    const closing = engine.runner.closeWarm(id);
    const kept = message ?? keep();
    await engine.runner.deliverMessage(task.id, kept.id, { redo: false });
    await closing;

    if (messageFirst) {
      expect(engine.runner.isRunning(id)).toBe(true);
    } else {
      expect(engine.runner.isRunning(id)).toBe(false);
      expect(row(id)).toMatchObject({
        state: 'QUEUED',
        nextAction: { kind: 'feedback', messageId: kept.id },
      });
      expect(readyItems().map((i) => i.state)).toEqual(['CANCELLED']);
      engine.launch(id);
    }
    await waitFor(isReady(id, 2));
    expect(engine.adapter.prompts).toHaveLength(messageFirst ? 1 : 2);
  });
});

describe("a pass task's handoffs", () => {
  /** An unasked handoff that names work left, written after the turn has changed the page. */
  const handOffAfter = (content: string, op: string): FakeStep[] => [
    { do: 'tool', toolName: 'Write', input: { file_path: PAGE_FILE, content } },
    { do: 'mcp', tool: 'write_handoff', args: handoffArgs(op, 'Finish the form') },
    { do: 'turn_complete', text: 'Handing off.' },
  ];

  it('closes a Ready page asked to hand off for its account, and sends it nothing', async () => {
    const { id } = await openPage([
      [...turn('one\n', 'Tidied the form.'), { do: 'await_message', contains: 'never sent' }],
    ]);
    await waitFor(isReady(id, 1));
    engine.runner.handOff(
      engine.project.id,
      engine.project.accountId,
      'the account is near its limit',
    );
    await waitFor(() => !engine.runner.isRunning(id));
    expect(engine.adapter.sent).toEqual([]);
    expect(row(id)).toMatchObject({
      state: 'WAITING_HUMAN',
      nextAction: { kind: 'pass_review' },
      currentSessionId: null,
    });
  });

  it('closes a Ready page asked to hand off for its account after an earlier turn was nudged', async () => {
    const { id } = await openPage(
      [
        [
          { do: 'consume' },
          { do: 'tool', toolName: 'Write', input: { file_path: PAGE_FILE, content: 'one\n' } },
          // The context fills: the session is nudged, then nudged firmly, and ends without a handoff.
          { do: 'context', percentage: 80 },
          { do: 'await_message', contains: 'filling up' },
          { do: 'turn_complete', text: 'Nearly done.' },
          { do: 'await_message', contains: 'almost full' },
          { do: 'turn_complete', text: 'Tidied the form.' },
          { do: 'await_message', contains: 'never sent' },
        ],
      ],
      'Make the form tidy',
      () => {
        engine.state.write((ctx) => {
          patchProject(ctx, engine.project.id, { handoffPct: 30, nudgePct: 95 });
        });
      },
    );
    await waitFor(isReady(id, 1));
    expect(engine.adapter.sent).toHaveLength(2);

    engine.runner.handOff(
      engine.project.id,
      engine.project.accountId,
      'the account is near its limit',
    );
    await waitFor(() => !engine.runner.isRunning(id));
    expect(engine.adapter.sent).toHaveLength(2);
    expect(row(id)).toMatchObject({ state: 'WAITING_HUMAN', nextAction: { kind: 'pass_review' } });
  });

  it('goes on with a long turn through handoffs nobody asked for while its work moves between them', async () => {
    const { pass, id } = await openPage([
      [{ do: 'consume' }, ...handOffAfter('one\n', 'op-pass-h1')],
      handOffAfter('two\n', 'op-pass-h2'),
      handOffAfter('three\n', 'op-pass-h3'),
      [...turn('four\n', 'Finished the form.'), { do: 'await_message', contains: 'never sent' }],
    ]);
    await waitFor(isReady(id, 1));
    expect(engine.adapter.prompts).toHaveLength(4);
    const turns = listPassTurns(engine.store.db, pass.id);
    expect(turns.map((t) => [t.seq, t.ending])).toEqual([[1, 'ready']]);
    expect(git('show', `${turns[0]?.keptSha ?? ''}:${PAGE_FILE}`)).toBe('four');
  });

  it('runs twelve rounds with a low handoff line, each Ready, no message lost and nothing sent back', async () => {
    const ROUNDS = 12;
    /** A round's work, from its message to the handoff its context forces. */
    const round = (n: number): FakeStep[] => [
      { do: 'consume' },
      { do: 'tool', toolName: 'Write', input: { file_path: PAGE_FILE, content: `${String(n)}\n` } },
      { do: 'context', percentage: 80 },
      { do: 'await_message', contains: 'write_handoff' },
      { do: 'mcp', tool: 'write_handoff', args: handoffArgs(`op-round-${String(n)}`, 'Say done') },
      { do: 'turn_complete', text: `Handing off round ${String(n)}.` },
    ];
    const sessions: FakeStep[][] = [round(1)];
    for (let n = 1; n <= ROUNDS; n += 1)
      sessions.push([
        // The continued session's briefing sets its baseline; then it finishes the round.
        { do: 'context', percentage: 10 },
        { do: 'turn_complete', text: `Round ${String(n)} done.` },
        ...(n < ROUNDS
          ? [{ do: 'await_message' as const, contains: `Round ${String(n + 1)}` }, ...round(n + 1)]
          : [{ do: 'await_message' as const, contains: 'never sent' }]),
      ]);
    const { task, pass, id } = await openPage(sessions, 'Round 1: tidy the form');
    engine.state.write((ctx) => {
      patchProject(ctx, engine.project.id, { handoffPct: 30, nudgePct: 95 });
    });
    for (let n = 1; n <= ROUNDS; n += 1) {
      await waitFor(isReady(id, n), 20_000);
      if (n < ROUNDS) await write(task, `Round ${String(n + 1)}: once more`);
    }

    const turns = listPassTurns(engine.store.db, pass.id);
    expect(turns.map((t) => t.ending)).toEqual(Array.from({ length: ROUNDS }, () => 'ready'));
    expect(
      listTaskThread(engine.store.db, task.id)
        .filter((m) => m.author === 'builder')
        .every((m) => m.deliveredAt !== null),
    ).toBe(true);
    expect(row(id)).toMatchObject({ attempt: 0, state: 'WAITING_HUMAN' });
    expect(engine.adapter.prompts).toHaveLength(ROUNDS + 1);
    expect(git('show', `${turns.at(-1)?.keptSha ?? ''}:${PAGE_FILE}`)).toBe(String(ROUNDS));
  }, 60_000);
});

describe('a pass page across a restart', () => {
  /**
   * The daemon stops and starts again: its sessions end, and recovery runs over the rows.
   * `whileDown` writes what the daemon kept before it died and never acted on.
   */
  async function restart(whileDown: () => void = () => undefined): Promise<void> {
    await engine.runner.stopAll('shutdown');
    whileDown();
    await recoverOnStartup({
      state: engine.state,
      inbox: engine.inbox,
      git: createGit(),
      processes: systemProcesses,
      jobs: createDeliveryJobs(silentLogger),
      clock: engine.clock,
      maxRecoveryAttempts: 3,
      logger: silentLogger,
      cleanShutdown: false,
    });
  }

  it('keeps a Ready page waiting on its Ready item', async () => {
    const { id } = await openPage([
      [...turn('one\n', 'Tidied.'), { do: 'await_message', contains: 'never sent' }],
    ]);
    await waitFor(isReady(id, 1));
    const [item] = readyItems();
    await restart();
    expect(row(id)).toMatchObject({
      state: 'WAITING_HUMAN',
      nextAction: { kind: 'pass_review', inboxId: item?.id },
      currentSessionId: null,
    });
    expect(readyItems().map((i) => i.state)).toEqual(['OPEN']);
  });

  it.each<{
    name: string;
    first: FakeStep[];
    before: (id: WorkstreamId) => boolean;
    down: (task: TaskDto) => void;
  }>([
    {
      name: 'Ready',
      first: [...turn('one\n', 'Tidied.'), { do: 'await_message', contains: 'never sent' }],
      before: (id) => isReady(id, 1)(),
      down: () => undefined,
    },
    {
      name: 'whose turn ended before its work was kept',
      first: working,
      before: () => wrote(),
      down: (task) => {
        engine.state.write((ctx) => {
          const open = openPassTurn(ctx.tx, task.id);
          if (!open) throw new Error('no open turn');
          endPassTurn(ctx, open.id, { ending: 'ready', replyBody: 'Tidied.' });
        });
      },
    },
  ])(
    'queues a page $name with a message no turn took, its item withdrawn',
    async ({ first, before, down }) => {
      const { task, id } = await openPage([
        first,
        [...turn('two\n', 'Made it bigger.'), { do: 'await_message', contains: 'never sent' }],
      ]);
      await waitFor(() => before(id));
      let message: TaskMessageId | null = null;
      await restart(() => {
        down(task);
        // The message was kept; the daemon died before it was handed over.
        message = engine.state.write(
          (ctx) => insertBuilderMessage(ctx, task.id, { body: 'Bigger please', files: [] }).id,
        );
      });

      expect(row(id)).toMatchObject({
        state: 'QUEUED',
        nextAction: { kind: 'feedback', messageId: message },
      });
      expect(readyItems().filter((i) => i.state === 'OPEN')).toEqual([]);
      engine.launch(id);
      await waitFor(() => isWaiting(id) && untakenMessages(engine.store.db, task.id).length === 0);
    },
  );

  it('resumes a turn cut short mid-way, without handing the message over again', async () => {
    const { id } = await openPage([
      working,
      [...turn('two\n', 'Finished it.'), { do: 'await_message', contains: 'never sent' }],
    ]);
    await waitFor(wrote);
    await restart();
    expect(row(id)).toMatchObject({
      state: 'QUEUED',
      nextAction: { kind: 'resume' },
      recoveryAttempts: 1,
    });

    engine.launch(id);
    await waitFor(isReady(id, 1));
    // The turn that got through counts for the page: the next crash is its first again.
    expect(row(id).recoveryAttempts).toBe(0);
    expect(engine.adapter.prompts[1]?.resume).not.toBeNull();
    expect(engine.adapter.prompts[1]?.prompt).not.toContain('Make the form tidy');
    expect(engine.adapter.sent).toEqual([]);
  });

  it("starts a fresh session for a turn whose session cannot be resumed from that turn's message", async () => {
    const { pass, id } = await openPage([
      working,
      // The resumed session dies at once, so the next one cannot resume it.
      [{ do: 'crash', message: 'the resumed session died' }],
      [...turn('two\n', 'Finished it.'), { do: 'await_message', contains: 'never sent' }],
    ]);
    await waitFor(wrote);
    await restart();
    engine.launch(id);
    await waitFor(() => engine.adapter.prompts.length === 2 && !engine.runner.isRunning(id));
    expect(row(id)).toMatchObject({ state: 'QUEUED', nextAction: { kind: 'start' } });

    engine.launch(id);
    await waitFor(isReady(id, 1));
    // The fresh session is given the message its turn began with, not a bare start.
    expect(engine.adapter.prompts[2]?.resume).toBeNull();
    expect(engine.adapter.prompts[2]?.prompt).toContain('Make the form tidy');
    expect(listPassTurns(engine.store.db, pass.id).map((t) => [t.seq, t.ending])).toEqual([
      [1, 'ready'],
    ]);
  });

  it('finishes a turn that ended before its work was kept, by its ending, resuming nothing', async () => {
    const { task, pass, id } = await openPage([working]);
    await waitFor(wrote);
    await engine.runner.stopAll('shutdown');
    // The daemon stopped between the turn's end and keeping its work.
    engine.state.write((ctx) => {
      const open = openPassTurn(ctx.tx, task.id);
      if (!open) throw new Error('no open turn');
      endPassTurn(ctx, open.id, { ending: 'ready', replyBody: 'Tidied.' });
    });
    await restart();

    const [finished] = listPassTurns(engine.store.db, pass.id);
    expect(finished?.settledAt).not.toBeNull();
    expect(git('show', `${finished?.keptSha ?? ''}:${PAGE_FILE}`)).toBe('one');
    expect(row(id)).toMatchObject({ state: 'WAITING_HUMAN', nextAction: { kind: 'pass_review' } });
    expect(readyItems().map((i) => i.state)).toEqual(['OPEN']);
    expect(engine.adapter.prompts).toHaveLength(1);
  });

  it('parks a page past the recovery limit on a failed turn, never failing it', async () => {
    const { pass, id } = await openPage([working]);
    await waitFor(wrote);
    engine.state.write((ctx) => {
      patchWorkstream(ctx, id, null, { recoveryAttempts: 3 });
    });
    await restart();

    expect(listPassTurns(engine.store.db, pass.id).map((t) => t.ending)).toEqual(['failed']);
    // Retry Turn starts the page over, with every attempt to come.
    expect(row(id)).toMatchObject({
      state: 'WAITING_HUMAN',
      nextAction: { kind: 'pass_review' },
      recoveryAttempts: 0,
    });
    expect(
      listInbox(engine.store.db, {}).filter((i) => i.title.startsWith('Turn failed')),
    ).toHaveLength(1);
  });
});
