import {
  AccountKind,
  type ChatId,
  ConflictError,
  ConversationState,
  InvalidError,
  mintId,
  parseItemBody,
} from '@10db/contracts';
import { getConversation, listItems, patchConversation } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { chatWorld, type ChatWorld } from '../../test/chat-world';
import { gate } from '../../test/explore-world';
import { waitFor } from '../../test/fixtures';
import { BRIEF_KEEP_MS, BRIEF_WAIT_MS } from './briefs';
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

describe('the brief for Do It', () => {
  const say = (chatId: ChatId, text: string) => {
    const chat = w.chat.get(chatId);
    return w.chat.send(chat.conversationId, { text, mentions: [], pictures: [] });
  };
  const briefRequests = (conversationId: ReturnType<typeof w.open>['conversationId']) =>
    listItems(w.state.db, conversationId).filter(
      (i) => i.kind === 'message' && parseItemBody(i.kind, i.body).purpose === 'brief',
    );

  it('asks an idle chat with a reading-only turn that never holds the folder, and shows what the agent wrote', async () => {
    w = chatWorld();
    const chat = w.open();
    const held = gate();
    w.adapter.shapeBehaviour = async () => {
      await held.promise;
      return { text: 'Done.' };
    };
    w.chat.askBrief(chat.id, 'with tests');
    await waitFor(() => w.adapter.shapeSessions.length === 1);
    expect(briefRequests(chat.conversationId)).toHaveLength(1);
    expect(w.folderHold.holdsTurn(chat.id)).toBe(false);
    expect(w.chat.briefOf(chat.id)).toMatchObject({ writing: true, source: null });

    w.briefs.write(
      chat.id,
      { title: 'Fix login', brief: 'Do it.', areas: ['api'], acceptanceCriteria: ['It works'] },
      mintId('Session'),
    );

    expect(w.chat.briefOf(chat.id)).toEqual({
      title: 'Fix login',
      text: 'Do it.',
      areas: ['api'],
      criteria: ['It works'],
      source: 'agent',
      reason: null,
      writing: false,
    });
    held.release();
    await w.engine.settled(chat.conversationId);
  });

  it('falls back to the chat so far after 60 seconds, and drops a written brief after 30 minutes', async () => {
    w = chatWorld();
    const chat = w.open();
    const held = gate();
    w.adapter.shapeBehaviour = async () => {
      await held.promise;
      return { text: 'Done.' };
    };
    w.chat.askBrief(chat.id);
    await waitFor(() => w.adapter.shapeSessions.length === 1);
    w.clock.advance(BRIEF_WAIT_MS);
    const late = w.chat.briefOf(chat.id);
    expect(late).toMatchObject({ source: 'chat', reason: 'timeout', writing: false });
    expect(late.text).not.toMatch(/Change nothing/);
    held.release();
    await w.engine.settled(chat.conversationId);

    w.briefs.write(chat.id, { title: 'T', brief: 'B' }, mintId('Session'));
    w.clock.advance(BRIEF_KEEP_MS + 1);
    expect(w.chat.briefOf(chat.id).source).toBe('chat');
  });

  it('sends nothing while a turn runs: the chat so far is the brief at once and the turn goes on', async () => {
    w = chatWorld();
    const chat = w.open();
    const held = gate();
    w.adapter.shapeBehaviour = async () => {
      await held.promise;
      return { text: 'Done.' };
    };
    say(chat.id, 'Knock out the login bug');
    await waitFor(() => w.engine.view(chat.conversationId).state === 'running');

    w.chat.askBrief(chat.id);

    expect(briefRequests(chat.conversationId)).toEqual([]);
    expect(w.chat.briefOf(chat.id)).toMatchObject({ source: 'chat', reason: 'mid_turn' });
    expect(w.chat.briefOf(chat.id).text).toContain('Knock out the login bug');
    expect(w.engine.view(chat.conversationId).state).toBe('running');
    held.release();
    await w.engine.settled(chat.conversationId);
  });

  it('stops the brief turn on Cancel, and on a builder send, which then runs as its own turn', async () => {
    w = chatWorld();
    const chat = w.open();
    const held = gate();
    w.adapter.shapeBehaviour = async () => {
      await held.promise;
      return { text: 'Done.' };
    };
    w.chat.askBrief(chat.id);
    await waitFor(() => w.engine.view(chat.conversationId).state === 'running');
    await w.chat.cancelBrief(chat.id);
    await w.engine.settled(chat.conversationId);
    expect(w.briefs.asked(chat.id)).toBeNull();
    expect(w.engine.view(chat.conversationId).state).not.toBe('running');

    w.adapter.shapeBehaviour = async () => {
      await held.promise;
      return { text: 'Done.' };
    };
    w.chat.askBrief(chat.id);
    await waitFor(() => w.engine.view(chat.conversationId).state === 'running');
    const mine = say(chat.id, 'Actually, just the logout');
    held.release();
    expect(w.briefs.asked(chat.id)).toBeNull();
    await waitFor(
      () =>
        listItems(w.state.db, chat.conversationId).find((i) => i.id === mine.id)?.deliveredAt !==
        null,
    );
    await w.engine.settled(chat.conversationId);
  });
  it("runs a send during the brief turn as the builder's own turn, with the folder, after the agent wrote", async () => {
    w = chatWorld();
    const chat = w.open();
    const brief = gate();
    w.adapter.shapeBehaviour = async () => {
      await brief.promise;
      return { text: 'Done.' };
    };
    w.chat.askBrief(chat.id);
    await waitFor(() => w.engine.view(chat.conversationId).state === 'running');
    // The agent's write ends the request while its read-only turn goes on.
    w.briefs.write(chat.id, { title: 'T', brief: 'B' }, mintId('Session'));
    const mine = gate();
    w.adapter.shapeBehaviour = async () => {
      await mine.promise;
      return { text: 'Done.' };
    };

    say(chat.id, 'Just the logout');

    await waitFor(() => w.folderHold.holdsTurn(chat.id));
    expect(w.engine.view(chat.conversationId).state).toBe('running');
    brief.release();
    mine.release();
    await w.engine.settled(chat.conversationId);
  });

  it("Cancel stops only the brief's turn, never the builder's own", async () => {
    w = chatWorld();
    const chat = w.open();
    const brief = gate();
    w.adapter.shapeBehaviour = async () => {
      await brief.promise;
      return { text: 'Done.' };
    };
    w.chat.askBrief(chat.id);
    await waitFor(() => w.engine.view(chat.conversationId).state === 'running');
    brief.release();
    await w.engine.settled(chat.conversationId);
    const mine = gate();
    w.adapter.shapeBehaviour = async () => {
      await mine.promise;
      return { text: 'Done.' };
    };
    await w.chat.redo(chat.conversationId, { text: 'Mine', mentions: [], pictures: [] });
    await waitFor(() => w.engine.view(chat.conversationId).state === 'running');

    await w.chat.cancelBrief(chat.id);

    expect(w.engine.view(chat.conversationId).state).toBe('running');
    mine.release();
    await w.engine.settled(chat.conversationId);
  });
  it("is never asked of an archived chat, and never beside the builder's undelivered message", async () => {
    w = chatWorld();
    const archived = w.open(0);
    await w.chat.archive(archived.id);
    expect(() => {
      w.chat.askBrief(archived.id);
    }).toThrow(/archived/);
    expect(w.briefs.asked(archived.id)).toBeNull();

    const chat = w.open(1);
    const held = gate();
    w.adapter.shapeBehaviour = async () => {
      await held.promise;
      return { text: 'Done.' };
    };
    w.engine.holdStarts(chat.conversationId);
    say(chat.id, 'Fix the login');

    w.chat.askBrief(chat.id);

    expect(briefRequests(chat.conversationId)).toEqual([]);
    expect(w.chat.briefOf(chat.id)).toMatchObject({ source: 'chat', reason: 'mid_turn' });
    w.engine.releaseStarts(chat.conversationId);
    held.release();
    await w.engine.settled(chat.conversationId);
  });
});

