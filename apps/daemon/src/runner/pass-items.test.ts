import { execFileSync } from 'node:child_process';
import {
  mintId,
  ToolCallStatus,
  type ConversationDeltaFrame,
  type PassId,
  type TaskDto,
  type ToolCallView,
  type WorkstreamId,
} from '@10db/contracts';
import {
  insertBuilderMessage,
  insertPass,
  insertTask,
  insertWorkstream,
  listItems,
  listPassTurns,
  listTaskThread,
  taskConversationOf,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEngine, type TestEngine } from '../../test/engine';
import { isolatedGitEnv, waitFor } from '../../test/fixtures';
import { readFullOutput } from '../conversation';
import type { FakeScriptBook } from '../sessions';

// Sessions spec §6.1, §6.3, §6.5: a page's session streams into its task's conversation through the
// library. Its replies, thinking and calls are items under the turn, a call's whole output is on disk,
// what streams goes out as live frames, and a turn stopped early keeps what it streamed.

type FakeStep = FakeScriptBook[string][number][number];

const PAGE_AREAS = {
  gateCommand: null,
  areas: [{ name: 'settings', globs: ['src/settings/**'], role: 'page' as const, route: '/x' }],
};
const TITLE = 'Settings: tidy the form';
const OUTPUT = 'ok\n'.repeat(40_000);

let engine: TestEngine;
afterEach(async () => {
  await engine.close();
});

const command = (status: ToolCallStatus): ToolCallView => ({
  kind: 'command',
  id: 'call-1',
  harnessTool: 'Bash',
  status,
  title: 'pnpm test',
  startedAt: new Date(0).toISOString(),
  durationMs: null,
  parentId: null,
  refusal: null,
  deniedBy: null,
  limit: null,
  soft: null,
  command: 'pnpm test',
  cwd: null,
  outputTail: OUTPUT.slice(-200),
  outputBytes: OUTPUT.length,
  exitCode: status === ToolCallStatus.Done ? 0 : null,
});

async function openPage(
  steps: FakeStep[],
): Promise<{ task: TaskDto; id: WorkstreamId; passId: PassId }> {
  engine = await createTestEngine({ [TITLE]: [steps] }, PAGE_AREAS);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', engine.repoPath, ...args], { env: isolatedGitEnv() })
      .toString()
      .trim();
  const startSha = git('rev-parse', 'HEAD');
  const branch = '10db/polish-abc123';
  git('switch', '-q', '-c', branch);
  const { task, ws, passId } = engine.state.write((ctx) => {
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
    insertBuilderMessage(ctx, t.id, { body: 'Make the form tidy', files: [] });
    return { task: t, ws: w, passId: opened.pass.id };
  });
  engine.launch(ws.id);
  return { task, id: ws.id, passId };
}

const itemsOf = (task: TaskDto) => {
  const conversation = taskConversationOf(engine.store.db, task.id);
  if (conversation === null) throw new Error('no conversation');
  return { conversationId: conversation.id, items: listItems(engine.store.db, conversation.id) };
};

describe("a page's turn through the conversation library", () => {
  it.each([
    {
      name: 'a reply after what it said earlier is its own item',
      reply: 'Tidied the form.',
      kinds: ['message', 'agent_message', 'tool_call', 'agent_message'],
    },
  ])('stores its items under the turn: $name', async ({ reply, kinds }) => {
    const frames: ConversationDeltaFrame[] = [];
    const steps: FakeStep[] = [
      { do: 'consume' },
      ...(reply === 'Tidied the form.' ? [{ do: 'say' as const, text: 'Ran the tests.' }] : []),
      { do: 'tool_call', call: command(ToolCallStatus.Running) },
      { do: 'tool_call', call: command(ToolCallStatus.Done), full: { output: OUTPUT } },
      // As both providers make it, the turn's text is its last reply's.
      { do: 'say', text: reply },
      { do: 'turn_complete', text: reply },
      { do: 'await_message', contains: 'never sent' },
    ];
    const { task, passId } = await openPage(steps);
    const unsubscribe = engine.frames.subscribe((frame) => frames.push(frame));
    await waitFor(() => listPassTurns(engine.store.db, passId).some((t) => t.readyAt !== null));
    unsubscribe();

    const { conversationId, items } = itemsOf(task);
    // 10db's own notices aside (a fresh session began), in the order they came.
    expect(items.filter((i) => i.author !== 'system').map((i) => i.kind)).toEqual(kinds);
    const [turn] = listPassTurns(engine.store.db, passId);
    // Every item of the agent's is the turn's, and its reply is one, on the thread as on the items.
    expect(items.filter((i) => i.author === 'agent').map((i) => i.turnId)).toEqual(
      items.filter((i) => i.author === 'agent').map(() => turn?.id),
    );
    expect(
      listTaskThread(engine.store.db, task.id)
        .filter((m) => m.author === 'agent')
        .map((m) => m.body)
        .at(-1),
    ).toBe(reply);
    const call = items.find((i) => i.kind === 'tool_call');
    if (call === undefined) throw new Error('no call');
    expect(readFullOutput(engine.dataDir, conversationId, call.id).output).toBe(OUTPUT);
    // The running call went out as a live frame of the task's conversation, never stored as one.
    expect(frames.some((f) => f.conversationId === conversationId && f.itemId === call.id)).toBe(
      true,
    );
    expect(engine.laneLive.live(conversationId).items).toEqual([]);
  });

  it('keeps what a stopped turn streamed, marked partial, and serves it live until then', async () => {
    const { task, id, passId } = await openPage([
      { do: 'consume' },
      { do: 'think', text: 'The padding is uneven.' },
      { do: 'tool_call', call: command(ToolCallStatus.Running) },
      { do: 'await_message', contains: 'never sent' },
    ]);
    const conversationId = await waitFor(() => {
      const conversation = taskConversationOf(engine.store.db, task.id);
      return conversation !== null &&
        engine.laneLive.live(conversation.id).items.some((i) => i.kind === 'tool_call')
        ? conversation.id
        : undefined;
    });

    await engine.runner.stopPassLane(id);

    const kept = listItems(engine.store.db, conversationId).filter((i) => i.author === 'agent');
    const [turn] = listPassTurns(engine.store.db, passId);
    expect(kept.map((i) => [i.kind, i.partial, i.turnId])).toEqual([
      ['reasoning', false, turn?.id],
      ['tool_call', true, turn?.id],
    ]);
    expect(kept[1]?.body).toMatchObject({ status: ToolCallStatus.Failed });
    expect(engine.laneLive.live(conversationId).items).toEqual([]);
  });
});
