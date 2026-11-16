import {
  ConversationItemKind,
  ConversationState,
  EventType,
  FolderWhileHeld,
  parseItemBody,
  WorkstreamState,
  type ChatDto,
} from '@10db/contracts';
import { insertTask, insertWorkstream, listItems, schema } from '@10db/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { chatWorld, type ChatWorld } from './chat-world';

// Sessions spec §7.3: a chat holds Your folder exactly while its turn runs, takes it only when nothing of
// 10db's holds it, and says so in its thread, on a real store, the explore engine and the fake adapter.

let w: ChatWorld;
/** The world a restarted one runs over: it owns the store. */
let previous: ChatWorld | undefined;
afterEach(async () => {
  await w.close();
  await previous?.close();
  previous = undefined;
});

const say = (chat: ChatDto, text: string) =>
  w.chat.send(chat.conversationId, { text, mentions: [], pictures: [] });

const sayWith = (chat: ChatDto, text: string, folder: FolderWhileHeld) =>
  w.chat.send(chat.conversationId, { text, mentions: [], pictures: [] }, folder);

const notices = (chat: ChatDto): string[] =>
  listItems(w.state.db, chat.conversationId, {})
    .filter((i) => i.kind === ConversationItemKind.Notice)
    .map((i) => parseItemBody(i.kind, i.body))
    .flatMap((b) => ('text' in b && typeof b.text === 'string' ? [b.text] : []));

/** A task of the project running in Your folder, as the scheduler leaves it once it started. */
function runningTask(title: string): void {
  w.state.write((ctx) => {
    const task = insertTask(ctx, w.project.id, {
      title,
      acceptanceCriteria: ['x'],
      areas: ['api'],
    });
    const ws = insertWorkstream(ctx, task.id, {
      first: { model: 'claude-sonnet-5-5', effort: 'medium' },
    });
    ctx.tx
      .update(schema.workstreams)
      .set({ state: WorkstreamState.Running, workspaceMode: 'shared' })
      .where(eq(schema.workstreams.id, ws.id))
      .run();
  });
}

describe('a chat’s turn and Your folder', () => {
  it('holds the folder while the turn runs and gives it back when it ends', async () => {
    w = chatWorld();
    const chat = w.open();
    say(chat, 'fix it');
    expect(w.folderHold.holdsTurn(chat.id)).toBe(true);
    await w.engine.settled(chat.conversationId);
    expect(w.folderHold.holdsTurn(chat.id)).toBe(false);
    expect(notices(chat)).toEqual([]);
    expect(w.folderHold.holders(w.project.id)).toEqual([]);
  });

  it('keeps the hold through a chained turn and takes it once', async () => {
    w = chatWorld();
    const chat = w.open();
    let release: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      w.adapter.shapeBehaviour = async () => {
        resolve();
        await new Promise<void>((r) => {
          release = r;
        });
        w.adapter.shapeBehaviour = () => Promise.resolve({ text: 'Done.' });
        return { text: 'Understood.' };
      };
    });
    say(chat, 'one');
    await started;
    say(chat, 'two');
    expect(w.folderHold.holdsTurn(chat.id)).toBe(true);
    release();
    await w.engine.settled(chat.conversationId);
    expect(w.folderHold.holdsTurn(chat.id)).toBe(false);
  });

  it('runs read-only behind a task, with a notice naming it, and still gives nothing back later', async () => {
    w = chatWorld();
    runningTask('Bump vite');
    const chat = w.open();
    say(chat, 'look at it');
    await w.engine.settled(chat.conversationId);
    expect(notices(chat)).toEqual([
      'Your folder is in use by the task ‘Bump vite’, so this turn reads only.',
    ]);
    expect(w.folderHold.holdsTurn(chat.id)).toBe(false);
  });

  it('shares with another chat, and each knows', async () => {
    w = chatWorld();
    const first = w.open(0);
    const second = w.open(1);
    let release: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      w.adapter.shapeBehaviour = async () => {
        resolve();
        await new Promise<void>((r) => {
          release = r;
        });
        w.adapter.shapeBehaviour = () => Promise.resolve({ text: 'Done.' });
        return { text: 'Understood.' };
      };
    });
    say(first, 'one');
    await started;
    say(second, 'two');
    expect(w.folderHold.holdsTurn(second.id)).toBe(true);
    release();
    await w.engine.settled(first.conversationId);
    await w.engine.settled(second.conversationId);
    expect(notices(second)).toEqual(['Your folder is also in use by the chat ‘one’.']);
    expect(w.folderHold.holders(w.project.id)).toEqual([]);
  });
});

/** The task ends and says so, as the runner's transition does. */
function laneEnds(): void {
  w.state.write((ctx) => {
    ctx.tx
      .update(schema.workstreams)
      .set({ state: WorkstreamState.Failed })
      .where(eq(schema.workstreams.state, WorkstreamState.Running))
      .run();
    ctx.emit({
      type: EventType.WorkstreamChanged,
      entityType: 'workstream',
      entityId: 'wst_x',
      data: {},
    });
  });
}

const stateOf = (chat: ChatDto) => w.engine.view(chat.conversationId).state;

