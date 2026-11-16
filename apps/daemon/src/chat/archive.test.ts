import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictError, type ChatDto, type ConversationState } from '@10db/contracts';
import { getInboxItem, getSession, insertInboxItem, listInbox, listItems } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { chatWorld, type ChatWorld } from '../../test/chat-world';
import { gate, type Gate } from '../../test/explore-world';
import { waitFor } from '../../test/fixtures';
import type { WaitObserver } from '../inbox';
import { EMPTY_SETUP } from '../sandbox';
import type { ShapePrepared } from '../shape';
import { chatFolder } from './hooks';

// Sessions spec §6.7's archive row: archiving a chat in any state M5a reaches ends its session, its
// card and its folder, and nothing sent afterwards spends a token.

let w: ChatWorld;
afterEach(async () => {
  await w.close();
});

const say = { mentions: [], pictures: [] };

/** The observer each start was prepared with, so a test can raise the card a call waits on. */
function observing(): {
  readonly observers: WaitObserver[];
  readonly prepare: (input: { observer: WaitObserver }) => Promise<ShapePrepared>;
} {
  const observers: WaitObserver[] = [];
  return {
    observers,
    prepare: (input) => {
      observers.push(input.observer);
      return Promise.resolve({
        sandbox: null,
        projectMcpServers: {},
        yourMcpServers: {},
        note: null,
        credentialsExpireAt: null,
        instructions: null,
        setup: EMPTY_SETUP,
        canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'no', by: 'builder' }),
        trackProcesses: () => undefined,
        release: () => Promise.resolve(),
      });
    },
  };
}

/** Each turn writes half a sentence, then waits for its gate. */
function gatedTurns(world: ChatWorld): Gate[] {
  const gates: Gate[] = [];
  world.adapter.shapeBehaviour = async (turn) => {
    turn.emit({ type: 'text_delta', itemId: 'half', offset: 0, text: 'Half a sen' });
    const g = gate();
    gates.push(g);
    await g.promise;
    return { text: 'Done.' };
  };
  return gates;
}

/** Archives the chat, then checks what every state's archive leaves: nothing live, nothing kept. */
async function archiveAndCheck(world: ChatWorld, chat: ChatDto): Promise<void> {
  mkdirSync(chatFolder(world.dataDir, chat.conversationId), { recursive: true });
  writeFileSync(join(chatFolder(world.dataDir, chat.conversationId), 'x'), 'x');
  const archived = await world.chat.archive(chat.id);
  expect(archived.archivedAt).not.toBeNull();
  expect(archived.tabPosition).toBeNull();
  for (const s of world.adapter.shapeSessions)
    expect(getSession(world.state.db, s.spec.sessionId).endedAt).not.toBeNull();
  expect(listInbox(world.state.db, { states: ['OPEN'] })).toEqual([]);
  expect(existsSync(chatFolder(world.dataDir, chat.conversationId))).toBe(false);
  const sessions = world.adapter.shapeSessions.length;
  expect(() => world.chat.send(chat.conversationId, { text: 'More?', ...say })).toThrow(
    new ConflictError('This session is archived.'),
  );
  await world.engine.settled(chat.conversationId);
  expect(world.adapter.shapeSessions).toHaveLength(sessions);
}

const stateOf = (world: ChatWorld, chat: ChatDto): ConversationState =>
  world.engine.view(chat.conversationId).state;

describe('archiving a chat', () => {
  it('from idle_cold', async () => {
    w = chatWorld();
    const chat = w.open();
    await archiveAndCheck(w, chat);
  });

  it('from idle_warm closes the warm handle and ends its session row', async () => {
    w = chatWorld();
    const chat = w.open();
    // A turn that can't write keeps its session warm; 10db's own git work keeps Your folder from it.
    w.folderHold.reserveGit(w.project.id, 'cutting a branch');
    w.chat.send(chat.conversationId, { text: 'Hello', ...say });
    await w.engine.settled(chat.conversationId);
    expect(stateOf(w, chat)).toBe('idle_warm');
    await archiveAndCheck(w, chat);
  });

  it('from starting cancels the start', async () => {
    w = chatWorld();
    const starting = gate();
    w.adapter.shapeStartGate = starting.promise;
    const chat = w.open();
    w.chat.send(chat.conversationId, { text: 'Hello', ...say });
    await waitFor(() => w.adapter.shapeSessions.length === 1);
    expect(stateOf(w, chat)).toBe('starting');
    const done = archiveAndCheck(w, chat);
    starting.release();
    await done;
  });

  it('from running stops the turn and keeps its partial text', async () => {
    w = chatWorld();
    const gates = gatedTurns(w);
    const chat = w.open();
    w.chat.send(chat.conversationId, { text: 'Hello', ...say });
    await waitFor(() => gates.length === 1);
    expect(stateOf(w, chat)).toBe('running');
    await archiveAndCheck(w, chat);
    const partial = listItems(w.state.db, chat.conversationId).find(
      (i) => i.kind === 'agent_message',
    );
    expect(partial).toMatchObject({ partial: true, body: { text: 'Half a sen' } });
  });

  it('from waiting_card withdraws the card, then stops', async () => {
    const o = observing();
    w = chatWorld({ prepare: o.prepare });
    const gates = gatedTurns(w);
    const chat = w.open();
    w.chat.send(chat.conversationId, { text: 'Hello', ...say });
    await waitFor(() => gates.length === 1);
    const card = w.state.write((ctx) =>
      insertInboxItem(ctx, {
        projectId: w.project.id,
        kind: 'permission',
        title: 'Remove “Old task”?',
        body: 'remove_task',
        options: [],
        recommendation: null,
        category: 'access',
        urgency: 'normal',
        detail: { conversationId: chat.conversationId },
        foldKey: null,
        targets: [],
      }),
    );
    o.observers[0]?.onWaitStart(card);
    expect(stateOf(w, chat)).toBe('waiting_card');
    await archiveAndCheck(w, chat);
    expect(getInboxItem(w.state.db, card.id).state).not.toBe('OPEN');
  });

  it('from stopping archives once the stop settles', async () => {
    w = chatWorld();
    const gates = gatedTurns(w);
    const stopping = gate();
    w.adapter.shapeStopGate = stopping.promise;
    const chat = w.open();
    w.chat.send(chat.conversationId, { text: 'Hello', ...say });
    await waitFor(() => gates.length === 1);
    w.adapter.shapeInterruptReceipt = () => {
      gates[0]?.release();
      return null;
    };
    await w.engine.stop(chat.conversationId);
    const done = archiveAndCheck(w, chat);
    stopping.release();
    await done;
  });

  it.each([
    { name: 'paused_account', reason: 'rate_limited' as const, state: 'paused_account' },
    { name: 'ended_error', reason: 'error' as const, state: 'ended_error' },
  ])('from $name', async ({ reason, state }) => {
    w = chatWorld();
    w.adapter.shapeBehaviour = () =>
      Promise.resolve({ end: { reason, message: `ended: ${reason}` } });
    const chat = w.open();
    w.chat.send(chat.conversationId, { text: 'Hello', ...say });
    await w.engine.settled(chat.conversationId);
    expect(stateOf(w, chat)).toBe(state);
    await archiveAndCheck(w, chat);
  });

  it('brings an archived chat back, and it takes messages again', async () => {
    w = chatWorld();
    const chat = w.open();
    await w.chat.archive(chat.id);
    w.chat.unarchive(chat.id);
    w.chat.send(chat.conversationId, { text: 'Back', ...say });
    await w.engine.settled(chat.conversationId);
    expect(w.adapter.shapeSessions).toHaveLength(1);
  });
});
