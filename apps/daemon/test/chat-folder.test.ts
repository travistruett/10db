import { ConversationItemKind, parseItemBody, ChatId, type ChatDto } from '@10db/contracts';
import { listItems, setChatWork } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { chatWorld, type ChatWorld } from './chat-world';

// Sessions spec §7.3: a chat holds Your folder exactly while its turn runs, takes it only when nothing of
// 10db's holds it, and says so in its thread, on a real store, the explore engine and the fake adapter.

let w: ChatWorld;
afterEach(async () => {
  await w.close();
});

/** A session working in the checkout: only such a session takes the folder for its turn. */
function openHere(tabPosition?: number): ChatDto {
  const chat = w.open(tabPosition);
  w.state.write((ctx) => setChatWork(ctx, ChatId.parse(chat.id), null, { place: 'here' }));
  return chat;
}

const say = (chat: ChatDto, text: string) =>
  w.chat.send(chat.conversationId, { text, mentions: [], pictures: [] });

const notices = (chat: ChatDto): string[] =>
  listItems(w.state.db, chat.conversationId, {})
    .filter((i) => i.kind === ConversationItemKind.Notice)
    .map((i) => parseItemBody(i.kind, i.body))
    .flatMap((b) => ('text' in b && typeof b.text === 'string' ? [b.text] : []));

describe('a chat’s turn and Your folder', () => {
  it('holds the folder while the turn runs and gives it back when it ends', async () => {
    w = chatWorld();
    const chat = openHere();
    say(chat, 'fix it');
    expect(w.folderHold.holdsTurn(chat.id)).toBe(true);
    await w.engine.settled(chat.conversationId);
    expect(w.folderHold.holdsTurn(chat.id)).toBe(false);
    expect(notices(chat)).toEqual([]);
    expect(w.folderHold.holders(w.project.id)).toEqual([]);
  });

  it('keeps the hold through a chained turn and takes it once', async () => {
    w = chatWorld();
    const chat = openHere();
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
});
