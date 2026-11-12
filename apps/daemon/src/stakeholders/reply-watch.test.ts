import {
  ConflictError,
  EventType,
  type InboxItemId,
  mintId,
  type PersonDto,
} from '@10db/contracts';
import {
  createTestStore,
  getInboxItem,
  insertPerson,
  listDecisions,
  moveSend,
  newThreadsSince,
  openSends,
  sendForCard,
  setRoutingRules,
  setStakeholderTimers,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_BOT_USER, FakeSlack } from '../../test/fake-slack';
import { seedWorkstream } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createInboxService, type InboxService } from '../inbox';
import type { Judge, JudgeAnswer, JudgeRequest } from '../judge';
import { silentLogger } from '../log';
import { draftContext, draftFor } from './drafts';
import { createReplyWatch, type ReplyWatch } from './reply-watch';
import { createSlackConnection, type SlackConnection } from './slack-connection';
import { createStakeholderSends, type StakeholderSends } from './sends';
import { createTimerWatch } from './timer-watch';

let store: Store;
let close: () => void;
let state: StateStore;
let clock: ManualClock;
let slack: FakeSlack;
let inbox: InboxService;
let sends: StakeholderSends;
let connection: SlackConnection;
let watch: ReplyWatch;
let judgeAnswers: JudgeRequest[];
let judgeReply: (req: JudgeRequest) => JudgeAnswer;
let delivered: string[];
let parked: string[];
let changes: string[];

const HOUR = 3_600_000;
const MIN = 60_000;

const fallback = (): JudgeAnswer => ({
  kind: 'fallback',
  reason: 'no_key',
  detail: 'no key',
  callId: mintId('JudgeCall'),
});
const answeredWith =
  (choice: string, confidence = 0.95) =>
  (): JudgeAnswer => ({
    kind: 'answered',
    choice,
    confidence,
    model: 'm',
    latencyMs: 1,
    costUsd: null,
    callId: mintId('JudgeCall'),
  });

const judge: Judge = {
  off: false,
  choose: (req) => {
    judgeAnswers.push(req);
    return Promise.resolve(judgeReply(req));
  },
};

function buildWatch(): ReplyWatch {
  return createReplyWatch({
    state,
    slack,
    inbox,
    judge,
    sends,
    clock,
    log: silentLogger,
    connection,
  });
}

beforeEach(() => {
  clock = new ManualClock();
  ({ store, close } = createTestStore(() => clock.now()));
  const bus = createEventBus();
  changes = [];
  bus.subscribe((e) => {
    if (e.type === EventType.SlackConnectionChanged)
      changes.push(typeof e.data['state'] === 'string' ? e.data['state'] : '');
  });
  state = createStateStore(store, bus);
  slack = new FakeSlack();
  delivered = [];
  parked = [];
  judgeAnswers = [];
  judgeReply = fallback;
  inbox = createInboxService({
    state,
    onParkedAnswer: (target, item) => delivered.push(`${target.workstreamId}:${item.id}`),
    parkWaiting: (id) => parked.push(id),
  });
  sends = createStakeholderSends({ state, slack, clock, log: silentLogger });
  connection = createSlackConnection({ state });
  watch = buildWatch();
});
afterEach(async () => {
  await watch.stop();
  close();
});

interface Scene {
  project: ReturnType<typeof seedWorkstream>['project'];
  mark: PersonDto;
  ana: PersonDto;
  /** A routed question to `to`, sent now; answers the options Yes and No. */
  send(
    to?: PersonDto[],
    over?: { title?: string; text?: string; asker?: ReturnType<typeof seedWorkstream> },
  ): Promise<Sent>;
  asker(): ReturnType<typeof seedWorkstream>;
}
interface Sent {
  cardId: InboxItemId;
  channel: string;
  threadTs: string;
  sendId: string;
}

function scene(): Scene {
  const first = seedWorkstream(store);
  const person = (handle: string, userId: string) =>
    store.write((ctx) =>
      insertPerson(ctx, {
        handle,
        name: handle.charAt(0).toUpperCase() + handle.slice(1),
        slack: { teamId: 'T1', userId, sendMode: 'review', dailyLimit: null },
      }),
    ).value;
  const mark = person('mark', 'UMARK');
  const ana = person('ana', 'UANA');
  store.write((ctx) => insertPerson(ctx, { handle: 'me', name: 'Travis', isBuilder: true }));
  let n = 0;
  const asker = () => {
    n += 1;
    return seedWorkstream(store, { project: first.project, title: `Task ${String(n)}` });
  };
  return {
    project: first.project,
    mark,
    ana,
    asker,
    async send(to = [mark], over = {}) {
      const ws = over.asker ?? asker();
      store.write((ctx) =>
        setRoutingRules(ctx, first.project.id, {
          rules: to.map((p) => ({ category: 'product' as const, area: 'api', personId: p.id })),
        }),
      );
      const { item } = inbox.ask({
        projectId: first.project.id,
        workstreamId: ws.workstream.id,
        sessionId: mintId('Session'),
        kind: 'question',
        title: over.title ?? `Question ${String(n)}?`,
        body: '',
        options: [
          { label: 'Yes', description: '' },
          { label: 'No', description: '' },
        ],
        recommendation: null,
        category: 'product',
        urgency: 'normal',
        detail: null,
        signal: new AbortController().signal,
      });
      store.write((ctx) => {
        draftFor(ctx, getInboxItem(ctx.tx, item.id), {
          ...draftContext(ctx.tx, item),
          afterDraft: () => undefined,
          log: silentLogger,
        });
      });
      await sends.send(item.id, over.text === undefined ? {} : { text: over.text });
      const posted = sendForCard(store.db, item.id);
      const row = openSends(store.db).find((s) => s.inboxItemId === item.id);
      if (!posted || !row) throw new Error('not sent');
      return { cardId: item.id, channel: row.channelId, threadTs: row.threadTs, sendId: posted.id };
    },
  };
}

const card = (id: InboxItemId) => getInboxItem(store.db, id);
const send = (id: InboxItemId) => sendForCard(store.db, id);
const ticks = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i += 1) {
    clock.advance(MIN);
    await watch.tick();
  }
};

