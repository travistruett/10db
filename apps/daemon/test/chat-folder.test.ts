import {
  ConversationItemKind,
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
afterEach(async () => {
  await w.close();
});

const say = (chat: ChatDto, text: string) =>
  w.chat.send(chat.conversationId, { text, mentions: [], pictures: [] });

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
