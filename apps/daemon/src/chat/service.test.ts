import {
  AccountKind,
  CHATS_UNAVAILABLE_ON_CHATGPT,
  ConflictError,
  ConversationState,
  InvalidError,
} from '@10db/contracts';
import { getConversation, listItems, patchConversation } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { chatWorld, type ChatWorld } from '../../test/chat-world';
import { firstMessageTitle } from './service';

// Sessions spec §7.1, §10: a chat's life on the daemon, on a real store and the explore engine.

let w: ChatWorld;
afterEach(async () => {
  await w.close();
});

describe('the chat service', () => {
  it("makes a conversation the chat owns, on the project's account", () => {
    w = chatWorld();
    const chat = w.open();
    const conv = getConversation(w.state.db, chat.conversationId);
    expect(conv).toMatchObject({
      ownerKind: 'chat',
      ownerId: chat.id,
      profile: 'explore',
      accountId: w.project.accountId,
    });
    expect(chat).toMatchObject({ title: 'New session', tabPosition: 0, lastActivityAt: null });
    expect(chat.conversation.owner).toEqual({ kind: 'chat', id: chat.id });
  });

  it('refuses a model change while a turn runs, and one the account does not offer', async () => {
    w = chatWorld();
    const chat = w.open();
    w.state.write((ctx) => {
      patchConversation(ctx, chat.conversationId, { state: ConversationState.Running });
    });
    await expect(w.chat.patch(chat.id, { model: 'claude-sonnet-5-5' })).rejects.toThrow(
      new ConflictError('Change the model between turns.'),
    );
    w.state.write((ctx) => {
      patchConversation(ctx, chat.conversationId, { state: ConversationState.IdleCold });
    });
    await expect(w.chat.patch(chat.id, { model: 'gpt-9' })).rejects.toThrow(
      new InvalidError('Not available on this account'),
    );
  });

  it('says a ChatGPT-plan project runs no chat yet, and creates none there', () => {
    w = chatWorld();
    w.launchOn(AccountKind.CodexSignin);
    expect(w.chat.models(w.project.id)).toEqual({
      default: null,
      offered: [],
      unavailable: CHATS_UNAVAILABLE_ON_CHATGPT,
    });
    expect(() => w.open()).toThrow(new ConflictError(CHATS_UNAVAILABLE_ON_CHATGPT));
  });

  it('stores a message queued with its mentions, titles the chat from it, and starts a turn', async () => {
    w = chatWorld();
    const chat = w.open();
    w.chat.send(chat.conversationId, {
      text: 'Why does login fail after sleep?\nIt happens on resume.',
      mentions: ['src/login.ts'],
      pictures: [],
    });
    const [message] = listItems(w.state.db, chat.conversationId);
    expect(message?.body).toEqual({
      text: 'Why does login fail after sleep?\nIt happens on resume.',
      mentions: ['src/login.ts'],
    });
    await w.engine.settled(chat.conversationId);
    expect(w.adapter.shapeSessions).toHaveLength(1);
    const after = w.chat.get(chat.id);
    expect(after.title).toBe('Why does login fail after sleep?');
    expect(after.lastActivityAt).not.toBeNull();
    expect(after.lastReplyAt).not.toBeNull();
  });

  it.each([
    { text: 'Fix it.', title: 'Fix it' },
    { text: '', title: 'New session' },
    {
      text: 'Retry login once on a 401 after the token refresh fails',
      title: 'Retry login once on a 401 after the',
    },
  ])('titles "$text" as "$title"', ({ text, title }) => {
    expect(firstMessageTitle(text)).toBe(title);
  });
});