describe('a lone recipient replies in the thread', () => {
  it('answers the card as them once a quiet tick finds nothing newer, and records a decision', async () => {
    const s = scene();
    const sent = await s.send();
    slack.say(sent.channel, 'UMARK', "B, we can't give away a week.", sent.threadTs);
    await ticks(1);
    expect(card(sent.cardId).state).toBe('OPEN');
    expect(openSends(store.db)[0]?.loneReplyPendingSince).not.toBeNull();
    await ticks(1);
    expect(card(sent.cardId)).toMatchObject({
      state: 'RESOLVED',
      answer: { choice: 'No', answeredBy: 'mark', via: 'slack' },
    });
    expect(send(sent.cardId)).toMatchObject({
      state: 'answered',
      replyVia: 'thread',
      readAs: 'option',
    });
    expect(listDecisions(store.db, { projectId: s.project.id })[0]).toMatchObject({
      decidedBy: 'mark',
      choice: 'No',
    });
    expect(delivered).toHaveLength(1);
    expect(slack.textsIn(sent.channel)).toHaveLength(1);
  });

  it('reads words that match no option, and two messages joined, as their own words', async () => {
    const s = scene();
    const a = await s.send();
    slack.say(a.channel, 'UMARK', 'Let me check with legal.', a.threadTs);
    const b = await s.send([s.ana]);
    slack.say(b.channel, 'UANA', 'B', b.threadTs);
    slack.say(b.channel, 'UANA', 'wait, A', b.threadTs);
    await ticks(2);
    expect(send(a.cardId)).toMatchObject({ readAs: 'own_words' });
    expect(send(b.cardId)).toMatchObject({ readAs: 'own_words' });
    expect(card(a.cardId).answer?.choice).toBe("In Mark's words");
  });

  it('keeps the first value of the pending mark while more messages arrive, and waits another tick', async () => {
    const s = scene();
    const sent = await s.send();
    slack.say(sent.channel, 'UMARK', 'B', sent.threadTs);
    await ticks(1);
    const first = openSends(store.db)[0]?.loneReplyPendingSince;
    slack.say(sent.channel, 'UMARK', 'actually A', sent.threadTs);
    await ticks(1);
    expect(card(sent.cardId).state).toBe('OPEN');
    expect(openSends(store.db)[0]?.loneReplyPendingSince).toBe(first);
    await ticks(1);
    expect(send(sent.cardId)).toMatchObject({ state: 'answered', readAs: 'own_words' });
  });

  it('ignores the bot, someone outside the conversation, and a message before the question', async () => {
    const s = scene();
    slack.say('D-UMARK', 'UMARK', 'old chatter');
    const sent = await s.send();
    slack.say(sent.channel, 'U-priya', 'A', sent.threadTs);
    slack.say(sent.channel, FAKE_BOT_USER, 'A', sent.threadTs);
    await ticks(3);
    expect(card(sent.cardId).state).toBe('OPEN');
    expect(openSends(store.db)[0]?.loneReplyPendingSince).toBeNull();
  });

  it('leaves a conversation with several recipients to the settle rules and answers nothing', async () => {
    const s = scene();
    const sent = await s.send([s.mark, s.ana]);
    slack.say(sent.channel, 'UMARK', 'B', sent.threadTs);
    await ticks(3);
    expect(card(sent.cardId).state).toBe('OPEN');
  });
});

describe('across restarts, sleep and the builder', () => {
  it('delivers a reply once whether the watch restarts between reading and the next tick or after', async () => {
    const s = scene();
    const sent = await s.send();
    slack.say(sent.channel, 'UMARK', 'A', sent.threadTs);
    await ticks(1);
    watch = buildWatch();
    await ticks(1);
    expect(card(sent.cardId).state).toBe('OPEN');
    await ticks(1);
    expect(send(sent.cardId)?.state).toBe('answered');
    watch = buildWatch();
    await ticks(3);
    expect(delivered).toHaveLength(1);
  });

  it('answers three sends once each after a two-hour clock jump', async () => {
    const s = scene();
    const all = [await s.send(), await s.send(), await s.send()];
    for (const sent of all) slack.say(sent.channel, 'UMARK', 'A', sent.threadTs);
    clock.advance(2 * HOUR);
    await watch.tick();
    for (const sent of all) expect(send(sent.cardId)?.state).toBe('answered');
    expect(delivered).toHaveLength(3);
  });

  it('does nothing about Mark after the builder answered first: no second answer, resume or line about him', async () => {
    const s = scene();
    const sent = await s.send();
    inbox.answer(sent.cardId, { choice: 'Yes' });
    await sends.onCardChanged(card(sent.cardId));
    const lines = slack.posts.length;
    slack.say(sent.channel, 'UMARK', 'B', sent.threadTs);
    await ticks(3);
    expect(card(sent.cardId).answer).toMatchObject({ choice: 'Yes' });
    expect(card(sent.cardId).answer?.via).toBeUndefined();
    expect(slack.posts).toHaveLength(lines);
    // The builder's answer reached the live waiter itself; Mark's reply resumes nothing more.
    expect(delivered).toHaveLength(0);
  });

  it("refuses the builder's answer after Mark's reply, and changes nothing", async () => {
    const s = scene();
    const sent = await s.send();
    slack.say(sent.channel, 'UMARK', 'B', sent.threadTs);
    await ticks(2);
    const before = card(sent.cardId);
    expect(() => inbox.answer(sent.cardId, { choice: 'Yes' })).toThrow(ConflictError);
    expect(card(sent.cardId)).toEqual(before);
  });

  it('answers a follow-up from the reply after it, not from the earlier reply to the first question', async () => {
    const s = scene();
    const task = s.asker();
    const first = await s.send([s.mark], { asker: task, title: 'First?' });
    slack.say(first.channel, 'UMARK', 'A', first.threadTs);
    const second = await s.send([s.mark], { asker: task, title: 'Second?' });
    slack.say(second.channel, 'UMARK', 'B', first.threadTs);
    await ticks(2);
    expect(card(second.cardId).answer?.choice).toBe('No');
    expect(card(first.cardId).answer?.choice).toBe('Yes');
  });

  it('looks for a post left in flight on every good tick, not only at start', async () => {
    const s = scene();
    const ws = s.asker();
    slack.failNext('chat.postMessage', 'timeout');
    store.write((ctx) =>
      setRoutingRules(ctx, s.project.id, {
        rules: [{ category: 'product', area: 'api', personId: s.mark.id }],
      }),
    );
    const { item } = inbox.ask({
      projectId: s.project.id,
      workstreamId: ws.workstream.id,
      sessionId: mintId('Session'),
      kind: 'question',
      title: 'In flight?',
      body: '',
      options: [
        { label: 'Yes', description: '' },
        { label: 'No', description: '' },
      ],
      recommendation: null,
      category: 'product',
      urgency: 'normal',
      detail: null,
      signal: new AbortController().signal,
    });
    store.write((ctx) => {
      draftFor(ctx, getInboxItem(ctx.tx, item.id), {
        ...draftContext(ctx.tx, item),
        afterDraft: () => undefined,
        log: silentLogger,
      });
    });
    await sends.send(item.id, {});
    expect(send(item.id)?.state).toBe('sending');
    await ticks(1);
    expect(send(item.id)?.state).toBe('sent');
  });
});

