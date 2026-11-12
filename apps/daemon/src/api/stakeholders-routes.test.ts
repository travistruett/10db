import { SlackConnectionDto, type PersonDto } from '@10db/contracts';
import {
  createTestStore,
  getInboxItem,
  insertInboxItem,
  insertPerson,
  listPeople,
  listRoutingRules,
  setRoutingRules,
  sendForCard,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stubServices } from '../../test/api-stub';
import { FakeSlack } from '../../test/fake-slack';
import { createMemoryKeychain, seedWorkstream } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { createStakeholderApiServices } from '../daemon';
import { SLACK_BOT_ACCOUNT } from '../environment';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createInboxService, type InboxService } from '../inbox';
import { silentLogger } from '../log';
import {
  createSlackConnection,
  createStakeholderSends,
  draftContext,
  draftFor,
} from '../stakeholders';
import { defineWebSocketHelper } from 'hono/ws';
import { createApp } from './app';

const TOKEN = 'ui-token';
let store: Store;
let close: () => void;
let state: StateStore;
let clock: ManualClock;
let slack: FakeSlack;
let inbox: InboxService;
let keychain: ReturnType<typeof createMemoryKeychain>;
let tokenReply: Record<string, unknown>;
let reconnected: number;
let request: (path: string, init?: { method?: string; body?: unknown }) => Promise<Response>;

