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
  const mark = person('mark', 'U-mark');
  const ana = person('ana', 'U-ana');
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
    slack.say(sent.channel, 'U-mark', "B, we can't give away a week.", sent.threadTs);
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
    slack.say(a.channel, 'U-mark', 'Let me check with legal.', a.threadTs);
    const b = await s.send([s.ana]);
    slack.say(b.channel, 'U-ana', 'B', b.threadTs);
    slack.say(b.channel, 'U-ana', 'wait, A', b.threadTs);
    await ticks(2);
    expect(send(a.cardId)).toMatchObject({ readAs: 'own_words' });
    expect(send(b.cardId)).toMatchObject({ readAs: 'own_words' });
    expect(card(a.cardId).answer?.choice).toBe("In Mark's words");
  });

  it('keeps the first value of the pending mark while more messages arrive, and waits another tick', async () => {
    const s = scene();
    const sent = await s.send();
    slack.say(sent.channel, 'U-mark', 'B', sent.threadTs);
    await ticks(1);
    const first = openSends(store.db)[0]?.loneReplyPendingSince;
    slack.say(sent.channel, 'U-mark', 'actually A', sent.threadTs);
    await ticks(1);
    expect(card(sent.cardId).state).toBe('OPEN');
    expect(openSends(store.db)[0]?.loneReplyPendingSince).toBe(first);
    await ticks(1);
    expect(send(sent.cardId)).toMatchObject({ state: 'answered', readAs: 'own_words' });
  });

  it('ignores the bot, someone outside the conversation, and a message before the question', async () => {
    const s = scene();
    slack.say('D-U-mark', 'U-mark', 'old chatter');
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
    slack.say(sent.channel, 'U-mark', 'B', sent.threadTs);
    await ticks(3);
    expect(card(sent.cardId).state).toBe('OPEN');
  });
});

describe('across restarts, sleep and the builder', () => {
  it('delivers a reply once whether the watch restarts between reading and the next tick or after', async () => {
    const s = scene();
    const sent = await s.send();
    slack.say(sent.channel, 'U-mark', 'A', sent.threadTs);
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
    for (const sent of all) slack.say(sent.channel, 'U-mark', 'A', sent.threadTs);
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
    slack.say(sent.channel, 'U-mark', 'B', sent.threadTs);
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
    slack.say(sent.channel, 'U-mark', 'B', sent.threadTs);
    await ticks(2);
    const before = card(sent.cardId);
    expect(() => inbox.answer(sent.cardId, { choice: 'Yes' })).toThrow(ConflictError);
    expect(card(sent.cardId)).toEqual(before);
  });

  it('answers a follow-up from the reply after it, not from the earlier reply to the first question', async () => {
    const s = scene();
    const task = s.asker();
    const first = await s.send([s.mark], { asker: task, title: 'First?' });
    slack.say(first.channel, 'U-mark', 'A', first.threadTs);
    const second = await s.send([s.mark], { asker: task, title: 'Second?' });
    slack.say(second.channel, 'U-mark', 'B', first.threadTs);
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
    slack.say(sent.channel, 'U-mark', 'B', sent.threadTs);
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
    slack.say(sent.channel, 'U-mark', 'A', sent.threadTs);
    await watch.reconnect();
    await ticks(2);
    expect(card(sent.cardId).answer).toMatchObject({ choice: 'Yes', via: 'slack' });
  });
});

describe('replies typed at the top of the DM', () => {
  it('answers the only open send, recording that it came from the top level', async () => {
    const s = scene();
    const sent = await s.send();
    slack.say(sent.channel, 'U-mark', 'B please');
    await ticks(2);
    expect(send(sent.cardId)).toMatchObject({ state: 'answered', replyVia: 'top_level' });
    expect(card(sent.cardId).answer?.choice).toBe('No');
    expect(slack.posts.filter((p) => p.text.includes('Got it'))).toEqual([]);
  });

  it('ignores a top-level message when the person has no open send, and does not count it later', async () => {
    const s = scene();
    const sent = await s.send();
    slack.say(sent.channel, 'U-mark', 'B');
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
    slack.say(first.channel, 'U-mark', 'A');
    await ticks(3);
    expect(judgeAnswers[0]?.decision).toBe('reply_match');
    expect(card(second.cardId).answer).toMatchObject({ choice: 'Yes', via: 'slack' });
    expect(card(first.cardId).state).toBe('OPEN');
  });

  it('asks which one it is for when the judge cannot say, once, and a number assigns it', async () => {
    const s = scene();
    const first = await s.send([s.mark], { title: 'First?' });
    const second = await s.send([s.mark], { title: 'Second?' });
    slack.say(first.channel, 'U-mark', 'B');
    await ticks(3);
    const asks = () => slack.posts.filter((p) => p.text.startsWith('Which one is this for?'));
    expect(asks()).toHaveLength(1);
    expect(asks()[0]?.text).toContain('1) First?');
    expect(asks()[0]?.text).toContain('2) Second?');
    expect(asks()[0]?.threadTs).toBeUndefined();
    await ticks(2);
    expect(asks()).toHaveLength(1);
    slack.say(first.channel, 'U-mark', '2');
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
    slack.say(first.channel, 'U-mark', 'B');
    await ticks(2);
    const ask = slack.posts.find((p) => p.text.startsWith('Which one is this for?'))?.text ?? '';
    expect(ask).not.toContain('<!channel>');
    expect(ask).not.toContain('<@U123>');
    expect(ask).not.toContain('evil.test');
    expect(ask).toContain('2) A question you were sent: https://slack/');
  });

  it('falls back to asking when the judge is below its floor', async () => {
    const s = scene();
    await s.send([s.mark], { title: 'First?' });
    const second = await s.send([s.mark], { title: 'Second?' });
    judgeReply = answeredWith('1', 0.5);
    slack.say(second.channel, 'U-mark', 'A');
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
    slack.say(sent.channel, 'U-mark', 'A', sent.threadTs);
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
    slack.say(sent.channel, 'U-mark', 'A', sent.threadTs);
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
