import { InboxState, mintId, ReplyKind, type InboxItemId, type PersonId } from '@10db/contracts';
import {
  createTestStore,
  getInboxItem,
  insertDraft,
  insertInboxItem,
  insertPerson,
  markSending,
  markSent,
  openSends,
  seedProject,
  sendForCard,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { offJudge } from '../../test/engine';
import { createMemoryKeychain } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { slackBotAccount } from '../environment';
import { createEventBus, createStateStore } from '../events';
import type { Judge } from '../judge';
import { silentLogger } from '../log';
import type { AnswerWriter, WrittenAnswer } from './answer-writer';
import { createReplyWatch } from './reply-watch';
import { createSlackClients } from './slack-clients';
import { createSlackConnections } from './slack-connection';
import { saveSlackWorkspace, setProjectSlack } from './slack-workspaces';

const TEAM = 'TA';
const BOT = 'UBOT';
const MARK = 'UMARK';
const CHANNEL = 'D1';
const THREAD = '100.000001';

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

interface Line {
  ts: string;
  user: string;
  text: string;
  metadata?: { event_type: string; event_payload: Record<string, unknown> };
  bot?: true;
}

/** The real store, watch and clients over a fake Slack that keeps one DM thread. */
function world() {
  const clock = new ManualClock();
  const { store, close } = createTestStore(() => clock.now());
  closers.push(close);
  const state = createStateStore(store, createEventBus());
  const keychain = createMemoryKeychain({ [slackBotAccount(TEAM)]: 'xoxb-a' });
  const posted: string[] = [];
  const thread: Line[] = [{ ts: THREAD, user: BOT, text: 'Charge tax?', bot: true }];
  let clockTs = 200;
  const nextTs = (): string => `${String(++clockTs)}.000001`;
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = url.pathname.split('/').pop() ?? '';
    const body: Record<string, unknown> =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    await Promise.resolve();
    if (method === 'auth.test')
      return Response.json({ ok: true, team_id: TEAM, team: 'Alpha', user_id: BOT, user: 'tendb' });
    if (method === 'conversations.replies')
      return Response.json({
        ok: true,
        messages: thread.map((m) => ({
          ts: m.ts,
          thread_ts: THREAD,
          user: m.user,
          text: m.text,
          ...(m.bot ? { bot_id: 'B1' } : {}),
          ...(m.metadata ? { metadata: m.metadata } : {}),
        })),
      });
    if (method === 'conversations.history') return Response.json({ ok: true, messages: [] });
    if (method === 'reactions.get') return Response.json({ ok: true, message: { reactions: [] } });
    if (method === 'chat.postMessage') {
      const metadata = body['metadata'] as Line['metadata'];
      const ts = nextTs();
      thread.push({
        ts,
        user: BOT,
        text: String(body['text']),
        bot: true,
        ...(metadata ? { metadata } : {}),
      });
      posted.push(String(body['text']));
      return Response.json({ ok: true, ts });
    }
    return Response.json({ ok: false, error: 'unknown_method' });
  };
  const slack = createSlackClients({ state, keychain, fetch: fakeFetch, clock, timeoutMs: 5_000 });
  state.write((ctx) => {
    saveSlackWorkspace(ctx, { teamId: TEAM, teamName: 'Alpha' });
  });
  const client = slack.clientFor(TEAM);
  if (client === null) throw new Error('no client');
  const project = seedProject(store, { name: 'demo' });
  state.write((ctx) => {
    setProjectSlack(ctx, project.id, TEAM);
  });
  const mark: PersonId = state.write((ctx) =>
    insertPerson(ctx, {
      handle: 'mark',
      name: 'Mark',
      slack: [{ teamId: TEAM, userId: MARK, sendMode: 'auto', dailyLimit: 10 }],
    }),
  ).id;
  /** A question already sent to Mark in the DM. */
  const sentCard = (): InboxItemId =>
    store.write((ctx) => {
      const card = insertInboxItem(ctx, {
        projectId: project.id,
        kind: 'question',
        title: 'Charge tax?',
        body: '',
        options: [],
        recommendation: null,
        category: 'product',
        urgency: 'normal',
        detail: null,
        foldKey: null,
        targets: [],
      });
      const draft = insertDraft(ctx, {
        inboxItemId: card.id,
        teamId: TEAM,
        recipients: [mark],
        text: 'Charge tax?',
        hits: [],
      });
      markSending(ctx, draft.id, {
        textSha256: 'x',
        threadTs: null,
        startedAt: clock.now().toISOString(),
      });
      markSent(ctx, draft.id, {
        channelId: CHANNEL,
        threadTs: THREAD,
        messageTs: THREAD,
        permalink: null,
        at: clock.now().toISOString(),
      });
      return card.id;
    }).value;
  const answered: unknown[] = [];
  const makeWatch = (judge: Judge, answerWriter: AnswerWriter) =>
    createReplyWatch({
      state,
      teamId: TEAM,
      slack: client,
      inbox: {
        answerAs: (...args) => {
          answered.push(args);
          throw new Error('answerAs is a fake; the card is not answered here');
        },
      },
      judge,
      sends: { recoverSending: () => Promise.resolve(), closingTextFor: () => null },
      clock,
      log: silentLogger,
      connections: createSlackConnections({ state, off: false }),
      answerWriter,
      matched: { assigned: new Map(), asked: new Map() },
    });
  /** What Mark writes; two ticks after it make the conversation quiet. */
  const say = (text: string): string => {
    const ts = nextTs();
    thread.push({ ts, user: MARK, text });
    return ts;
  };
  /** A line 10db already posted for a send, as Slack keeps it. */
  const botLine = (sendId: string, line: string, key: string): void => {
    thread.push({
      ts: nextTs(),
      user: BOT,
      text: 'an answer',
      bot: true,
      metadata: { event_type: 'tendb_send', event_payload: { sendId, line, key } },
    });
  };
  const lines = (line: string) => thread.filter((m) => m.metadata?.event_payload['line'] === line);
  return {
    state,
    project,
    makeWatch,
    sentCard,
    say,
    botLine,
    thread,
    lines,
    posted,
    answered,
    clock,
  };
}

