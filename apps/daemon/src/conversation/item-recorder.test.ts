import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_STEP_SUMMARY, mintId, PassTurnEnding } from '@10db/contracts';
import {
  createTestStore,
  endPassTurn,
  ensureTaskConversation,
  insertPass,
  insertPassTurn,
  insertTask,
  insertWorkstream,
  listItems,
  listTaskThread,
  openPassTurn,
  seedProject,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { createEventBus, createLiveFrames, createStateStore } from '../events';
import { silentLogger } from '../log';
import { createItemRecorder, type ItemEvent } from './item-recorder';

// Sessions spec §6.1, §6.3: a page's turn keeps its reply once. The recorder hands the turn end the
// item its reply already is, whatever the provider's turn text made of it (trimmed, capped), and a
// turn's end or stop leaves nothing in flight and every item it kept under the turn.

const LONG = 'x'.repeat(MAX_STEP_SUMMARY + 1);
/** The turn's text as both mappings make it from the last reply: trimmed and capped. */
const turnText = (reply: string) => reply.trim().slice(0, MAX_STEP_SUMMARY);

const delta = (itemId: string, text: string): ItemEvent => ({
  type: 'text_delta',
  itemId,
  offset: 0,
  text,
});
const thinking = (itemId: string, text: string): ItemEvent => ({
  type: 'reasoning_delta',
  itemId,
  offset: 0,
  text,
});
const message = (itemId: string, text: string): ItemEvent => ({ type: 'message', itemId, text });

let close: () => void = () => undefined;
afterEach(() => {
  close();
});

function setup() {
  const test = createTestStore();
  const dataDir = mkdtempSync(join(tmpdir(), '10db-recorder-'));
  close = () => {
    test.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  const { store } = test;
  const state = createStateStore(store, createEventBus());
  const project = seedProject(store, {
    areas: [{ name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' }],
  });
  const { taskId, turnId, conversationId } = store.write((ctx) => {
    const task = insertTask(ctx, project.id, {
      title: 'Tidy',
      acceptanceCriteria: ['x'],
      areas: ['settings'],
    });
    const opened = insertPass(ctx, {
      id: mintId('Pass'),
      projectId: project.id,
      name: 'Polish',
      pageCap: 4,
      returnBranch: 'main',
      startSha: 'a'.repeat(40),
      branch: '10db/polish-abc123',
      baseBranch: 'main',
      repo: null,
      taskIds: [task.id],
      dirt: [],
    });
    const ws = insertWorkstream(ctx, task.id, {
      batchId: opened.batch.id,
      first: { model: 'claude-sonnet-5-5', effort: 'medium' },
    });
    const turn = insertPassTurn(ctx, {
      taskId: task.id,
      workstreamId: ws.id,
      sessionId: null,
      messageId: null,
    });
    return {
      taskId: task.id,
      turnId: turn.id,
      conversationId: ensureTaskConversation(ctx, task.id).id,
    };
  }).value;
  const recorder = createItemRecorder({
    state,
    clock: new ManualClock(),
    log: silentLogger,
    dataDir,
    frames: createLiveFrames(),
    conversationId,
    turnId: () => openPassTurn(store.db, taskId)?.id ?? null,
  });
  return { store, state, recorder, taskId, turnId, conversationId };
}

describe('a turn’s reply through the item recorder', () => {
  it.each<{ name: string; events: ItemEvent[]; reply: string }>([
    {
      name: 'claude: a streamed reply ending in whitespace',
      events: [delta('msg_1:0', 'Done.\n'), message('msg_1:0', 'Done.\n')],
      reply: 'Done.\n',
    },
    {
      name: 'codex: a reply ending in whitespace',
      events: [delta('msg_a', 'Done.\n'), message('msg_a', 'Done.\n')],
      reply: 'Done.\n',
    },
    {
      name: 'claude: an unstreamed reply over the turn text’s cap',
      events: [message('msg_1:a0', LONG)],
      reply: LONG,
    },
    {
      name: 'codex: a reply over the turn text’s cap',
      events: [delta('msg_a', LONG), message('msg_a', LONG)],
      reply: LONG,
    },
    {
      name: 'claude: reasoning between the reply and the turn end',
      events: [message('msg_1:0', 'Done.'), thinking('msg_2:0', 'Checking once more')],
      reply: 'Done.',
    },
    {
      name: 'codex: reasoning between the reply and the turn end',
      events: [message('msg_a', 'Done.'), thinking('rs_b', 'Checking once more')],
      reply: 'Done.',
    },
    {
      name: 'claude: a reply that streamed with no message',
      events: [delta('msg_1:0', 'Done.')],
      reply: 'Done.',
    },
    {
      name: 'codex: a reply that streamed with no message',
      events: [delta('msg_a', 'Done.')],
      reply: 'Done.',
    },
  ])('keeps it once, finished, under the turn: $name', ({ events, reply }) => {
    const { store, state, recorder, taskId, turnId, conversationId } = setup();
    for (const event of events) recorder.record(event);
    const replyItem = recorder.turnEnded();
    state.write((ctx) =>
      endPassTurn(ctx, turnId, {
        ending: PassTurnEnding.Ready,
        replyBody: turnText(reply),
        replyItemId: replyItem,
      }),
    );

    const replies = listItems(store.db, conversationId).filter((i) => i.kind === 'agent_message');
    expect(replies.map((i) => [i.id, i.partial, i.turnId])).toEqual([[replyItem, false, turnId]]);
    expect(listTaskThread(store.db, taskId).filter((m) => m.author === 'agent')).toHaveLength(1);
    expect(recorder.buffers.inFlight()).toEqual([]);
  });

  it.each<{ name: string; events: ItemEvent[] }>([
    {
      name: 'claude',
      events: [thinking('msg_1:0', 'The padding'), delta('msg_1:1', 'Half a sen')],
    },
    { name: 'codex', events: [thinking('rs_a', 'The padding'), delta('msg_b', 'Half a sen')] },
  ])('keeps what a stopped turn streamed under the turn: $name', ({ events }) => {
    const { store, recorder, turnId, conversationId } = setup();
    for (const event of events) recorder.record(event);
    recorder.storePartial();

    expect(
      listItems(store.db, conversationId)
        .filter((i) => i.author === 'agent')
        .map((i) => [i.kind, i.partial, i.turnId]),
    ).toEqual([
      ['reasoning', false, turnId],
      ['agent_message', true, turnId],
    ]);
  });
});
