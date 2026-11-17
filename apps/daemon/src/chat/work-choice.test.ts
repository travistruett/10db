import { join } from 'node:path';
import { ConversationItemKind, parseItemBody, type ChatWork } from '@10db/contracts';
import { getChat, listInbox, listItems } from '@10db/db';
import { defineWebSocketHelper } from 'hono/ws';
import { afterEach, describe, expect, it } from 'vitest';
import { stubServices } from '../../test/api-stub';
import { chatWorld, type ChatWorld } from '../../test/chat-world';
import { tempDir, waitFor, type TempDir } from '../../test/fixtures';
import { createApp } from '../api';
import { createChatApiServices } from '../daemon';
import { createPendingOpens } from '../pass';
import { silentLogger } from '../log';

// Where a session works, chosen: the bar's route and the card's answer on a real store, the engine and the
// fake adapter. Rows are those of the state and event table in the sessions plan.

const TOKEN = 'ui-token-for-tests';

let w: ChatWorld;
let repo: TempDir;
afterEach(async () => {
  await w.close();
  repo.cleanup();
});

function world(opts: Parameters<typeof chatWorld>[0] = {}): ChatWorld {
  repo = tempDir('work-repo');
  w = chatWorld({ checkout: repo.path, ...opts });
  return w;
}

function appOf(world: ChatWorld) {
  return createApp({
    startedAt: new Date(),
    allowedOrigins: [],
    token: TOKEN,
    onUnexpectedError: () => undefined,
    services: stubServices({
      ...createChatApiServices({
        state: world.state,
        chat: world.chat,
        work: world.work,
        takeover: world.takeover,
        folderHold: world.folderHold,
        pendingOpens: createPendingOpens({ state: world.state }),
        doItPreview: () => Promise.reject(new Error('not read here')),
        doIt: () => Promise.reject(new Error('not done here')),
        git: () => Promise.reject(new Error('not a repository')),
        now: () => new Date(),
        log: silentLogger,
      }),
    }),
    upgradeWebSocket: defineWebSocketHelper(() => new Response(null, { status: 426 })),
    mcp: () => Promise.resolve(new Response('mcp')),
  });
}

const choose = async (place: string, chatId: string) =>
  await appOf(w).request(`/chats/${chatId}/work`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ place }),
  });

const edit = () => ({
  toolName: 'Write',
  input: { file_path: join(repo.path, 'a.ts'), content: 'x' },
});

const cards = () =>
  listInbox(w.state.db, { states: ['OPEN'] }).filter((c) => c.detail?.['chatWork'] !== undefined);

/**
 * A session whose first turn changes a file, so it is choosing; the turn is stopped by that.
 */
async function choosing() {
  const chat = w.open();
  w.adapter.shapeBehaviour = async (turn) => {
    turn.spec.preToolUse(edit());
    await new Promise<void>((resolve) => {
      turn.signal.addEventListener('abort', () => {
        resolve();
      });
    });
    return { text: 'Stopped.' };
  };
  w.chat.send(chat.conversationId, { text: 'fix login', mentions: [], pictures: [] });
  await waitFor(() => getChat(w.state.db, chat.id).workPlace === 'choosing');
  await w.engine.settled(chat.conversationId);
  // Later turns answer at once unless a test scripts them.
  w.adapter.shapeBehaviour = () => Promise.resolve({ text: 'Done.' });
  return { chat };
}

/** The carry-on turn's session, once it has run: what its edit was answered while its turn held the checkout. */
function carryOnTurn(chat: ChatWorld['open'] extends () => infer C ? C : never) {
  let answer: unknown;
  let held = false;
  w.adapter.shapeBehaviour = (turn) => {
    answer = turn.spec.preToolUse(edit());
    held = w.folderHold.holdsTurn(chat.id);
    return Promise.resolve({ text: 'Done.' });
  };
  return {
    done: async () => {
      await waitFor(() => answer !== undefined);
      await w.engine.settled(chat.conversationId);
      return { answer, held };
    },
  };
}

const carryOns = (conversationId: Parameters<typeof listItems>[1]) =>
  listItems(w.state.db, conversationId, {}).filter(
    (i) =>
      i.kind === ConversationItemKind.Message &&
      parseItemBody(i.kind, i.body).purpose === 'carry_on',
  );

