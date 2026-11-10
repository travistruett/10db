import { execFileSync } from 'node:child_process';
import {
  mintId,
  PassCheckDetail,
  type PassDto,
  type TaskDto,
  type WorkstreamId,
} from '@10db/contracts';
import {
  getWorkstreamRow,
  insertBuilderMessage,
  insertPass,
  insertTask,
  insertWorkstream,
  listInbox,
  listPassTurns,
  listTaskThread,
  type WorkstreamRow,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEngine, type TestEngine } from '../../test/engine';
import { isolatedGitEnv, waitFor } from '../../test/fixtures';
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
): Promise<{ task: TaskDto; pass: PassDto; id: WorkstreamId }> {
  engine = await createTestEngine({ [TITLE]: sessions }, PAGE_AREAS);
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
  engine.launch(ws.id);
  return { task, pass, id: ws.id };
}

const row = (id: WorkstreamId): WorkstreamRow => getWorkstreamRow(engine.store.db, id);
const readyItems = () =>
  listInbox(engine.store.db, {}).filter((i) => PassCheckDetail.safeParse(i.detail).success);
const isReady = (id: WorkstreamId, items: number) => () =>
  row(id).state === 'WAITING_HUMAN' &&
  row(id).nextAction.kind === 'pass_review' &&
  readyItems().length === items;

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

  it('a message pushed as a turn ends holds the page out of Ready until the next turn ends', async () => {
    const { task, pass, id } = await openPage([
      [
        { do: 'consume' },
        { do: 'tool', toolName: 'Write', input: { file_path: PAGE_FILE, content: 'one\n' } },
        // The builder writes now: the turn is ending and has not taken it.
        { do: 'await_message', contains: 'Also' },
        { do: 'turn_complete', text: 'Tidied the form.' },
        ...turn('two\n', 'Made it bigger too.'),
        { do: 'await_message', contains: 'never sent' },
      ],
    ]);
    await waitFor(() => listPassTurns(engine.store.db, pass.id).length === 1);
    await write(task, 'Also make it bigger');
    await waitFor(isReady(id, 1));

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