describe('a chat whose Do It is under way', () => {
  const say = (chatId: ChatId, text: string, folder?: 'read_only') => {
    const chat = w.chat.get(chatId);
    return w.chat.send(chat.conversationId, { text, mentions: [], pictures: [] }, folder);
  };

  it('keeps its starts held when a send that stopped the brief turn finishes after the open stopped it', async () => {
    w = chatWorld();
    const chat = w.open();
    const held = gate();
    w.adapter.shapeBehaviour = async () => {
      await held.promise;
      return { text: 'Done.' };
    };
    w.chat.askBrief(chat.id);
    await waitFor(() => w.engine.view(chat.conversationId).state === 'running');
    say(chat.id, 'Just the logout');

    const release = await w.chat.stopForOpen(chat.id);

    // The send's own stop ends after the open's hold began; the hold is the open's to give back.
    await waitFor(() => w.engine.parked(chat.conversationId) || undefined);
    expect(w.engine.view(chat.conversationId).state).not.toBe('running');
    release();
    held.release();
    await w.engine.settled(chat.conversationId);
  });

  it("applies a send's Reading Only choice to the turn that follows the brief turn it stopped", async () => {
    w = chatWorld();
    const chat = w.open();
    const brief = gate();
    w.adapter.shapeBehaviour = async () => {
      await brief.promise;
      return { text: 'Done.' };
    };
    w.chat.askBrief(chat.id);
    await waitFor(() => w.engine.view(chat.conversationId).state === 'running');
    const mine = gate();
    w.adapter.shapeBehaviour = async () => {
      await mine.promise;
      return { text: 'Done.' };
    };

    say(chat.id, 'Just the logout', 'read_only');

    await waitFor(() => w.engine.view(chat.conversationId).state === 'running' || undefined);
    await waitFor(() => !w.engine.parked(chat.conversationId) || undefined);
    expect(w.folderHold.holdsTurn(chat.id)).toBe(false);
    brief.release();
    mine.release();
    await w.engine.settled(chat.conversationId);
  });

  it('refuses a request for a brief', async () => {
    w = chatWorld();
    const chat = w.open();
    const release = await w.chat.stopForOpen(chat.id);

    expect(() => {
      w.chat.askBrief(chat.id);
    }).toThrow(/pass is opening/);
    release();
  });

  it('refuses a message to a sealed chat, parking nothing in it', () => {
    w = chatWorld();
    const chat = w.open();
    w.state.write((ctx) => {
      patchConversation(ctx, chat.conversationId, { state: ConversationState.Sealed });
    });

    expect(() => say(chat.id, 'Anything')).toThrow(/work to a task/);
    expect(listItems(w.state.db, chat.conversationId).filter((i) => i.kind === 'message')).toEqual(
      [],
    );
  });
});