beforeEach(() => {
  clock = new ManualClock();
  ({ store, close } = createTestStore(() => clock.now()));
  state = createStateStore(store, createEventBus());
  slack = new FakeSlack();
  keychain = createMemoryKeychain();
  reconnected = 0;
  tokenReply = { ok: true, team_id: 'T1', team: 'Team', user_id: 'UBOT' };
  inbox = createInboxService({ state, onParkedAnswer: () => undefined });
  const sends = createStakeholderSends({ state, slack, clock, log: silentLogger });
  const connection = createSlackConnection({ state, initial: 'connected' });
  const stakeholders = createStakeholderApiServices({
    state,
    keychain,
    slack,
    sends,
    connection,
    clock,
    fetch: () => Promise.resolve(new Response(JSON.stringify(tokenReply))),
    reconnect: () => {
      reconnected += 1;
      return Promise.resolve();
    },
  });
  const app = createApp({
    onUnexpectedError: () => undefined,
    startedAt: new Date(),
    allowedOrigins: [],
    token: TOKEN,
    services: stubServices({
      ...stakeholders,
      answerInbox: (id, answer) => inbox.answer(id, answer),
      listInbox: () => [],
      listPeople: () => listPeople(store.db),
      createPerson: (input) => state.write((ctx) => insertPerson(ctx, input)),
      listRoutingRules: (projectId) => listRoutingRules(store.db, projectId),
      setRoutingRules: (projectId, input) =>
        state.write((ctx) => setRoutingRules(ctx, projectId, input)),
    }),
    upgradeWebSocket: defineWebSocketHelper(() => new Response(null, { status: 426 })),
    mcp: () => Promise.resolve(new Response('mcp')),
    builderMcp: () => Promise.resolve(new Response('builder')),
  });
  request = (path, init = {}) =>
    Promise.resolve(
      app.request(path, {
        method: init.method ?? 'GET',
        headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    );
});
afterEach(() => {
  close();
});

const contact = (userId: string) => ({
  teamId: 'T1',
  userId,
  sendMode: 'review' as const,
  dailyLimit: 10,
});

/** A routed question to Mark with its draft, written as the daemon writes them. */
function drafted(over: { title?: string } = {}) {
  const ws = seedWorkstream(store);
  store.write((ctx) => insertPerson(ctx, { handle: 'me', name: 'Travis', isBuilder: true }));
  const mark: PersonDto = store.write((ctx) =>
    insertPerson(ctx, { handle: 'mark', name: 'Mark', slack: contact('U-mark') }),
  ).value;
  const card = store.write((ctx) => {
    const item = insertInboxItem(ctx, {
      projectId: ws.project.id,
      kind: 'question',
      title: over.title ?? 'Charge tax?',
      body: '',
      options: [
        { label: 'Yes', description: '' },
        { label: 'No', description: '' },
      ],
      recommendation: null,
      category: 'product',
      urgency: 'normal',
      detail: null,
      foldKey: null,
      targets: [{ workstreamId: ws.workstream.id, sessionId: null }],
    });
    store.db.$client
      .prepare("UPDATE inbox_items SET assignee = 'mark', assignees = '[\"mark\"]' WHERE id = ?")
      .run(item.id);
    draftFor(ctx, getInboxItem(ctx.tx, item.id), {
      ...draftContext(ctx.tx, item),
      afterDraft: () => undefined,
      log: silentLogger,
    });
    return item.id;
  }).value;
  return { ws, mark, card: card };
}

describe('the Slack connection routes', () => {
  it('serves the connection', async () => {
    const res = await request('/slack');
    expect(res.status).toBe(200);
    expect(SlackConnectionDto.parse(await res.json()).state).toBe('connected');
  });

  it('answers 400 for a refused token, in words, and stores nothing', async () => {
    tokenReply = { ok: false, error: 'invalid_auth' };
    const res = await request('/slack/token', {
      method: 'PUT',
      body: { token: 'the-bad-bot-token' },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('does not accept');
    expect(keychain.read(SLACK_BOT_ACCOUNT)).toBeNull();
    expect(reconnected).toBe(0);
  });

  it('saves an accepted token, reconnects, and removes it again', async () => {
    const put = await request('/slack/token', {
      method: 'PUT',
      body: { token: 'the-good-bot-token' },
    });
    expect(put.status).toBe(200);
    expect(SlackConnectionDto.parse(await put.json())).toMatchObject({
      state: 'connected',
      teamName: 'Team',
      botUserId: 'UBOT',
    });
    expect(keychain.read(SLACK_BOT_ACCOUNT)).toBe('the-good-bot-token');
    expect(reconnected).toBe(1);
    const del = await request('/slack/token', { method: 'DELETE' });
    expect(SlackConnectionDto.parse(await del.json()).state).toBe('none');
    expect(keychain.read(SLACK_BOT_ACCOUNT)).toBeNull();
  });

  it('refuses a token with spaces', async () => {
    const res = await request('/slack/token', { method: 'PUT', body: { token: 'a b' } });
    expect(res.status).toBe(400);
  });

  it('serves the workspace members, filtered by the query', async () => {
    const page = [
      {
        userId: 'U1',
        teamId: 'T1',
        name: 'mark',
        realName: 'Mark Ellis',
        title: null,
        email: null,
        avatarUrl: null,
      },
      {
        userId: 'U2',
        teamId: 'T1',
        name: 'ana',
        realName: 'Ana Ortiz',
        title: null,
        email: null,
        avatarUrl: null,
      },
    ];
    slack.listMembers = () => Promise.resolve({ members: page, nextCursor: null });
    const res = await request('/slack/members?query=ortiz');
    expect(((await res.json()) as { userId: string }[]).map((m) => m.userId)).toEqual(['U2']);
  });
});

describe('people, timers, routes', () => {
  it('creates, updates and removes a person, and refuses removing the builder', async () => {
    const created = await request('/people', {
      method: 'POST',
      body: { handle: 'sarah', name: 'Sarah', slack: { teamId: 'T1', userId: 'U5' } },
    });
    expect(created.status).toBe(201);
    const person = (await created.json()) as PersonDto;
    expect(person.slack).toMatchObject({ userId: 'U5', sendMode: 'review', dailyLimit: 10 });
    const updated = await request(`/people/${person.id}`, {
      method: 'PUT',
      body: { handle: 'sarah', name: 'Sarah K', slack: null },
    });
    expect(((await updated.json()) as PersonDto).slack).toBeNull();
    expect((await request(`/people/${person.id}`, { method: 'DELETE' })).status).toBe(200);
    const me = store.write((ctx) =>
      insertPerson(ctx, { handle: 'me', name: 'You', isBuilder: true }),
    ).value;
    expect((await request(`/people/${me.id}`, { method: 'DELETE' })).status).toBe(409);
  });

  it('serves the timers, refuses 0 hours or a reminder at the return, and stores 6', async () => {
    expect(await (await request('/stakeholders/timers')).json()).toEqual({
      remindAfterHours: 4,
      returnAfterHours: 8,
    });
    for (const body of [
      { remindAfterHours: 0, returnAfterHours: 8 },
      { remindAfterHours: 8, returnAfterHours: 8 },
    ])
      expect((await request('/stakeholders/timers', { method: 'PUT', body })).status).toBe(400);
    const ok = await request('/stakeholders/timers', {
      method: 'PUT',
      body: { remindAfterHours: 6, returnAfterHours: 8 },
    });
    expect(await ok.json()).toEqual({ remindAfterHours: 6, returnAfterHours: 8 });
    expect(await (await request('/stakeholders/timers')).json()).toMatchObject({
      remindAfterHours: 6,
    });
  });

  it("stores routes with a goal, a task or a topic, and serves a task's question routes", async () => {
    const w = drafted();
    const put = await request(`/projects/${w.ws.project.id}/routing-rules`, {
      method: 'PUT',
      body: {
        rules: [
          { category: 'product', area: null, taskId: w.ws.task.id, personId: w.mark.id },
          { category: null, area: null, topic: 'billing', personId: w.mark.id },
        ],
      },
    });
    expect(put.status).toBe(200);
    expect(listRoutingRules(store.db, w.ws.project.id)).toHaveLength(2);
    const routes = (await (await request(`/tasks/${w.ws.task.id}/question-routes`)).json()) as {
      category: string | null;
      topic: string | null;
      from: string;
    }[];
    expect(routes.map((r) => [r.category, r.topic, r.from])).toEqual([
      ['product', null, 'task'],
      [null, 'billing', 'topic'],
    ]);
  });
});

describe('the inbox routes', () => {
  it('answers 400 naming the pattern for Send on a held draft', async () => {
    const w = drafted({ title: 'See https://example.com' });
    const res = await request(`/inbox/${w.card}/send`, { method: 'POST', body: {} });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('url');
  });

  it('sends a draft the builder released', async () => {
    const w = drafted();
    const res = await request(`/inbox/${w.card}/send`, { method: 'POST', body: {} });
    expect(res.status).toBe(200);
    expect(sendForCard(store.db, w.card)?.state).toBe('sent');
    expect(slack.posts).toHaveLength(1);
  });

  it('ignores answeredBy in the answer body', async () => {
    const w = drafted();
    const res = await request(`/inbox/${w.card}/answer`, {
      method: 'POST',
      body: { choice: 'Yes', answeredBy: 'mark', via: 'slack' },
    });
    expect(res.status).toBe(200);
    expect(getInboxItem(store.db, w.card).answer).toEqual({ choice: 'Yes' });
  });

  it('ask writes the routes asked for and redrafts', async () => {
    const w = drafted();
    const ana = store.write((ctx) =>
      insertPerson(ctx, { handle: 'ana', name: 'Ana', slack: contact('U-ana') }),
    ).value;
    const res = await request(`/inbox/${w.card}/ask`, {
      method: 'POST',
      body: {
        personIds: [ana.id],
        always: { categories: ['product'], goalId: null, taskId: w.ws.task.id },
      },
    });
    expect(res.status).toBe(200);
    expect(listRoutingRules(store.db, w.ws.project.id)).toMatchObject([
      { category: 'product', taskId: w.ws.task.id, personId: ana.id },
    ]);
    expect(sendForCard(store.db, w.card)?.people.map((p) => p.userId)).toEqual(['U-ana']);
  });

  it('takes a sent question back, and refuses keep-waiting unless it came back', async () => {
    const w = drafted();
    await request(`/inbox/${w.card}/send`, { method: 'POST', body: {} });
    expect((await request(`/inbox/${w.card}/keep-waiting`, { method: 'POST' })).status).toBe(409);
    const back = await request(`/inbox/${w.card}/take-back`, { method: 'POST' });
    expect(back.status).toBe(200);
    expect(getInboxItem(store.db, w.card).assignees).toEqual(['me']);
  });

  it('composes the message for a person without Slack', async () => {
    const w = drafted();
    const dana = store.write((ctx) => insertPerson(ctx, { handle: 'dana', name: 'Dana' })).value;
    const res = await request(`/inbox/${w.card}/compose?personIds=${dana.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; hits: unknown[] };
    expect(body.text).toContain('has a question for you');
    expect(body.hits).toEqual([]);
  });
});