const judging = (kind: ReplyKind, confidence: number): Judge => ({
  off: false,
  ready: () => Promise.resolve(true),
  choose: () =>
    Promise.resolve({
      kind: 'answered',
      choice: kind,
      confidence,
      model: 'fake',
      latencyMs: 1,
      costUsd: null,
      callId: mintId('JudgeCall'),
    }),
});

const answering =
  (text: string, onCall?: () => void): AnswerWriter =>
  () => {
    onCall?.();
    const written: WrittenAnswer = { kind: 'answer', text };
    return Promise.resolve(written);
  };

describe('a stakeholder reply is sorted before it answers the card', () => {
  it('a question with no judge goes to the builder, not in as the answer', async () => {
    const w = world();
    const id = w.sentCard();
    const watch = w.makeWatch(offJudge, answering('unused'));
    w.say('what is this for?');
    await watch.tick();
    await watch.tick();

    expect(w.answered).toHaveLength(0);
    expect(getInboxItem(w.state.db, id).state).toBe(InboxState.Open);
    expect(sendForCard(w.state.db, id)).toMatchObject({
      state: 'sent',
      returnedReason: 'asked',
      asked: { userId: MARK, text: 'what is this for?' },
    });
  });

  it('posts at most three automated answers, keyed, and never where Slack went Off', async () => {
    const w = world();
    const id = w.sentCard();
    const watch = w.makeWatch(judging(ReplyKind.SimpleQuestion, 0.9), answering('It is for tax.'));
    for (const question of ['what is B?', 'and C?', 'and D?']) {
      const ts = w.say(question);
      await watch.tick();
      await watch.tick();
      expect(w.lines('auto_answer').at(-1)?.metadata?.event_payload['key']).toBe(ts);
    }
    expect(w.lines('auto_answer')).toHaveLength(3);
    expect(sendForCard(w.state.db, id)).toMatchObject({ autoAnswers: 3, asked: null });
    expect(getInboxItem(w.state.db, id).state).toBe(InboxState.Open);

    w.say('and E?');
    await watch.tick();
    await watch.tick();
    expect(w.lines('auto_answer')).toHaveLength(3);
    expect(sendForCard(w.state.db, id)).toMatchObject({
      returnedReason: 'asked',
      asked: { declined: 'cap' },
    });

    // A fresh send whose project's Slack goes Off while the writer is answering.
    const other = world();
    const otherId = other.sentCard();
    const turnOff = answering('It is for tax.', () => {
      other.state.write((ctx) => {
        setProjectSlack(ctx, other.project.id, null);
      });
    });
    const otherWatch = other.makeWatch(judging(ReplyKind.SimpleQuestion, 0.9), turnOff);
    other.say('what is B?');
    await otherWatch.tick();
    await otherWatch.tick();
    expect(other.lines('auto_answer')).toHaveLength(0);
    expect(openSends(other.state.db)[0]).toMatchObject({
      autoAnswers: 0,
      asked: null,
      returnedReason: null,
      handledThroughTs: null,
    });
    expect(sendForCard(other.state.db, otherId)).toMatchObject({ state: 'sent' });
  });

  it('a crash after the post finds the line and only records it', async () => {
    const w = world();
    const id = w.sentCard();
    const first = w.say('what is B?');
    w.botLine(sendForCard(w.state.db, id)?.id ?? '', 'auto_answer', first);
    const last = w.say('and C?');
    const watch = w.makeWatch(judging(ReplyKind.SimpleQuestion, 0.9), answering('unused'));
    await watch.tick();
    await watch.tick();

    expect(w.posted).toHaveLength(0);
    expect(openSends(w.state.db)[0]).toMatchObject({
      autoAnswers: 1,
      handledThroughTs: last,
      lastReadTs: THREAD,
    });
  });
});