describe('the connection', () => {
  it('stops at a refused token and calls nothing more', async () => {
    const s = scene();
    await s.send();
    slack.failAlways('conversations.replies', 'token_revoked');
    await ticks(1);
    expect(connection.get().state).toBe('refused');
    const calls = slack.calls.length;
    await ticks(4);
    expect(slack.calls).toHaveLength(calls);
    expect(changes.filter((c) => c === 'refused')).toHaveLength(1);
  });

  it('leaves connected after two failed ticks, goes unreachable on the third, and clears on a good one', async () => {
    const s = scene();
    await s.send();
    await ticks(1);
    expect(connection.get().state).toBe('connected');
    slack.failAlways('conversations.replies', 'unreachable');
    await ticks(2);
    expect(connection.get().state).toBe('connected');
    await ticks(1);
    expect(connection.get().state).toBe('unreachable');
    slack.clearFailing();
    await ticks(1);
    expect(connection.get().state).toBe('connected');
  });

  it('counts a timeout and an HTTP 5xx like an unreachable Slack', async () => {
    const s = scene();
    await s.send();
    slack.failNext('conversations.replies', 'timeout');
    slack.failNext('conversations.replies', 'http_503');
    slack.failNext('conversations.replies', 'timeout');
    await ticks(3);
    expect(connection.get().state).toBe('unreachable');
  });

  it('sets none when the token is removed with sends open, stops, and answers a reply written meanwhile after reconnecting', async () => {
    const s = scene();
    const sent = await s.send();
    slack.failAlways('auth.test', 'no_token');
    await ticks(1);
    expect(connection.get().state).toBe('none');
    slack.say(sent.channel, 'UMARK', 'B', sent.threadTs);
    const calls = slack.calls.length;
    await ticks(2);
    expect(slack.calls).toHaveLength(calls);
    slack.clearFailing();
    await watch.reconnect();
    expect(connection.get().state).toBe('connected');
    await ticks(2);
    expect(send(sent.cardId)?.state).toBe('answered');
    expect(delivered).toHaveLength(1);
  });

  it("reads on from each send's cursor after a refusal, so a reply written during it still answers", async () => {
    const s = scene();
    const sent = await s.send();
    slack.failNext('conversations.replies', 'invalid_auth');
    await ticks(1);
    expect(connection.get().state).toBe('refused');
    slack.say(sent.channel, 'UMARK', 'A', sent.threadTs);
    await watch.reconnect();
    await ticks(2);
    expect(card(sent.cardId).answer).toMatchObject({ choice: 'Yes', via: 'slack' });
  });
});

describe('replies typed at the top of the DM', () => {
  it('answers the only open send, recording that it came from the top level', async () => {
    const s = scene();
    const sent = await s.send();
    slack.say(sent.channel, 'UMARK', 'B please');
    await ticks(2);
    expect(send(sent.cardId)).toMatchObject({ state: 'answered', replyVia: 'top_level' });
    expect(card(sent.cardId).answer?.choice).toBe('No');
    expect(slack.posts.filter((p) => p.text.includes('Got it'))).toEqual([]);
  });

  it('ignores a top-level message when the person has no open send, and does not count it later', async () => {
    const s = scene();
    const sent = await s.send();
    slack.say(sent.channel, 'UMARK', 'B');
    inbox.answer(sent.cardId, { choice: 'Yes' });
    await sends.onCardChanged(card(sent.cardId));
    await ticks(2);
    const later = await s.send([s.mark], { title: 'Later?' });
    await ticks(3);
    expect(card(later.cardId).state).toBe('OPEN');
  });

  it('lets the judge pick which of two open questions a top-level reply answers', async () => {
    const s = scene();
    const first = await s.send([s.mark], { title: 'First?' });
    const second = await s.send([s.mark], { title: 'Second?' });
    judgeReply = answeredWith('2');
    slack.say(first.channel, 'UMARK', 'A');
    await ticks(3);
    expect(judgeAnswers[0]?.decision).toBe('reply_match');
    expect(card(second.cardId).answer).toMatchObject({ choice: 'Yes', via: 'slack' });
    expect(card(first.cardId).state).toBe('OPEN');
  });

  it('asks which one it is for when the judge cannot say, once, and a number assigns it', async () => {
    const s = scene();
    const first = await s.send([s.mark], { title: 'First?' });
    const second = await s.send([s.mark], { title: 'Second?' });
    slack.say(first.channel, 'UMARK', 'B');
    await ticks(3);
    const asks = () => slack.posts.filter((p) => p.text.startsWith('Which one is this for?'));
    expect(asks()).toHaveLength(1);
    expect(asks()[0]?.text).toContain('1) First?');
    expect(asks()[0]?.text).toContain('2) Second?');
    expect(asks()[0]?.threadTs).toBeUndefined();
    await ticks(2);
    expect(asks()).toHaveLength(1);
    slack.say(first.channel, 'UMARK', '2');
    await ticks(3);
    expect(card(second.cardId).answer).toMatchObject({ choice: 'No', via: 'slack' });
    expect(card(first.cardId).state).toBe('OPEN');
  });

  it('lists the questions with their text escaped, and a link instead of a title the scan holds', async () => {
    const s = scene();
    const first = await s.send([s.mark], { title: 'Ping <!channel> about <@U123> now?' });
    await s.send([s.mark], {
      title: 'See https://evil.test/secret?token=1',
      text: 'A question about the link',
    });
    slack.say(first.channel, 'UMARK', 'B');
    await ticks(2);
    const ask = slack.posts.find((p) => p.text.startsWith('Which one is this for?'))?.text ?? '';
    expect(ask).not.toContain('<!channel>');
    expect(ask).not.toContain('<@U123>');
    expect(ask).not.toContain('evil.test');
    expect(ask).toContain('2) A question you were sent: https://slack/');
  });

  it('remembers across a restart which question a top-level reply was used for', async () => {
    const s = scene();
    const first = await s.send([s.mark], { title: 'First?' });
    const second = await s.send([s.mark], { title: 'Second?' });
    judgeReply = answeredWith('1');
    slack.say(first.channel, 'UMARK', 'A');
    await ticks(3);
    expect(card(first.cardId).answer).toMatchObject({ choice: 'Yes' });
    watch = buildWatch();
    await ticks(4);
    expect(card(second.cardId).state).toBe('OPEN');
  });

  it('does not ask which one it is for again after a restart', async () => {
    const s = scene();
    const first = await s.send([s.mark], { title: 'First?' });
    await s.send([s.mark], { title: 'Second?' });
    slack.say(first.channel, 'UMARK', 'B');
    await ticks(3);
    const asks = () => slack.posts.filter((p) => p.text.startsWith('Which one is this for?'));
    expect(asks()).toHaveLength(1);
    watch = buildWatch();
    await ticks(3);
    expect(asks()).toHaveLength(1);
  });

  it('falls back to asking when the judge is below its floor', async () => {
    const s = scene();
    await s.send([s.mark], { title: 'First?' });
    const second = await s.send([s.mark], { title: 'Second?' });
    judgeReply = answeredWith('1', 0.5);
    slack.say(second.channel, 'UMARK', 'A');
    await ticks(3);
    expect(slack.posts.some((p) => p.text.startsWith('Which one is this for?'))).toBe(true);
  });
});

