import {
  ConflictError,
  InboxState,
  JudgeDecision,
  type InboxItemId,
  type PersonId,
} from '@10db/contracts';
import {
  getInboxItem,
  getJudgeConfig,
  getStakeholderTimers,
  markAnswered,
  markApprovalSeen,
  markLoneReplyPending,
  setProposal,
  threadStarts,
  markReminded,
  openSends,
  sendForCard,
  setLastRead,
  type DbReader,
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
import {
  answerAgreed,
  judgeApprovals,
  returnDisagreed,
  settleConversation,
  type AgreeDeps,
  type Conversation,
} from './agree';
import { bringIn } from './bring-in';
import { stakeholderOptions } from './compose';
import { conversationState, newMessages } from './conversation';
import { escapeMrkdwn } from './escape';
import { reminderLine } from './lines';
import { scanOutbound } from './outbound-scan';
import { readReply } from './read-reply';
import type { StakeholderSends } from './sends';
import type { SlackConnection } from './slack-connection';
import { blocksOf } from './slack-text';
import { dueTimers } from './timers';
import { matchReply, type MatchState } from './reply-match';
import { loadMatchState, saveMatchState } from './reply-match-store';

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
  readonly sends: Pick<StakeholderSends, 'recoverSending' | 'closingTextFor'>;
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
  /** What was said since the question, from the thread, the DM's top level and the thread it moved from. */
  readonly messages: SlackMessage[];
  /** Everything in the current thread, 10db's own lines included. */
  readonly thread: SlackMessage[];
  readonly topLevel: ReadonlySet<string>;
}

/** The messages once each, oldest first: a move can read the same thread from both its places. */
function dedupe(messages: readonly SlackMessage[]): SlackMessage[] {
  return [...new Map(messages.map((m) => [m.ts, m])).values()].sort((a, b) =>
    compareTs(a.ts, b.ts),
  );
}

/** The first `ts` of a conversation: the question's own, or where it started before it moved. */
const floorOf = (open: OpenSendRow): string => open.movedFrom?.messageTs ?? open.messageTs;

const firstAfter = (starts: readonly string[], ts: string): string | undefined =>
  starts.filter((t) => compareTs(t, ts) > 0).sort(compareTs)[0];

/**
 * How a sent question is named in a line posted to Slack: its title, escaped and cut, or a link to the message
 * when the outbound scan holds the title (a URL, a secret). The line goes to a person, so it follows the
 * rules every outbound text follows.
 */
