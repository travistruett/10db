import { ConflictError, InboxState, JudgeDecision, type PersonId } from '@10db/contracts';
import {
  getInboxItem,
  getJudgeConfig,
  getStakeholderTimers,
  markAnswered,
  markLoneReplyPending,
  markReminded,
  openSends,
  sendForCard,
  setLastRead,
  type OpenSendRow,
} from '@10db/db';
import type { Clock, Timer } from '../clock';
import type { StateStore } from '../events';
import type { InboxService } from '../inbox';
import type { Judge } from '../judge';
import type { Logger } from '../log';
import {
  compareTs,
  SlackError,
  slackRefusedToken,
  type SlackClient,
  type SlackMessage,
} from '../slack';
import { stakeholderOptions } from './compose';
import { conversationState, newMessages, type CountedMessage } from './conversation';
import { reminderLine } from './lines';
import { readReply } from './read-reply';
import type { StakeholderSends } from './sends';
import type { SlackConnection } from './slack-connection';
import { blocksOf } from './slack-text';
import { dueTimers } from './timers';
import { matchReply, type MatchState } from './reply-match';

/** How often open conversations are read. */
export const REPLY_INTERVAL_MS = 60_000;
/** Ticks that fail like this in a row make the connection `unreachable`. */
const UNREACHABLE_AFTER = 3;
/** A tick this many intervals after the last means the Mac slept: it looks again at once. */
const SLEPT_AFTER_INTERVALS = 3;
const TRANSPORT = /^(?:unreachable|timeout|http_5\d\d)$/;

export interface ReplyWatchDeps {
  readonly state: StateStore;
  /** Null when Slack is off: nothing is read. */
  readonly slack: SlackClient | null;
  readonly inbox: Pick<InboxService, 'answerAs'>;
  readonly judge: Judge;
  readonly sends: Pick<StakeholderSends, 'recoverSending'>;
  readonly clock: Clock;
  readonly log: Logger;
  readonly connection: SlackConnection;
  readonly intervalMs?: number;
}

export interface ReplyWatch {
  start(): void;
  /** Stops scheduling and waits for the tick in flight. */
  stop(): Promise<void>;
  tick(): Promise<void>;
  /** The token was set again: checks it and reads on from each send's cursor. */
  reconnect(): Promise<void>;
}

/** One send's slice of a conversation: what was said since its question, from the thread and the DM's top level. */
interface Reading {
  readonly open: OpenSendRow;
  readonly messages: SlackMessage[];
  readonly topLevel: ReadonlySet<string>;
}