describe('the reminder', () => {
  const reminders = () => slack.posts.filter((p) => p.text.startsWith('Bumping this'));

  it('posts one reminder in the thread at four hours, and not again over later ticks', async () => {
    const s = scene();
    const sent = await s.send();
    clock.advance(4 * HOUR);
    await watch.tick();
    expect(reminders()).toHaveLength(1);
    expect(reminders()[0]).toMatchObject({ channel: sent.channel, threadTs: sent.threadTs });
    expect(reminders()[0]?.metadata?.eventPayload['sendId']).toBe(sent.sendId);
    await ticks(3);
    expect(reminders()).toHaveLength(1);
    expect(openSends(store.db)[0]?.remindedAt).not.toBeNull();
  });

  it('posts one reminder, and no return, on the wake tick of a jump from three to six hours', async () => {
    const s = scene();
    await s.send();
    clock.advance(3 * HOUR);
    await watch.tick();
    clock.advance(3 * HOUR);
    await watch.tick();
    await createTimerWatch({ state, clock, log: silentLogger }).tick();
    expect(reminders()).toHaveLength(1);
    expect(openSends(store.db)[0]?.returnedAt).toBeNull();
  });

  it('returns the send once and posts no reminder on a jump from three to ten hours', async () => {
    const s = scene();
    await s.send();
    clock.advance(3 * HOUR);
    await watch.tick();
    clock.advance(7 * HOUR);
    await createTimerWatch({ state, clock, log: silentLogger }).tick();
    await watch.tick();
    expect(reminders()).toEqual([]);
    expect(openSends(store.db)[0]?.returnedAt).not.toBeNull();
  });

  it('still answers a reply that comes at nine hours, after the return', async () => {
    const s = scene();
    const sent = await s.send();
    clock.advance(9 * HOUR);
    await createTimerWatch({ state, clock, log: silentLogger }).tick();
    expect(openSends(store.db)[0]?.returnedAt).not.toBeNull();
    slack.say(sent.channel, 'UMARK', 'A', sent.threadTs);
    await ticks(2);
    expect(send(sent.cardId)).toMatchObject({ state: 'answered', readAs: 'option' });
  });

  it('posts the reminder of a moved send in the group DM', async () => {
    const s = scene();
    const sent = await s.send();
    store.write((ctx) => {
      moveSend(ctx, sent.sendId as never, {
        channelId: 'G-new',
        threadTs: '900.000100',
        messageTs: '900.000100',
        permalink: null,
        added: [],
      });
    });
    clock.advance(4 * HOUR);
    await watch.tick();
    expect(reminders()[0]).toMatchObject({ channel: 'G-new', threadTs: '900.000100' });
  });

  it('does not repost a reminder it finds already in the thread, by its metadata', async () => {
    const s = scene();
    const sent = await s.send();
    slack.found = [
      {
        ts: '5000.000100',
        threadTs: sent.threadTs,
        user: FAKE_BOT_USER,
        botId: 'B1',
        subtype: null,
        text: 'Bumping this',
        edited: false,
        reactions: [],
        metadata: {
          eventType: 'tendb_send',
          eventPayload: { sendId: sent.sendId, line: 'reminder' },
        },
      },
    ];
    clock.advance(4 * HOUR);
    await watch.tick();
    expect(reminders()).toEqual([]);
    expect(openSends(store.db)[0]?.remindedAt).not.toBeNull();
  });

  it('holds a reminder one tick for a lone reply already waiting', async () => {
    const s = scene();
    const sent = await s.send();
    clock.advance(4 * HOUR - 30_000);
    slack.say(sent.channel, 'UMARK', 'A', sent.threadTs);
    await watch.tick();
    clock.advance(60_000);
    await watch.tick();
    expect(reminders()).toEqual([]);
    expect(send(sent.cardId)?.state).toBe('answered');
  });

  it('owes the reminder through unreachable ticks and posts it on the first good one only if not returned', async () => {
    const s = scene();
    await s.send();
    slack.failAlways('conversations.replies', 'unreachable');
    clock.advance(5 * HOUR);
    await watch.tick();
    expect(reminders()).toEqual([]);
    clock.advance(4 * HOUR);
    await createTimerWatch({ state, clock, log: silentLogger }).tick();
    slack.clearFailing();
    await watch.tick();
    expect(reminders()).toEqual([]);
    expect(openSends(store.db)[0]?.returnedAt).not.toBeNull();
  });

  it('posts a reminder owed through an outage on reconnect when the send has not returned', async () => {
    const s = scene();
    await s.send();
    slack.failAlways('auth.test', 'no_token');
    clock.advance(5 * HOUR);
    await watch.tick();
    expect(reminders()).toEqual([]);
    slack.clearFailing();
    await watch.reconnect();
    await watch.tick();
    expect(reminders()).toHaveLength(1);
  });

  it('returns both sends, with no Slack call, when the token is deleted and eight hours pass', async () => {
    const s = scene();
    await s.send();
    await s.send();
    slack.failAlways('auth.test', 'no_token');
    await watch.tick();
    expect(connection.get().state).toBe('none');
    slack.calls.length = 0;
    clock.advance(8 * HOUR);
    await createTimerWatch({ state, clock, log: silentLogger }).tick();
    expect(openSends(store.db).map((o) => o.returnedAt !== null)).toEqual([true, true]);
    expect(slack.calls).toEqual([]);
  });

  it('applies a changed reminder setting from the next tick', async () => {
    const s = scene();
    await s.send();
    clock.advance(2 * HOUR);
    await watch.tick();
    expect(reminders()).toEqual([]);
    store.write((ctx) => {
      setStakeholderTimers(ctx, { remindAfterHours: 2, returnAfterHours: 8 });
    });
    await watch.tick();
    expect(reminders()).toHaveLength(1);
  });
});

