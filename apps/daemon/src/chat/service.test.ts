import { AccountKind, ConflictError, ConversationState, InvalidError } from '@10db/contracts';
import { getConversation, listItems, patchConversation } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { chatWorld, type ChatWorld } from '../../test/chat-world';
import { waitFor } from '../../test/fixtures';
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

  it('an effort picked mid-conversation applies from the next turn, and an effort-only change closes the warm session', async () => {
    w = chatWorld();
    const chat = w.open();
    const say = (text: string): void => {
      w.chat.send(chat.conversationId, { text, mentions: [], pictures: [] });
    };
    say('first');
    await w.engine.settled(chat.conversationId);
    expect(w.adapter.shapeSessions.map((s) => s.spec.effort)).toEqual(['high']);
    const patched = await w.chat.patch(chat.id, { effort: 'low' });
    expect(patched.conversation.effort).toBe('low');
    expect(getConversation(w.state.db, chat.conversationId).effort).toBe('low');
    say('second');
    await w.engine.settled(chat.conversationId);
    expect(w.adapter.shapeSessions.map((s) => s.spec.effort)).toEqual(['high', 'low']);
    // Back to the model's own default.
    expect((await w.chat.patch(chat.id, { effort: null })).conversation.effort).toBeNull();
  });

  it('a chat made with an effort starts its first turn on it', async () => {
    w = chatWorld();
    const chat = w.chat.create({
      projectId: w.project.id,
      model: null,
      effort: 'max',
      tabPosition: 0,
    });
    expect(chat.conversation.effort).toBe('max');
    w.chat.send(chat.conversationId, { text: 'go', mentions: [], pictures: [] });
    await w.engine.settled(chat.conversationId);
    expect(w.adapter.shapeSessions[0]?.spec.effort).toBe('max');
  });

  it('makes and runs a chat on a ChatGPT-plan project, as on a Claude one', async () => {
    w = chatWorld();
    w.launchOn(AccountKind.CodexSignin);
    expect(w.chat.models(w.project.id).offered).not.toEqual([]);
    const chat = w.open();
    w.chat.send(chat.conversationId, { text: 'Why does login fail?', mentions: [], pictures: [] });
    await w.engine.settled(chat.conversationId);
    const [session] = w.adapter.shapeSessions;
    expect(session?.spec).toMatchObject({
      profile: { kind: 'explore' },
      account: { kind: AccountKind.CodexSignin },
    });
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

describe('a chat view: background tasks', () => {
  it('lists what the open session runs in the background, and nothing once it is stopped', async () => {
    w = chatWorld({
      book: {
        'Chat: build it': [
          [
            { do: 'consume' },
            {
              do: 'background',
              tasks: [
                { description: 'npm run build', kind: 'local_bash' },
                { description: 'Find the failing test', kind: 'local_agent', agent: 'Explore' },
                { description: 'tail the server log', kind: 'monitor_mcp' },
                'tsc --watch',
              ],
            },
            { do: 'await_signal', name: 'finished' },
            { do: 'background', tasks: [] },
            { do: 'await_signal', name: 'hold' },
            { do: 'turn_complete' },
          ],
        ],
      },
    });
    const chat = w.open();
    expect(w.chat.get(chat.id).conversation.backgroundTasks).toEqual([]);
    w.chat.send(chat.conversationId, { text: 'build it', mentions: [], pictures: [] });
    await waitFor(() => w.chat.get(chat.id).conversation.backgroundTasks.length === 4);
    expect(
      w.chat.get(chat.id).conversation.backgroundTasks.map((t) => [t.kind, t.agent, t.description]),
    ).toEqual([
      ['shell', null, 'npm run build'],
      ['agent', 'Explore', 'Find the failing test'],
      ['monitor', null, 'tail the server log'],
      ['other', null, 'tsc --watch'],
    ]);
    expect(w.events.some((e) => e.type === 'conversation.state' && e.data['backgroundTasks'])).toBe(
      true,
    );
    // An empty report replaces the list, and the session stays open.
    w.adapter.signal('finished');
    await waitFor(() => w.chat.get(chat.id).conversation.backgroundTasks.length === 0);
    expect(w.adapter.shapeSessions).toHaveLength(1);
    w.adapter.signal('hold');
    await w.engine.retire(chat.conversationId);
    expect(w.chat.get(chat.id).conversation.backgroundTasks).toEqual([]);
  });
});