function questionLabel(db: DbReader, open: OpenSendRow): string {
  const { title } = getInboxItem(db, open.inboxItemId);
  const held = scanOutbound(title).some((hit) => hit.severity === 'hold');
  const link = sendForCard(db, open.inboxItemId)?.permalink;
  if (held) return link ? `A question you were sent: ${link}` : 'A question you were sent';
  return escapeMrkdwn(title).slice(0, 120);
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
  const matched: MatchState = loadMatchState(state);

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
          titleOf: (o) => questionLabel(state.db, o),
          floor: () => getJudgeConfig(state.db).decisions[JudgeDecision.ReplyMatch].floor,
        },
        { channel, bot, opens: here, messages: top },
      );
      saveMatchState(state, matched);
      for (const open of here) {
        // Only what was said after this send's own question, and before the next question in that thread.
        const within = (from: string, until: string | undefined) => (m: SlackMessage) =>
          compareTs(m.ts, from) > 0 && (until === undefined || compareTs(m.ts, until) < 0);
        const inCurrent = within(
          open.messageTs,
          firstAfter(threadStarts(state.db, open.channelId, open.threadTs), open.messageTs),
        );
        const thread = threadMessages.get(open.threadTs) ?? [];
        const old = open.movedFrom
          ? await client.replies(
              open.movedFrom.channelId,
              open.movedFrom.threadTs,
              open.movedFrom.lastReadTs ?? open.movedFrom.threadTs,
            )
          : [];
        const inOld = open.movedFrom
          ? within(
              open.movedFrom.messageTs,
              firstAfter(
                threadStarts(state.db, open.movedFrom.channelId, open.movedFrom.threadTs),
                open.movedFrom.messageTs,
              ),
            )
          : () => false;
        const own = top.filter((m) => assigned.get(m.ts) === open.id);
        out.push({
          open,
          messages: dedupe([...thread.filter(inCurrent), ...old.filter(inOld), ...own]),
          thread,
          topLevel: new Set(own.map((m) => m.ts)),
        });
      }
    }
    return out;
  }

  const judged = new Map<string, boolean>();

  const agreeDeps = (client: SlackClient): AgreeDeps => ({
    client,
    state,
    judge: deps.judge,
    inbox: deps.inbox,
    clock,
    log,
  });

  /** Answers the card from a lone recipient's reply, in one transaction with the send's own state. */
  function answerLone(c: Conversation, words: string): void {
    const { open } = c;
    const person = open.people.find((p) => p.recipient && p.personId !== null);
    const last = c.counted.at(-1);
    if (!person?.personId || !last) return;
    const personId: PersonId = person.personId;
    const read = readReply(
      { words, messageCount: c.counted.filter((m) => m.userId === person.userId).length },
      stakeholderOptions(c.card),
    );
    const via = c.topLevel.has(last.ts) ? 'top_level' : 'thread';
    // After a "which way" line the whole conversation is quoted to the lane, not only his words.
    const conversation =
      open.askedWhichWayAt === null
        ? []
        : c.counted.map((m) => ({
            name: open.people.find((p) => p.userId === m.userId)?.name ?? m.userId,
            text: m.text,
          }));
    try {
      deps.inbox.answerAs(
        c.card.id,
        { readAs: read.readAs, answer: read.answer, words, conversation },
        {
          personId,
          permalink: sendForCard(state.db, c.card.id)?.permalink ?? '',
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

  const personIdOf = (open: OpenSendRow, userId: string): PersonId | null =>
    open.people.find((p) => p.userId === userId)?.personId ?? null;

  async function process(client: SlackClient, r: Reading, bot: string): Promise<void> {
    const { open } = r;
    const card = getInboxItem(state.db, open.inboxItemId);
    // Someone mentioned in the conversation is brought in; the move settles again on the next tick.
    if (
      await bringIn(
        {
          client,
          state,
          log,
          closingFor: (id) => deps.sends.closingTextFor(id as InboxItemId),
        },
        { open, messages: r.messages, thread: r.thread, bot },
      )
    )
      return;
    const recipients = open.people.filter((p) => p.recipient).map((p) => p.userId);
    const participants = open.people.map((p) => p.userId);
    const counted = newMessages({
      messages: r.messages,
      participants,
      botUserId: bot,
      afterTs: floorOf(open),
    });
    const conversation: Conversation = {
      open,
      card,
      counted,
      thread: r.thread,
      topLevel: r.topLevel,
    };
    const proposal = open.proposal;
    const reactions =
      proposal !== null && proposal.ts !== null
        ? await client.reactions(open.channelId, proposal.ts)
        : [];
    const approver =
      open.approvalBy === null ? null : open.people.find((p) => p.personId === open.approvalBy);
    // Once someone is brought in, what was said before the move is context for the judge, not a reply:
    // the mention that brought them in must not answer the card as the recipient's own words.
    const sinceMove =
      open.movedFrom === null
        ? r.messages
        : r.messages.filter((m) => compareTs(m.ts, open.messageTs) > 0);
    const verdict = conversationState({
      messages: sinceMove,
      recipients,
      participants,
      botUserId: bot,
      quietSince: quiet.get(open.id) ?? null,
      now: clock.now(),
      proposal:
        proposal !== null && proposal.ts !== null
          ? { ts: proposal.ts, letter: proposal.choice, reactions }
          : null,
      settledThroughTs: open.settledThroughTs,
      askedWhichWay:
        open.askedWhichWayAt !== null && open.askedWhichWayTs !== null
          ? { at: new Date(open.askedWhichWayAt), ts: open.askedWhichWayTs }
          : null,
      approvalSeen:
        open.approvalSeenAt !== null && approver
          ? { at: open.approvalSeenAt, by: approver.userId }
          : null,
      optionCount: stakeholderOptions(card).length,
      afterDisagreement: open.returnedReason === 'disagreed',
      judgedApprovals: await judgeApprovals(agreeDeps(client), conversation, judged),
    });
    const newest = counted.at(-1);
    const countedSinceMove =
      open.movedFrom === null
        ? counted
        : counted.filter((m) => compareTs(m.ts, open.messageTs) > 0);
    const newestSinceMove = countedSinceMove.at(-1);
    if (newestSinceMove) quiet.set(open.id, newestSinceMove.ts);
    const agree = agreeDeps(client);
    switch (verdict.kind) {
      case 'lone_reply':
        if (recipients.length === 1) answerLone(conversation, verdict.words);
        break;
      case 'settled':
        await settleConversation(agree, conversation);
        break;
      case 'approval_seen': {
        const by = personIdOf(open, verdict.by);
        if (by !== null)
          state.write((ctx) => {
            markApprovalSeen(ctx, open.id, {
              at: newest?.ts ?? proposal?.ts ?? open.messageTs,
              by,
            });
          });
        break;
      }
      case 'approval_lost':
        state.write((ctx) => {
          markApprovalSeen(ctx, open.id, null);
        });
        break;
      case 'approved':
        answerAgreed(agree, conversation, {
          by: verdict.by,
          letter: proposal?.choice ?? '',
          readAs: 'approved',
        });
        break;
      case 'picked':
        answerAgreed(agree, conversation, {
          by: verdict.by,
          letter: verdict.choice,
          readAs: 'option',
        });
        break;
      case 'disagreed':
        returnDisagreed(agree, open, newest?.ts ?? null);
        break;
      case 'withdrawn':
        state.write((ctx) => {
          setProposal(ctx, open.id, null);
          markApprovalSeen(ctx, open.id, null);
        });
        break;
      case 'waiting':
        if (
          recipients.length === 1 &&
          countedSinceMove.length > 0 &&
          open.loneReplyPendingSince === null
        )
          state.write((ctx) => {
            markLoneReplyPending(ctx, open.id, ctx.now);
          });
        break;
      default: {
        const unreachable: never = verdict;
        return unreachable;
      }
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
        if (stillOpen) await process(client, r, bot);
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