describe('a thread with several questions', () => {
  it('never answers an open question from a reply to a later one that was answered', async () => {
    const s = scene();
    const task = s.asker();
    const first = await s.send([s.mark], { asker: task, title: 'First?' });
    const second = await s.send([s.mark], { asker: task, title: 'Second?' });
    expect(second.threadTs).toBe(first.threadTs);
    slack.say(first.channel, 'UMARK', 'B', first.threadTs);
    await ticks(2);
    expect(card(second.cardId).answer).toMatchObject({ choice: 'No', via: 'slack' });
    await ticks(5);
    expect(card(first.cardId).state).toBe('OPEN');
    expect(openSends(store.db).map((o) => o.id)).toEqual([first.sendId]);
  });
});

describe('bringing someone in', () => {
  const group = (...users: string[]) => `G-${users.join('-')}`;

  async function mentioned(over: { text?: string } = {}) {
    const s = scene();
    slack.names.set('UPRIYA', 'Priya');
    slack.names.set('UDANA', 'Dana');
    const sent = await s.send([s.mark]);
    slack.say(sent.channel, 'UMARK', over.text ?? 'Asking <@UPRIYA> to weigh in', sent.threadTs);
    return { s, sent };
  }

  it('opens one group DM, reposts the question there, tells the old thread, and moves the send', async () => {
    const { sent } = await mentioned();
    await ticks(1);
    const channel = group('UMARK', 'UPRIYA');
    expect(slack.opened).toContainEqual({ kind: 'group', users: ['UMARK', 'UPRIYA'] });
    const reposted = slack.posts.find((p) => p.channel === channel);
    expect(reposted?.text).toContain("Mark brought in Priya. Here's the question:");
    expect(reposted?.text).toContain('Question');
    expect(reposted?.metadata?.eventPayload['sendId']).toBe(sent.sendId);
    expect(
      slack.posts.find(
        (p) => p.channel === sent.channel && p.text.startsWith('Moved to a group DM'),
      )?.text,
    ).toBe('Moved to a group DM with Priya.');
    const [open] = openSends(store.db);
    expect(open).toMatchObject({ channelId: channel, movedFrom: { channelId: sent.channel } });
    expect(open?.people.map((p) => [p.userId, p.recipient])).toEqual([
      ['UMARK', true],
      ['UPRIYA', false],
    ]);
    expect(send(sent.cardId)?.state).toBe('sent');
  });

  it("reads the new person's reply in the group DM on the next tick, and a reply left in the old thread once", async () => {
    const { sent } = await mentioned();
    await ticks(1);
    const open = openSends(store.db)[0];
    slack.say(
      open?.channelId ?? '',
      'UPRIYA',
      'B is the only option legal signs off',
      open?.threadTs,
    );
    slack.say(sent.channel, 'UMARK', 'agreed, B', sent.threadTs);
    await ticks(2);
    // Two people spoke, so it settles rather than answering as a lone reply.
    expect(card(sent.cardId).state).toBe('OPEN');
    expect(judgeAnswers.at(-1)?.decision).toBe('thread_answer');
    const messages = JSON.parse(judgeAnswers.at(-1)?.state ?? '{}') as {
      messages: { text: string }[];
    };
    expect(messages.messages.map((m) => m.text).sort()).toEqual(
      ['B is the only option legal signs off', 'agreed, B', 'Asking <@UPRIYA> to weigh in'].sort(),
    );
  });

  it('never answers a moved question from a reply to the follow-up left in the old thread', async () => {
    const s = scene();
    slack.names.set('UPRIYA', 'Priya');
    const task = s.asker();
    const first = await s.send([s.mark], { asker: task, title: 'First?' });
    slack.say(first.channel, 'UMARK', 'Asking <@UPRIYA> to weigh in', first.threadTs);
    const second = await s.send([s.mark], { asker: task, title: 'Second?' });
    expect(second.threadTs).toBe(first.threadTs);
    await ticks(1);
    expect(openSends(store.db).find((o) => o.id === first.sendId)?.movedFrom).toMatchObject({
      threadTs: first.threadTs,
    });
    slack.say(first.channel, 'UMARK', 'A', first.threadTs);
    await ticks(3);
    expect(card(second.cardId).answer).toMatchObject({ choice: 'Yes', via: 'slack' });
    expect(card(first.cardId).state).toBe('OPEN');
    expect(judgeAnswers.filter((r) => r.decision === 'thread_answer')).toEqual([]);
  });

  it('reads a lone "B" after the move as an option, not joined with the mention that brought someone in', async () => {
    const { sent } = await mentioned();
    await ticks(1);
    const open = openSends(store.db)[0];
    slack.say(open?.channelId ?? '', 'UMARK', 'B', open?.threadTs);
    await ticks(2);
    expect(send(sent.cardId)).toMatchObject({ state: 'answered', readAs: 'option' });
  });

  it('opens a new group DM with all three when a brought-in person mentions another', async () => {
    const { sent } = await mentioned();
    await ticks(1);
    const open = openSends(store.db)[0];
    slack.say(open?.channelId ?? '', 'UPRIYA', 'adding <@UDANA>', open?.threadTs);
    await ticks(1);
    expect(slack.opened.at(-1)).toEqual({ kind: 'group', users: ['UMARK', 'UPRIYA', 'UDANA'] });
    expect(openSends(store.db)[0]?.people.map((p) => p.userId)).toEqual([
      'UMARK',
      'UPRIYA',
      'UDANA',
    ]);
    expect(send(sent.cardId)?.state).toBe('sent');
  });

  it('does nothing for a mention of the bot or of the person themselves', async () => {
    const s = scene();
    const sent = await s.send([s.mark]);
    slack.say(sent.channel, 'UMARK', 'hi <@UBOT> again', sent.threadTs);
    await ticks(2);
    expect(slack.opened.filter((o) => o.kind === 'group')).toEqual([]);
  });

  it('says the conversation is full for a ninth person', async () => {
    const s = scene();
    const sent = await s.send([s.mark]);
    // Seven more people already in the conversation.
    store.write((ctx) => {
      moveSend(ctx, sent.sendId as never, {
        channelId: sent.channel,
        threadTs: sent.threadTs,
        messageTs: sent.threadTs,
        permalink: null,
        added: Array.from({ length: 7 }, (_, i) => ({
          userId: `UX${String(i)}`,
          personId: null,
          name: `X${String(i)}`,
          recipient: false,
        })),
      });
    });
    slack.say(sent.channel, 'UMARK', 'and <@ULATE>', sent.threadTs);
    await ticks(1);
    await ticks(2);
    const full = slack.posts.filter((p) => p.text.startsWith('This conversation is full'));
    expect(full).toHaveLength(1);
    expect(slack.opened.filter((o) => o.kind === 'group')).toEqual([]);
  });

  it('posts the could-not-add line once when the open is refused, and moves nothing', async () => {
    const { sent } = await mentioned();
    slack.failAlways('conversations.open', 'user_not_found');
    await ticks(1);
    expect(openSends(store.db)[0]?.channelId).toBe(sent.channel);
    expect(send(sent.cardId)?.state).toBe('sent');
    await ticks(2);
    const lines = slack.posts.filter((p) => p.text.includes("couldn't add"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ channel: sent.channel, threadTs: sent.threadTs });
    expect(slack.opened.filter((o) => o.kind === 'group')).toEqual([]);
  });

  it('finds the repost by its metadata after a restart between the repost and the move, and does not repost', async () => {
    const { sent } = await mentioned();
    const real = slack.post.bind(slack);
    let failures = 0;
    // The repost lands, then the process dies before the move is written.
    slack.post = async (input) => {
      const result = await real(input);
      if (input.metadata?.eventPayload['line'] === 'moved' && failures === 0) {
        failures += 1;
        throw new Error('process died');
      }
      return result;
    };
    await ticks(1);
    expect(openSends(store.db)[0]?.channelId).toBe(sent.channel);
    const before = slack.posts.filter((p) => p.metadata?.eventPayload['line'] === 'moved').length;
    watch = buildWatch();
    await ticks(1);
    expect(slack.posts.filter((p) => p.metadata?.eventPayload['line'] === 'moved')).toHaveLength(
      before,
    );
    expect(openSends(store.db)[0]?.channelId).toBe(group('UMARK', 'UPRIYA'));
  });

  it('works with a group id that starts with C', async () => {
    slack.groupPrefix = 'C';
    const { sent } = await mentioned();
    await ticks(1);
    expect(openSends(store.db)[0]?.channelId).toBe('C-UMARK-UPRIYA');
    slack.say('C-UMARK-UPRIYA', 'UPRIYA', 'hello', openSends(store.db)[0]?.threadTs);
    await ticks(1);
    expect(send(sent.cardId)?.state).toBe('sent');
  });

  it('leaves the daily limit alone: the move is not a new thread', async () => {
    const { s } = await mentioned();
    const since = new Date(clock.now().getTime() - 24 * HOUR).toISOString();
    expect(newThreadsSince(store.db, s.mark.id, since)).toBe(1);
    await ticks(1);
    expect(newThreadsSince(store.db, s.mark.id, since)).toBe(1);
  });

  it('tells the new conversation too when the card is settled while the move is in flight', async () => {
    const { sent } = await mentioned();
    const release = slack.pause('chat.postMessage');
    const moving = watch.tick();
    for (let i = 0; i < 500 && !slack.isHeld('chat.postMessage'); i += 1) await Promise.resolve();
    expect(slack.isHeld('chat.postMessage')).toBe(true);
    inbox.answer(sent.cardId, { choice: 'Yes' });
    await sends.onCardChanged(card(sent.cardId));
    release();
    await moving;
    expect(slack.textsIn(group('UMARK', 'UPRIYA')).at(-1)).toBe(
      'Travis answered this one: A. Thanks!',
    );
  });
});