describe('a message that waits for Your folder', () => {
  it('parks while a task holds, blocks other starts, and runs holding once the task ends', async () => {
    w = chatWorld();
    runningTask('Bump vite');
    const chat = w.open();
    sayWith(chat, 'edit it', FolderWhileHeld.Wait);
    expect(stateOf(chat)).toBe(ConversationState.IdleCold);
    expect(w.folderHold.waiting(chat.id)).toBe(true);
    laneEnds();
    await w.engine.settled(chat.conversationId);
    expect(w.folderHold.waiting(chat.id)).toBe(false);
    expect(notices(chat)).toEqual([]);
    expect(w.folderHold.holders(w.project.id)).toEqual([]);
    expect(listItems(w.state.db, chat.conversationId, {}).length).toBeGreaterThan(1);
  });

  it('sends at once when nothing holds the folder', async () => {
    w = chatWorld();
    const chat = w.open();
    sayWith(chat, 'edit it', FolderWhileHeld.Wait);
    expect(w.folderHold.waiting(chat.id)).toBe(false);
    expect(w.folderHold.holdsTurn(chat.id)).toBe(true);
    await w.engine.settled(chat.conversationId);
  });

  it('lets another message join the queue, and the latest send’s choice applies to all of it', async () => {
    w = chatWorld();
    runningTask('Bump vite');
    const chat = w.open();
    sayWith(chat, 'one', FolderWhileHeld.Wait);
    sayWith(chat, 'two', FolderWhileHeld.Wait);
    expect(w.folderHold.waiting(chat.id)).toBe(true);
    sayWith(chat, 'three', FolderWhileHeld.ReadOnly);
    expect(w.folderHold.waiting(chat.id)).toBe(false);
    await w.engine.settled(chat.conversationId);
    expect(notices(chat)).toEqual([
      'Your folder is in use by the task ‘Bump vite’, so this turn reads only.',
    ]);
  });

  it('runs reading only under Send Now', async () => {
    w = chatWorld();
    runningTask('Bump vite');
    const chat = w.open();
    sayWith(chat, 'look', FolderWhileHeld.Wait);
    w.chat.sendNow(chat.conversationId);
    await w.engine.settled(chat.conversationId);
    expect(w.folderHold.waiting(chat.id)).toBe(false);
    expect(notices(chat)).toHaveLength(1);
  });

  it('is dropped by Stop, and nothing starts when the task ends', async () => {
    w = chatWorld();
    runningTask('Bump vite');
    const chat = w.open();
    sayWith(chat, 'edit it', FolderWhileHeld.Wait);
    await w.chat.stop(chat.conversationId);
    expect(w.folderHold.waiting(chat.id)).toBe(false);
    laneEnds();
    await w.engine.settled(chat.conversationId);
    expect(stateOf(chat)).toBe(ConversationState.IdleCold);
    expect(w.folderHold.holders(w.project.id)).toEqual([]);
    // The chat takes the next message as any other.
    say(chat, 'again');
    await w.engine.settled(chat.conversationId);
    expect(stateOf(chat)).toBe(ConversationState.IdleCold);
  });

  it('is replaced by Redo, which carries its own choice', async () => {
    w = chatWorld();
    runningTask('Bump vite');
    const chat = w.open();
    sayWith(chat, 'edit it', FolderWhileHeld.Wait);
    await w.chat.redo(
      chat.conversationId,
      { text: 'look instead', mentions: [], pictures: [] },
      FolderWhileHeld.ReadOnly,
    );
    await w.engine.settled(chat.conversationId);
    expect(w.folderHold.waiting(chat.id)).toBe(false);
    expect(notices(chat)).toHaveLength(1);
  });

  it('keeps waiting through a model change', async () => {
    w = chatWorld();
    runningTask('Bump vite');
    const chat = w.open();
    sayWith(chat, 'edit it', FolderWhileHeld.Wait);
    await w.chat.patch(chat.id, { model: 'claude-sonnet-5-5' });
    expect(w.folderHold.waiting(chat.id)).toBe(true);
    laneEnds();
    await w.engine.settled(chat.conversationId);
    expect(w.folderHold.waiting(chat.id)).toBe(false);
    expect(notices(chat)).toEqual([]);
  });

  it('is cancelled by archive, with its reservation, so the folder goes to nobody', async () => {
    w = chatWorld();
    runningTask('Bump vite');
    const chat = w.open();
    sayWith(chat, 'edit it', FolderWhileHeld.Wait);
    await w.chat.archive(chat.id);
    expect(w.folderHold.waiting(chat.id)).toBe(false);
    laneEnds();
    expect(w.folderHold.holders(w.project.id)).toEqual([]);
    expect(stateOf(chat)).not.toBe(ConversationState.Running);
  });

  it('is gone after a restart, and the message waits under Send Now', async () => {
    w = chatWorld();
    runningTask('Bump vite');
    const chat = w.open();
    sayWith(chat, 'edit it', FolderWhileHeld.Wait);
    previous = w;
    await previous.engine.close();
    w = chatWorld({ over: previous });
    await w.engine.recover();
    expect(w.folderHold.waiting(chat.id)).toBe(false);
    expect(w.engine.view(chat.conversationId).sendNow).toBe(true);
    laneEnds();
    expect(stateOf(chat)).toBe(ConversationState.IdleCold);
    w.chat.sendNow(chat.conversationId);
    await w.engine.settled(chat.conversationId);
  });
});
