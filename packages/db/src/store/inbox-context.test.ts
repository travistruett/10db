import { mintId, type InboxItemId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertConversation } from './conversations';
import { insertItem } from './conversation-items';
import { insertInboxItem } from './inbox';
import { inboxCardContext } from './inbox-context';
import type { Store } from './store';
import { insertTask } from './tasks';
import { createTestStore, seedProject } from './test-support';
import { insertWorkstream } from './workstreams';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

type Say = ['builder' | 'agent' | 'tool' | 'carry_on', string];

function world() {
  const project = seedProject(store);
  const task = store.write((ctx) =>
    insertTask(ctx, project.id, { title: 'T', acceptanceCriteria: ['x'], areas: ['ui'] }),
  ).value;
  const workstream = store.write((ctx) =>
    insertWorkstream(ctx, task.id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
  ).value;
  const conversation = (ownerKind: 'chat' | 'task', ownerId: string, said: readonly Say[]) =>
    store.write((ctx) => {
      const conv = insertConversation(ctx, {
        projectId: project.id,
        owner: { kind: ownerKind, id: ownerId },
        profile: 'lane',
        state: null,
      });
      for (const [who, text] of said) {
        if (who === 'builder')
          insertItem(ctx, conv.id, { author: 'builder', kind: 'message', body: { text } });
        else if (who === 'carry_on')
          insertItem(ctx, conv.id, {
            author: 'builder',
            kind: 'message',
            body: { text, purpose: 'carry_on' },
          });
        else if (who === 'agent')
          insertItem(ctx, conv.id, { author: 'agent', kind: 'agent_message', body: { text } });
        else
          insertItem(ctx, conv.id, {
            author: 'agent',
            kind: 'reasoning',
            body: { text },
          });
      }
      return conv;
    }).value;
  const card = (detail: Record<string, string> | null, lane: boolean): InboxItemId =>
    store.write((ctx) =>
      insertInboxItem(ctx, {
        projectId: project.id,
        kind: 'question',
        title: 'Q',
        body: 'b',
        options: [],
        recommendation: null,
        category: 'product',
        urgency: 'normal',
        detail,
        foldKey: null,
        targets: lane ? [{ workstreamId: workstream.id, sessionId: null }] : [],
      }),
    ).value.id;
  return { task, conversation, card };
}

const texts = (c: { messages: { author: string; text: string }[] }) =>
  c.messages.map((m) => `${m.author}:${m.text}`);

describe('inboxCardContext', () => {
  it('answers the last three messages of the card’s conversation, oldest first, and no tool or reasoning', () => {
    const w = world();
    const conv = w.conversation('chat', mintId('Chat'), [
      ['builder', 'one'],
      ['tool', 'thinking'],
      ['agent', 'two'],
      ['agent', 'three'],
      ['builder', 'four'],
      ['builder', 'five'],
    ]);
    const id = w.card({ conversationId: conv.id }, false);
    expect(texts(inboxCardContext(store.db, id, 3))).toEqual([
      'agent:three',
      'builder:four',
      'builder:five',
    ]);
  });

  it('leaves out the line 10db posted to resume a turn, before it counts the newest messages', () => {
    const w = world();
    const conv = w.conversation('chat', mintId('Chat'), [
      ['agent', 'asked'],
      ['builder', 'chose'],
      ['carry_on', 'Carry on'],
    ]);
    const id = w.card({ conversationId: conv.id }, false);
    expect(texts(inboxCardContext(store.db, id, 2))).toEqual(['agent:asked', 'builder:chose']);
  });

  it('finds a lane card’s thread through its workstream’s task', () => {
    const w = world();
    w.conversation('task', w.task.id, [['agent', 'hello']]);
    const id = w.card(null, true);
    expect(texts(inboxCardContext(store.db, id, 3))).toEqual(['agent:hello']);
  });

  it('answers none for a card with no conversation', () => {
    const w = world();
    const id = w.card(null, false);
    expect(inboxCardContext(store.db, id, 3)).toEqual({ messages: [] });
  });

  it.each([
    ['the task’s conversation when there is one', true, ['agent:task']],
    ['none when there is not', false, []],
  ])('falls back from a conversation id that names none to %s', (_n, hasTask, want) => {
    const w = world();
    if (hasTask) w.conversation('task', w.task.id, [['agent', 'task']]);
    const id = w.card({ conversationId: mintId('Conversation') }, true);
    expect(texts(inboxCardContext(store.db, id, 3))).toEqual(want);
  });

  it('answers one message for a conversation with one', () => {
    const w = world();
    const conv = w.conversation('chat', mintId('Chat'), [['builder', 'only']]);
    const id = w.card({ conversationId: conv.id }, false);
    expect(texts(inboxCardContext(store.db, id, 3))).toEqual(['builder:only']);
  });

  it('throws NotFoundError for an unknown card', () => {
    world();
    expect(() => inboxCardContext(store.db, mintId('InboxItem'), 3)).toThrow(/not found/i);
  });
});