describe('agreeing an answer', () => {
  const settleOn = (choice: string, confidence = 0.9) => {
    judgeReply = (req) =>
      req.decision === 'thread_answer' ? answeredWith(choice, confidence)() : fallback();
  };
  const proposals = () => slack.posts.filter((p) => p.text.startsWith('Sounds like'));
  const whichWays = () => slack.posts.filter((p) => p.text.includes('which way should this go'));

  /** Priya is in the conversation (not a recipient), and says B; the conversation settles into a proposal. */
  async function proposed(to: ('mark' | 'ana')[] = ['mark']) {
    const s = scene();
    const recipients = to.map((h) => s[h]);
    const sent = await s.send(recipients);
    store.write((ctx) => {
      moveSend(ctx, sent.sendId as never, {
        channelId: sent.channel,
        threadTs: sent.threadTs,
        messageTs: sent.threadTs,
        permalink: null,
        added: [{ userId: 'UPRIYA', personId: null, name: 'Priya', recipient: false }],
      });
    });
    settleOn('B');
    slack.say(sent.channel, 'UPRIYA', 'B is the only option legal will sign off on', sent.threadTs);
    await ticks(2);
    const post = proposals()[0];
    if (!post) throw new Error('no proposal was posted');
    return { s, sent, post };
  }

  it("proposes what the judge is sure of, naming who favoured it and mentioning the recipient, with the bot's ✅", async () => {
    const { post, sent } = await proposed();
    expect(post.text).toContain('Sounds like *B*: No');
    expect(post.text).toContain('(Priya)');
    expect(post.text).toContain('<@UMARK>, ✅ to approve');
    expect(post.threadTs).toBe(sent.threadTs);
    expect(await slack.reactions(sent.channel, post.ts)).toEqual([
      { name: 'white_check_mark', users: ['UBOT'] },
    ]);
    expect(judgeAnswers.at(-1)?.criteria).toMatchObject({ A: 'Yes', B: 'No' });
    expect(openSends(store.db)[0]?.proposal).toMatchObject({ choice: 'B', ts: post.ts });
  });

  it("never lets the bot's own ✅ approve, nor anyone who is not a recipient", async () => {
    const { post, sent } = await proposed();
    await ticks(3);
    expect(card(sent.cardId).state).toBe('OPEN');
    slack.react(sent.channel, post.ts, 'white_check_mark', 'UPRIYA');
    await ticks(3);
    expect(card(sent.cardId).state).toBe('OPEN');
    expect(openSends(store.db)[0]?.approvalSeenAt).toBeNull();
  });

  it("approves on the tick after a recipient's ✅, answering as them with the others named in the decision", async () => {
    const { post, sent, s } = await proposed();
    slack.react(sent.channel, post.ts, 'white_check_mark', 'UMARK');
    await ticks(1);
    expect(card(sent.cardId).state).toBe('OPEN');
    expect(openSends(store.db)[0]?.approvalBy).toBe(s.mark.id);
    await ticks(1);
    expect(card(sent.cardId)).toMatchObject({
      state: 'RESOLVED',
      answer: { choice: 'No', answeredBy: 'mark', via: 'slack', with: ['Priya'] },
    });
    expect(send(sent.cardId)).toMatchObject({ state: 'answered', readAs: 'approved' });
    const decision = listDecisions(store.db, { projectId: s.project.id })[0];
    expect(decision).toMatchObject({ decidedBy: 'mark', choice: 'No' });
    expect(decision?.rationale).toContain('«Priya»');
  });

  it('approves nothing when the ✅ is removed before the confirming tick, keeps the proposal, and approves when it is added again', async () => {
    const { post, sent } = await proposed();
    slack.react(sent.channel, post.ts, 'white_check_mark', 'UMARK');
    await ticks(1);
    slack.unreact(sent.channel, post.ts, 'white_check_mark', 'UMARK');
    await ticks(1);
    expect(card(sent.cardId).state).toBe('OPEN');
    expect(openSends(store.db)[0]?.proposal).not.toBeNull();
    expect(openSends(store.db)[0]?.approvalSeenAt).toBeNull();
    slack.react(sent.channel, post.ts, 'white_check_mark', 'UMARK');
    await ticks(1);
    expect(card(sent.cardId).state).toBe('OPEN');
    await ticks(1);
    expect(card(sent.cardId).state).toBe('RESOLVED');
  });

  it("takes a recipient's own letter as their pick", async () => {
    const { sent } = await proposed();
    slack.say(sent.channel, 'UMARK', 'A', sent.threadTs);
    await ticks(1);
    expect(card(sent.cardId).state).toBe('RESOLVED');
    expect(send(sent.cardId)).toMatchObject({ readAs: 'option' });
  });

  it('approves with a typed "yes sir", and withdraws the proposal for words that are not', async () => {
    const { sent } = await proposed();
    slack.say(sent.channel, 'UMARK', 'hmm, not sure', sent.threadTs);
    await ticks(1);
    expect(openSends(store.db)[0]?.proposal).toBeNull();
    expect(card(sent.cardId).state).toBe('OPEN');
    // The next settle asks again, after the conversation goes quiet for thirty minutes.
    clock.advance(31 * MIN);
    await ticks(1);
    expect(judgeAnswers.filter((r) => r.decision === 'thread_answer')).toHaveLength(2);
    expect(proposals()).toHaveLength(2);
  });

  it('approves with "yes sir" typed by the recipient', async () => {
    const { sent } = await proposed();
    slack.say(sent.channel, 'UMARK', 'Yes sir', sent.threadTs);
    await ticks(2);
    expect(send(sent.cardId)).toMatchObject({ state: 'answered', readAs: 'approved' });
  });

  it('posts nothing more for two quiet hours after a proposal', async () => {
    const { sent } = await proposed();
    for (let i = 0; i < 4; i += 1) {
      clock.advance(30 * MIN);
      await watch.tick();
    }
    expect(proposals()).toHaveLength(1);
    expect(card(sent.cardId).state).toBe('OPEN');
  });

  it('asks which way when the judge is unsure, once, and nothing more through two quiet hours', async () => {
    const s = scene();
    const sent = await s.send([s.mark]);
    store.write((ctx) => {
      moveSend(ctx, sent.sendId as never, {
        channelId: sent.channel,
        threadTs: sent.threadTs,
        messageTs: sent.threadTs,
        permalink: null,
        added: [{ userId: 'UPRIYA', personId: null, name: 'Priya', recipient: false }],
      });
    });
    settleOn('B', 0.6);
    slack.say(sent.channel, 'UPRIYA', 'B is right', sent.threadTs);
    await ticks(2);
    expect(whichWays()).toHaveLength(1);
    expect(whichWays()[0]?.text).toContain('<@UMARK>');
    expect(proposals()).toEqual([]);
    for (let i = 0; i < 4; i += 1) {
      clock.advance(30 * MIN);
      await watch.tick();
    }
    expect(whichWays()).toHaveLength(1);
    // His own words after the line answer the card as his own words, with the conversation quoted.
    slack.say(sent.channel, 'UMARK', 'Neither; ask legal first.', sent.threadTs);
    await ticks(2);
    expect(card(sent.cardId).answer).toMatchObject({
      choice: "In Mark's words",
      conversation: expect.arrayContaining([{ name: 'Priya', text: 'B is right' }]) as unknown,
    });
  });

  it('reads a single message after the which-way line as an option, whatever he said before it', async () => {
    const s = scene();
    const sent = await s.send([s.mark]);
    store.write((ctx) => {
      moveSend(ctx, sent.sendId as never, {
        channelId: sent.channel,
        threadTs: sent.threadTs,
        messageTs: sent.threadTs,
        permalink: null,
        added: [{ userId: 'UPRIYA', personId: null, name: 'Priya', recipient: false }],
      });
    });
    judgeReply = fallback;
    slack.say(sent.channel, 'UMARK', 'hmm, let me think about this', sent.threadTs);
    slack.say(sent.channel, 'UPRIYA', 'B is right', sent.threadTs);
    await ticks(2);
    expect(whichWays()).toHaveLength(1);
    slack.say(sent.channel, 'UMARK', 'B', sent.threadTs);
    await ticks(2);
    expect(send(sent.cardId)).toMatchObject({ state: 'answered', readAs: 'option' });
    expect(card(sent.cardId).answer?.choice).toBe('No');
  });

  it('answers B when the recipient names B after the which-way line', async () => {
    const s = scene();
    const sent = await s.send([s.mark]);
    store.write((ctx) => {
      moveSend(ctx, sent.sendId as never, {
        channelId: sent.channel,
        threadTs: sent.threadTs,
        messageTs: sent.threadTs,
        permalink: null,
        added: [{ userId: 'UPRIYA', personId: null, name: 'Priya', recipient: false }],
      });
    });
    judgeReply = fallback;
    slack.say(sent.channel, 'UPRIYA', 'B is right', sent.threadTs);
    await ticks(2);
    expect(whichWays()).toHaveLength(1);
    slack.say(sent.channel, 'UMARK', 'B', sent.threadTs);
    await ticks(2);
    expect(card(sent.cardId).answer).toMatchObject({ choice: 'No', via: 'slack' });
  });

  describe('several recipients', () => {
    it('mentions both, answers as Ana for her ✅, and as the first in routing order for both', async () => {
      const first = await proposed(['mark', 'ana']);
      expect(first.post.text).toContain('<@UMARK> <@UANA>');
      slack.react(first.sent.channel, first.post.ts, 'white_check_mark', 'UANA');
      await ticks(2);
      expect(card(first.sent.cardId).answer).toMatchObject({ answeredBy: 'ana' });
    });

    it('credits Mark when both ✅ arrive in one tick', async () => {
      const w = await proposed(['mark', 'ana']);
      slack.react(w.sent.channel, w.post.ts, 'white_check_mark', 'UANA');
      slack.react(w.sent.channel, w.post.ts, 'white_check_mark', 'UMARK');
      await ticks(2);
      expect(card(w.sent.cardId).answer).toMatchObject({ answeredBy: 'mark' });
    });

    it('returns the card as disagreed, with no decision, for B against C', async () => {
      const s = scene();
      const sent = await s.send([s.mark, s.ana]);
      slack.say(sent.channel, 'UMARK', 'B', sent.threadTs);
      slack.say(sent.channel, 'UANA', 'A', sent.threadTs);
      await ticks(1);
      expect(openSends(store.db)[0]).toMatchObject({ returnedReason: 'disagreed' });
      expect(card(sent.cardId).state).toBe('OPEN');
      expect(listDecisions(store.db, { projectId: s.project.id })).toEqual([]);
      const changes = openSends(store.db)[0]?.returnedAt;
      await ticks(3);
      expect(openSends(store.db)[0]?.returnedAt).toBe(changes);
    });

    it('returns the card as disagreed for a ✅ beside a "hold on" in one tick', async () => {
      const w = await proposed(['mark', 'ana']);
      slack.react(w.sent.channel, w.post.ts, 'white_check_mark', 'UMARK');
      slack.say(w.sent.channel, 'UANA', 'hold on', w.sent.threadTs);
      await ticks(1);
      expect(openSends(store.db)[0]).toMatchObject({ returnedReason: 'disagreed' });
      expect(card(w.sent.cardId).state).toBe('OPEN');
    });

    it("keeps Mark's approval when Ana approves too, and when she names the same letter", async () => {
      const w = await proposed(['mark', 'ana']);
      slack.react(w.sent.channel, w.post.ts, 'white_check_mark', 'UMARK');
      await ticks(1);
      slack.say(w.sent.channel, 'UANA', 'yes', w.sent.threadTs);
      await ticks(1);
      expect(card(w.sent.cardId).answer).toMatchObject({ answeredBy: 'mark' });
    });
  });

  it('does not post a proposal twice after a restart, and reuses one found by its metadata', async () => {
    const { post } = await proposed();
    watch = buildWatch();
    await ticks(3);
    expect(proposals()).toHaveLength(1);
    expect(openSends(store.db)[0]?.proposal?.ts).toBe(post.ts);
  });

  it('finds a proposal posted just before a crash by its metadata, and records it without posting again', async () => {
    const s = scene();
    const sent = await s.send([s.mark]);
    store.write((ctx) => {
      moveSend(ctx, sent.sendId as never, {
        channelId: sent.channel,
        threadTs: sent.threadTs,
        messageTs: sent.threadTs,
        permalink: null,
        added: [{ userId: 'UPRIYA', personId: null, name: 'Priya', recipient: false }],
      });
    });
    settleOn('B');
    slack.say(sent.channel, 'UPRIYA', 'B is right', sent.threadTs);
    slack.found = [
      {
        ts: '9000.000100',
        threadTs: sent.threadTs,
        user: 'UBOT',
        botId: 'B1',
        subtype: null,
        text: 'Sounds like B',
        edited: false,
        reactions: [],
        metadata: {
          eventType: 'tendb_send',
          eventPayload: { sendId: sent.sendId, line: 'proposal' },
        },
      },
    ];
    await ticks(2);
    expect(proposals()).toEqual([]);
    expect(openSends(store.db)[0]?.proposal?.ts).toBe('9000.000100');
  });

  it('lets the builder win over an open proposal, and a later ✅ changes nothing', async () => {
    const { sent, post } = await proposed();
    inbox.answer(sent.cardId, { choice: 'Yes' });
    await sends.onCardChanged(card(sent.cardId));
    slack.react(sent.channel, post.ts, 'white_check_mark', 'UMARK');
    await ticks(3);
    expect(card(sent.cardId).answer).toMatchObject({ choice: 'Yes' });
    expect(card(sent.cardId).answer?.via).toBeUndefined();
  });
});