export function createReplyWatch(deps: ReplyWatchDeps): ReplyWatch {
  const { state, slack, clock, log, connection } = deps;
  const interval = deps.intervalMs ?? REPLY_INTERVAL_MS;
  let running = false;
  let paused = false;
  let timer: Timer | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  let lastTickAt = clock.now().getTime();
  let notBefore = 0;
  let failures = 0;
  let botUserId: string | null = null;
  /** The newest counted message each send's last tick read: a message no newer than it means quiet. */
  const quiet = new Map<string, string>();
  const matched: MatchState = { assigned: new Map(), asked: new Map() };

  async function identity(client: SlackClient): Promise<string> {
    if (botUserId !== null) return botUserId;
    const found = await client.authTest();
    botUserId = found.botUserId;
    connection.set('connected', { identity: found });
    return botUserId;
  }

  async function reading(
    client: SlackClient,
    opens: OpenSendRow[],
    bot: string,
  ): Promise<Reading[]> {
    const out: Reading[] = [];
    const channels = [...new Set(opens.map((o) => o.channelId))];
    for (const channel of channels) {
      const here = opens
        .filter((o) => o.channelId === channel)
        .sort((a, b) => compareTs(a.messageTs, b.messageTs));
      const oldest = here.map((o) => o.lastReadTs).sort(compareTs)[0] ?? '0';
      const threadMessages = new Map<string, SlackMessage[]>();
      for (const threadTs of new Set(here.map((o) => o.threadTs))) {
        const inThread = here.filter((o) => o.threadTs === threadTs);
        const from = inThread.map((o) => o.lastReadTs).sort(compareTs)[0] ?? oldest;
        threadMessages.set(threadTs, await client.replies(channel, threadTs, from));
      }
      const top = await client.history(channel, oldest);
      const assigned = await matchReply(
        {
          judge: deps.judge,
          slack: client,
          log,
          state: matched,
          titleOf: (o) => getInboxItem(state.db, o.inboxItemId).title,
          floor: () => getJudgeConfig(state.db).decisions[JudgeDecision.ReplyMatch].floor,
        },
        { channel, bot, opens: here, messages: top },
      );
      for (const open of here) {
        const next = here.find(
          (o) => o.threadTs === open.threadTs && compareTs(o.messageTs, open.messageTs) > 0,
        );
        const inWindow = (m: SlackMessage): boolean =>
          compareTs(m.ts, open.messageTs) > 0 &&
          (next === undefined || compareTs(m.ts, next.messageTs) < 0);
        const mine = (threadMessages.get(open.threadTs) ?? []).filter(inWindow);
        const own = top.filter((m) => assigned.get(m.ts) === open.id);
        out.push({
          open,
          messages: [...mine, ...own].sort((a, b) => compareTs(a.ts, b.ts)),
          topLevel: new Set(own.map((m) => m.ts)),
        });
      }
    }
    return out;
  }

  /** Answers the card from a lone recipient's reply, in one transaction with the send's own state. */
  function answer(r: Reading, counted: CountedMessage[], words: string): void {
    const { open } = r;
    const person = open.people.find((p) => p.recipient && p.personId !== null);
    const last = counted.at(-1);
    if (!person?.personId || !last) return;
    const personId: PersonId = person.personId;
    const card = getInboxItem(state.db, open.inboxItemId);
    const read = readReply({ words, messageCount: counted.length }, stakeholderOptions(card));
    const via = r.topLevel.has(last.ts) ? 'top_level' : 'thread';
    try {
      deps.inbox.answerAs(
        card.id,
        { readAs: read.readAs, answer: read.answer, words, conversation: [] },
        {
          personId,
          permalink: sendForCard(state.db, card.id)?.permalink ?? '',
          with: [],
        },
        (ctx) => {
          setLastRead(ctx, open.id, last.ts);
          markAnswered(ctx, open.id, {
            reply: { text: words, userId: person.userId, ts: last.ts },
            readAs: read.readAs,
            answeredBy: personId,
            replyVia: via,
          });
        },
      );
    } catch (error) {
      // Answered some other way meanwhile: the first answer wins and this reply changes nothing.
      if (!(error instanceof ConflictError)) throw error;
      log.info({ sendId: open.id }, 'a reply came after the card was answered');
    }
  }

  function process(r: Reading, bot: string): void {
    const { open } = r;
    const recipients = open.people.filter((p) => p.recipient).map((p) => p.userId);
    const participants = open.people.map((p) => p.userId);
    const counted = newMessages({
      messages: r.messages,
      participants,
      botUserId: bot,
      afterTs: open.messageTs,
    });
    const verdict = conversationState({
      messages: r.messages,
      recipients,
      participants,
      botUserId: bot,
      quietSince: quiet.get(open.id) ?? null,
      now: clock.now(),
      proposal: null,
      settledThroughTs: open.settledThroughTs,
      askedWhichWay:
        open.askedWhichWayAt !== null && open.askedWhichWayTs !== null
          ? { at: new Date(open.askedWhichWayAt), ts: open.askedWhichWayTs }
          : null,
      approvalSeen: null,
      optionCount: stakeholderOptions(getInboxItem(state.db, open.inboxItemId)).length,
    });
    const newest = counted.at(-1);
    if (newest) quiet.set(open.id, newest.ts);
    if (recipients.length !== 1) return;
    if (verdict.kind === 'lone_reply') {
      answer(r, counted, verdict.words);
    } else if (
      verdict.kind === 'waiting' &&
      counted.length > 0 &&
      open.loneReplyPendingSince === null
    ) {
      state.write((ctx) => {
        markLoneReplyPending(ctx, open.id, ctx.now);
      });
    }
  }

  /** Posts the reminder once, unless the thread already holds it; a reminder that comes due is re-checked first. */
  async function remind(client: SlackClient, r: Reading): Promise<void> {
    const timers = getStakeholderTimers(state.db);
    const fresh = openSends(state.db).find((o) => o.id === r.open.id);
    if (!fresh || dueTimers(fresh, timers, clock.now()) !== 'remind') return;
    const already = r.messages.some(
      (m) =>
        m.metadata?.eventType === 'tendb_send' &&
        m.metadata.eventPayload['sendId'] === fresh.id &&
        m.metadata.eventPayload['line'] === 'reminder',
    );
    if (!already) {
      const text = reminderLine();
      await client.post({
        channel: fresh.channelId,
        text,
        blocks: blocksOf(text),
        threadTs: fresh.threadTs,
        metadata: { eventType: 'tendb_send', eventPayload: { sendId: fresh.id, line: 'reminder' } },
      });
    }
    state.write((ctx) => {
      const now = openSends(ctx.tx).find((o) => o.id === fresh.id);
      if (now && dueTimers(now, getStakeholderTimers(ctx.tx), clock.now()) === 'remind')
        markReminded(ctx, fresh.id, clock.now().toISOString());
    });
  }

  async function once(client: SlackClient): Promise<void> {
    try {
      const bot = await identity(client);
      await deps.sends.recoverSending();
      const opens = openSends(state.db);
      for (const r of await reading(client, opens, bot)) {
        const stillOpen = getInboxItem(state.db, r.open.inboxItemId).state === InboxState.Open;
        if (stillOpen) process(r, bot);
        if (openSends(state.db).some((o) => o.id === r.open.id)) await remind(client, r);
      }
      failures = 0;
      if (connection.get().state !== 'connected') connection.set('connected');
    } catch (error) {
      classify(error);
    }
  }

  function classify(error: unknown): void {
    if (!(error instanceof SlackError)) {
      log.warn({ err: error }, 'a reply tick failed');
      return;
    }
    if (slackRefusedToken(error)) {
      connection.set('refused', { error: error.code });
      paused = true;
    } else if (error.code === 'no_token') {
      connection.set('none');
      paused = true;
    } else if (error.code === 'ratelimited') {
      notBefore = clock.now().getTime() + (error.retryAfterSeconds ?? 30) * 1000;
    } else if (TRANSPORT.test(error.code)) {
      failures += 1;
      if (failures >= UNREACHABLE_AFTER) connection.set('unreachable', { error: error.code });
    } else {
      log.warn({ err: error }, 'a conversation could not be read');
    }
  }

  /** A refusal or a removed token can set this during a look, so it is read through a function. */
  const isPaused = (): boolean => paused;

  async function tick(): Promise<void> {
    if (slack === null || paused) return;
    const now = clock.now().getTime();
    if (now < notBefore) return;
    const slept = now - lastTickAt > SLEPT_AFTER_INTERVALS * interval;
    lastTickAt = now;
    await once(slack);
    // After a sleep the first look only finds what was said; a second one finds it quiet.
    if (slept && !isPaused()) await once(slack);
  }

  function schedule(): void {
    if (!running) return;
    timer = clock.setTimeout(() => {
      inFlight = tick().finally(schedule);
    }, interval);
  }

  return {
    tick,
    start() {
      if (running || slack === null) return;
      running = true;
      schedule();
    },
    async stop() {
      running = false;
      timer?.cancel();
      timer = null;
      await inFlight;
    },
    async reconnect() {
      if (slack === null) return;
      botUserId = null;
      failures = 0;
      try {
        await identity(slack);
        paused = false;
      } catch (error) {
        classify(error);
      }
    },
  };
}