describe('choosing Here', () => {
  it('carries on in the checkout holding it, and withdraws the card (rows 9, 17)', async () => {
    world();
    const { chat } = await choosing();
    // A model or effort change while choosing changes nothing (row 17).
    await w.chat.patch(chat.id, { effort: 'low' });
    expect(getChat(w.state.db, chat.id).workPlace).toBe('choosing');
    const next = carryOnTurn(chat);
    const res = await choose('here', chat.id);
    expect(res.status).toBe(200);
    expect((await res.json()) as ChatWork).toMatchObject({ place: 'here' });
    const turn = await next.done();
    expect(turn.answer).toEqual({ decision: 'allow' });
    expect(turn.held).toBe(true);
    expect(cards()).toEqual([]);
    expect(carryOns(chat.conversationId)).toHaveLength(1);
  });

  it('stops a turn that is running, then carries on (row 10)', async () => {
    world();
    const { chat } = await choosing();
    // A reading turn the builder began after the question, still running when they choose.
    let running: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      running = resolve;
    });
    let interrupted = false;
    w.adapter.shapeBehaviour = async (turn) => {
      running();
      await new Promise<void>((resolve) => {
        turn.signal.addEventListener('abort', () => {
          interrupted = true;
          resolve();
        });
      });
      return { text: 'Stopped.' };
    };
    w.chat.send(chat.conversationId, { text: 'and the tests?', mentions: [], pictures: [] });
    await started;
    const next = carryOnTurn(chat);
    const res = await choose('here', chat.id);
    expect(res.status).toBe(200);
    expect(interrupted).toBe(true);
    expect(getChat(w.state.db, chat.id).workPlace).toBe('here');
    expect(cards()).toEqual([]);
    expect((await next.done()).held).toBe(true);
  });

  it('keeps a message sent while choosing reading, with the bar still up (row 13)', async () => {
    world();
    const { chat } = await choosing();
    let held: boolean | null = null;
    w.adapter.shapeBehaviour = () => {
      held = w.folderHold.holdsTurn(chat.id);
      return Promise.resolve({ text: 'Looking.' });
    };
    w.chat.send(chat.conversationId, { text: 'what about tests?', mentions: [], pictures: [] });
    await w.engine.settled(chat.conversationId);
    expect(held).toBe(false);
    expect(getChat(w.state.db, chat.id).workPlace).toBe('choosing');
    expect(cards()).toHaveLength(1);
  });

  it("waits behind a Board task's hold, then holds the checkout (row 39)", async () => {
    world();
    const { chat } = await choosing();
    const lane = w.folderHold.reserveGit(w.project.id, 'a lane is changing main');
    if (!lane.reserved) throw new Error('the checkout was not free');
    const next = carryOnTurn(chat);
    expect((await choose('here', chat.id)).status).toBe(200);
    expect(w.chat.waiting(chat.conversationId)).toBe(true);
    expect(w.adapter.shapeSessions).toHaveLength(1);
    w.folderHold.releaseGit(lane.token);
    const turn = await next.done();
    expect(turn.held).toBe(true);
  });

  it('lets two Here sessions share the checkout (row 40)', async () => {
    world();
    const { chat } = await choosing();
    const other = w.open(1);
    w.here(other.id);
    const reserved = w.folderHold.takeTurn(w.project.id, other.id);
    expect(reserved.taken).toBe(true);
    const next = carryOnTurn(chat);
    expect((await choose('here', chat.id)).status).toBe(200);
    const turn = await next.done();
    expect(turn.held).toBe(true);
    expect(turn.answer).toEqual({ decision: 'allow' });
  });
});

describe('one choice wins, from the bar or the card', () => {
  it('answers a repeat of the settled choice, and a different one with the settled state (row 12)', async () => {
    world();
    const { chat } = await choosing();
    expect((await choose('here', chat.id)).status).toBe(200);
    expect((await choose('here', chat.id)).status).toBe(200);
    const other = await choose('branch', chat.id);
    expect(other.status).toBe(409);
    expect((await other.json()) as ChatWork).toMatchObject({ place: 'here' });
    expect(carryOns(chat.conversationId)).toHaveLength(1);
  });

  it('refuses a choice from a session that has not asked', async () => {
    world();
    const chat = w.open();
    expect((await choose('here', chat.id)).status).toBe(409);
    expect(getChat(w.state.db, chat.id).workPlace).toBeNull();
  });

  it('applies the card answer by the option position', async () => {
    world();
    const { chat } = await choosing();
    const card = cards()[0];
    if (card === undefined) throw new Error('no card');
    w.inbox.answer(card.id, { choice: card.options[0]?.label ?? '' });
    await waitFor(() => getChat(w.state.db, chat.id).workPlace === 'here');
    await w.engine.settled(chat.conversationId);
    expect(cards()).toEqual([]);
    expect(carryOns(chat.conversationId)).toHaveLength(1);
  });

  it('ignores a card answer that lost to the bar, and a card the bar withdrew', async () => {
    world();
    const { chat } = await choosing();
    const card = cards()[0];
    if (card === undefined) throw new Error('no card');
    expect((await choose('here', chat.id)).status).toBe(200);
    expect(() => w.inbox.answer(card.id, { choice: card.options[0]?.label ?? '' })).toThrow();
    await w.engine.settled(chat.conversationId);
    expect(getChat(w.state.db, chat.id).workPlace).toBe('here');
    expect(carryOns(chat.conversationId)).toHaveLength(1);
  });

  it('applies exactly one of a bar choice and a card answer made together', async () => {
    world();
    const { chat } = await choosing();
    const card = cards()[0];
    if (card === undefined) throw new Error('no card');
    const bar = choose('here', chat.id);
    try {
      w.inbox.answer(card.id, { choice: card.options[0]?.label ?? '' });
    } catch {
      // The bar's write may have withdrawn the card first.
    }
    expect((await bar).status).toBe(200);
    await w.engine.settled(chat.conversationId);
    expect(getChat(w.state.db, chat.id).workPlace).toBe('here');
    expect(carryOns(chat.conversationId)).toHaveLength(1);
  });
});
