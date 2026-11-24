import {
  ConflictError,
  InboxState,
  JudgeDecision,
  JudgeOutcome,
  ReplyKind,
  SendFailure,
  type AskedQuestion,
  type InboxItemId,
  type PersonId,
} from '@10db/contracts';
import {
  getInboxItem,
  getJudgeConfig,
  getStakeholderTimers,
  markAnswered,
  markApprovalSeen,
  markAsked,
  markHandled,
  markLoneReplyPending,
  recordAutoAnswer,
  recordJudgeOutcome,
  setProposal,
  threadStarts,
  markReminded,
  openSends,
  sendForCard,
  setLastRead,
  type DbReader,
  type OpenSendRow,
  type WriteContext,
} from '@10db/db';
import type { Clock, Timer } from '../clock';
import type { AnswerWriter } from './answer-writer';
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
import { findLine, postLine, SEND_EVENT } from './bot-lines';
import { stakeholderOptions } from './compose';
import { conversationState, newMessages, onLoneBranch } from './conversation';
import { draftContext } from './drafts';
import { escapeMrkdwn } from './escape';
import { OPTION_LETTERS } from './letters';
import { askedAckLine, automatedAnswerLine, reminderLine } from './lines';
import { classifyReply, type ReplyKindRead } from './reply-kind';
import { scanOutbound } from './outbound-scan';
import { readReply } from './read-reply';
import type { StakeholderSends } from './sends';
import { failSendsToBuilder, recordBot } from './send-returns';
import type { SlackConnections } from './slack-connection';
import { boundTeam, projectSlack } from './slack-workspaces';
import { dueTimers } from './timers';
import { matchReply, type MatchState } from './reply-match';
import { saveMatchState } from './reply-match-store';

/** How often open conversations are read. */
export const REPLY_INTERVAL_MS = 60_000;
/** Ticks that fail like this in a row make the connection `unreachable`. */
const UNREACHABLE_AFTER = 3;
/** A tick this many intervals after the last means the Mac slept: it looks again at once. */
const SLEPT_AFTER_INTERVALS = 3;
/** Slack's words for a thread, message or channel that no longer exists or can no longer be read. */
const GONE: ReadonlySet<string> = new Set([
  'thread_not_found',
  'message_not_found',
  'channel_not_found',
  'is_archived',
  'not_in_channel',
]);

export interface ReplyWatchDeps {
  readonly state: StateStore;
  /** The workspace this watch reads. */
  readonly teamId: string;
  /** The workspace's own client. */
  readonly slack: SlackClient;
  readonly inbox: Pick<InboxService, 'answerAs'>;
  readonly judge: Judge;
  readonly sends: Pick<StakeholderSends, 'recoverSending' | 'closingTextFor'>;
  readonly clock: Clock;
  readonly log: Logger;
  readonly connections: SlackConnections;
  /** Writes the answer to a simple question. */
  readonly answerWriter: AnswerWriter;
  /** Shared by every watch; saved after each tick. */
  readonly matched: MatchState;
  readonly intervalMs?: number;
}

export interface ReplyWatch {
  start(): void;
  /** Stops scheduling and waits for the tick in flight. */
  stop(): Promise<void>;
  tick(): Promise<void>;
  /** The token was set again: waits for the tick in flight, checks the token and reads on from each send's cursor. */
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

/** The most replies a group's messages are sorted in one tick. */
const SORTED_PER_TICK = 5;
/** The longest question kept for the builder. */
const ASKED_LIMIT = 4000;

/** What a participant said that is sorted as one reply: a lone recipient's joined words, or one group message. */
interface Reply {
  readonly words: string;
  readonly messageCount: number;
  readonly firstTs: string;
  readonly lastTs: string;
  readonly userId: string;
  readonly name: string;
}

/** The judge call's outcome when the sorter used one: a rule fallback below the floor, else acted on. */
const outcomeOf = (read: ReplyKindRead): JudgeOutcome =>
  read.source === 'rule' ? JudgeOutcome.BelowFloor : JudgeOutcome.Acted;

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
  const { state, slack, clock, log, connections, teamId, matched } = deps;
  const interval = deps.intervalMs ?? REPLY_INTERVAL_MS;
  let running = false;
  let stopped = false;
  let paused = false;
  let timer: Timer | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  /** Aborted by `stop()`, so shutdown never waits out the answer writer. */
  const shutdown = new AbortController();
  let lastTickAt = clock.now().getTime();
  let notBefore = 0;
  let failures = 0;
  let botUserId: string | null = null;
  /** The newest counted message each send's last tick read: a message no newer than it means quiet. */
  const quiet = new Map<string, string>();
  const handledMentions = new Set<string>();

  async function identity(client: SlackClient): Promise<string> {
    if (botUserId !== null) return botUserId;
    const found = await client.authTest();
    // A token for another team than this watch's is a refusal; no bot is recorded on this team's entry.
    if (found.teamId !== teamId) throw new SlackError('auth.test', 'invalid_auth');
    botUserId = found.botUserId;
    // A check never recovers: a bot that changed under a saved token was recorded with that token.
    state.write((ctx) => {
      recordBot(ctx, found, 'check');
    });
    connections.set(teamId, 'connected', { identity: found });
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
      const lost = new Set<string>();
      for (const threadTs of new Set(here.map((o) => o.threadTs))) {
        const inThread = here.filter((o) => o.threadTs === threadTs);
        const from = inThread.map((o) => o.lastReadTs).sort(compareTs)[0] ?? oldest;
        const read = await guard(inThread, () => client.replies(channel, threadTs, from));
        if (read === null) for (const o of inThread) lost.add(o.id);
        else threadMessages.set(threadTs, read);
      }
      const live = here.filter((o) => !lost.has(o.id));
      if (live.length === 0) continue;
      const top = await guard(live, () => client.history(channel, oldest));
      if (top === null) continue;
      const assigned = await matchReply(
        {
          judge: deps.judge,
          slack: client,
          log,
          state: matched,
          titleOf: (o) => questionLabel(state.db, o),
          floor: () => getJudgeConfig(state.db).decisions[JudgeDecision.ReplyMatch].floor,
        },
        { channel, bot, opens: live, messages: top },
      );
      saveMatchState(state, matched);
      for (const open of live) {
        // Only what was said after this send's own question, and before the next question in that thread.
        const within = (from: string, until: string | undefined) => (m: SlackMessage) =>
          compareTs(m.ts, from) > 0 && (until === undefined || compareTs(m.ts, until) < 0);
        const inCurrent = within(
          open.messageTs,
          firstAfter(threadStarts(state.db, open.channelId, open.threadTs), open.messageTs),
        );
        const thread = threadMessages.get(open.threadTs) ?? [];
        const movedFrom = open.movedFrom;
        const old = movedFrom
          ? await guard([open], () =>
              client.replies(
                movedFrom.channelId,
                movedFrom.threadTs,
                movedFrom.lastReadTs ?? movedFrom.threadTs,
              ),
            )
          : [];
        if (old === null) continue;
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

  const judged = new Map<string, boolean | null>();

  const agreeDeps = (client: SlackClient): AgreeDeps => ({
    client,
    state,
    judge: deps.judge,
    inbox: deps.inbox,
    clock,
    log,
  });

  /**
   * What the lane is told was said: after a "which way" line, a sorted reply or any line 10db or the builder
   * posted, the whole exchange (the participants' messages and those lines, in order), else nothing beyond the words.
   */
  function quotedExchange(c: Conversation): { name: string; text: string }[] {
    const { open } = c;
    const builder = draftContext(state.db, c.card).builderName;
    const lines = c.thread.flatMap((m) => {
      const payload =
        m.user === c.bot && m.metadata?.eventType === SEND_EVENT ? m.metadata.eventPayload : null;
      if (payload?.['sendId'] !== open.id || compareTs(m.ts, floorOf(open)) <= 0) return [];
      if (payload['line'] === 'auto_answer')
        return [{ ts: m.ts, name: '10db (automated)', text: m.text }];
      if (payload['line'] === 'builder_reply') return [{ ts: m.ts, name: builder, text: m.text }];
      return [];
    });
    if (open.askedWhichWayAt === null && open.handledThroughTs === null && lines.length === 0)
      return [];
    const said = c.counted.map((m) => ({
      ts: m.ts,
      name: open.people.find((p) => p.userId === m.userId)?.name ?? m.userId,
      text: m.text,
    }));
    return [...said, ...lines]
      .sort((a, b) => compareTs(a.ts, b.ts))
      .map(({ name, text }) => ({ name, text }));
  }

  /** Answers the card from a lone recipient's reply, in one transaction with the send's own state. */
  function answerLone(c: Conversation, reply: { words: string; messageCount: number }): boolean {
    const { words } = reply;
    const { open } = c;
    const person = open.people.find((p) => p.recipient && p.personId !== null);
    const last = c.counted.at(-1);
    if (!person?.personId || !last) return false;
    const personId: PersonId = person.personId;
    // The reply is the messages the conversation reader joined, not everything he ever wrote.
    const read = readReply({ words, messageCount: reply.messageCount }, stakeholderOptions(c.card));
    const via = c.topLevel.has(last.ts) ? 'top_level' : 'thread';
    const conversation = quotedExchange(c);
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
    return true;
  }

  const currentOpen = (id: OpenSendRow['id']): OpenSendRow | undefined =>
    openSends(state.db, teamId).find((o) => o.id === id);

  /** One write for a route's own change and the sorting judge call's outcome. */
  function recordRoute(read: ReplyKindRead, write: (ctx: WriteContext) => void): void {
    state.write((ctx) => {
      write(ctx);
      if (read.callId !== null) recordJudgeOutcome(ctx, read.callId, outcomeOf(read));
    });
  }

  /** The binding is the send's own and Slack is on for the project. */
  const bindingIntact = (c: Conversation): boolean =>
    boundTeam(state.db, c.card.projectId) === c.open.teamId &&
    projectSlack(state.db, c.card.projectId).teamId !== null;

  /**
   * The question goes to the builder: the send is returned (or keeps its return) with the question on it, and
   * the thread is told once per question, when the binding allows a post.
   */
  async function ask(
    client: SlackClient,
    c: Conversation,
    reply: Reply,
    read: ReplyKindRead,
    declined: AskedQuestion['declined'],
    acknowledge = true,
  ): Promise<void> {
    recordRoute(read, (ctx) => {
      markAsked(ctx, c.open.id, {
        asked: {
          userId: reply.userId,
          name: reply.name,
          text: reply.words.slice(0, ASKED_LIMIT),
          ts: reply.lastTs,
          declined,
        },
        throughTs: reply.lastTs,
      });
    });
    const { open } = c;
    const key = reply.firstTs;
    if (
      !acknowledge ||
      !bindingIntact(c) ||
      findLine(c.thread, open.id, 'asked_ack', { bot: c.bot, key })
    )
      return;
    const text = askedAckLine(draftContext(state.db, c.card).builderName);
    if (scanOutbound(text).some((hit) => hit.severity === 'hold')) return;
    try {
      await postLine(client, {
        channel: open.channelId,
        threadTs: open.threadTs,
        text,
        sendId: open.id,
        line: 'asked_ack',
        key,
      });
    } catch (error) {
      // The question already reached the builder; a missed acknowledgement costs only a line.
      log.warn(
        { err: error, sendId: open.id },
        'the thread could not be told the question was passed on',
      );
    }
  }

  /**
   * Answers a simple question in the thread from the card, once per question. Any step that fails sends the
   * question to the builder; a change while the answer was being written posts nothing and leaves the reply for
   * the next tick.
   */
  async function autoAnswer(
    client: SlackClient,
    c: Conversation,
    reply: Reply,
    read: ReplyKindRead,
  ): Promise<void> {
    const { open, card } = c;
    const bound = (): boolean => bindingIntact(c);
    if (!bound()) {
      await ask(client, c, reply, read, 'slack_unavailable');
      return;
    }
    // The reply's first message keys the line: it holds if more is written before a restart.
    const key = reply.firstTs;
    const earlier = findLine(c.thread, open.id, 'auto_answer', { bot: c.bot, key });
    // What the cursor passes: the whole reply, or after a crash only what was said before the line that
    // already answered it, so a later message is sorted on its own.
    let through = reply.lastTs;
    if (earlier !== undefined) {
      through =
        c.counted
          .filter(
            (m) =>
              compareTs(m.ts, reply.firstTs) >= 0 &&
              compareTs(m.ts, reply.lastTs) <= 0 &&
              compareTs(m.ts, earlier.ts) < 0,
          )
          .at(-1)?.ts ?? reply.firstTs;
    } else {
      const written = await deps.answerWriter({
        cardId: card.id,
        question: reply.words.slice(0, ASKED_LIMIT),
        askerName: reply.name,
        signal: shutdown.signal,
      });
      if (shutdown.signal.aborted) return;
      const now = currentOpen(open.id);
      if (
        now?.returnedAt !== null ||
        now.handledThroughTs !== open.handledThroughTs ||
        getInboxItem(state.db, card.id).state !== InboxState.Open ||
        !bound()
      )
        return;
      if (written.kind !== 'answer') {
        await ask(client, c, reply, read, written.reason);
        return;
      }
      const letters = stakeholderOptions(card)
        .slice(0, OPTION_LETTERS.length)
        .map((_o, i) => OPTION_LETTERS[i] ?? '');
      const text = automatedAnswerLine(
        written.text,
        letters,
        draftContext(state.db, card).builderName,
      );
      if (scanOutbound(text).some((hit) => hit.severity === 'hold')) {
        await ask(client, c, reply, read, 'held');
        return;
      }
      try {
        await postLine(client, {
          channel: open.channelId,
          threadTs: open.threadTs,
          text,
          sendId: open.id,
          line: 'auto_answer',
          key,
        });
      } catch (error) {
        // What is wrong with the whole connection or conversation is the tick's; a post that failed alone
        // is this question's, which then goes to the builder rather than being tried (and billed) again.
        if (
          error instanceof SlackError &&
          (slackRefusedToken(error) ||
            error.code === 'no_token' ||
            error.code === 'ratelimited' ||
            GONE.has(error.code))
        )
          throw error;
        log.warn({ err: error, sendId: open.id }, 'an automated answer could not be posted');
        await ask(client, c, reply, read, 'failed');
        return;
      }
    }
    recordRoute(read, (ctx) => {
      recordAutoAnswer(ctx, open.id, through);
    });
  }

  /** The master switch or the Reply Kind switch was turned off, as against no account to run it on. */
  function replyKindSwitchedOff(): boolean {
    const config = getJudgeConfig(state.db);
    return !config.enabled || !config.decisions[JudgeDecision.ReplyKind].enabled;
  }

  /**
   * Sorts one reply and acts on it. True when it answers the card (the caller answers it); anything else is
   * done here: chatter is handled, a question is answered or goes to the builder. A returned send never
   * auto-answers.
   */
  async function sortReply(
    client: SlackClient,
    c: Conversation,
    reply: Reply,
    group: boolean,
  ): Promise<boolean> {
    const read = await classifyReply(
      {
        judge: deps.judge,
        floor: () => getJudgeConfig(state.db).decisions[JudgeDecision.ReplyKind].floor,
        log,
      },
      {
        card: c.card,
        words: reply.words,
        messageCount: reply.messageCount,
        author: reply.name,
        group,
      },
    );
    switch (read.kind) {
      case ReplyKind.Answer:
        if (!group) {
          if (read.callId !== null) recordRoute(read, () => undefined);
          return true;
        }
        recordRoute(read, (ctx) => {
          markHandled(ctx, c.open.id, reply.lastTs);
        });
        return false;
      case ReplyKind.Chatter:
        recordRoute(read, (ctx) => {
          markHandled(ctx, c.open.id, reply.lastTs);
        });
        return false;
      case ReplyKind.BuilderQuestion:
        await ask(client, c, reply, read, null);
        return false;
      case ReplyKind.SimpleQuestion:
        if (replyKindSwitchedOff()) {
          // Switched off on purpose: nothing is posted, not even an acknowledgement.
          await ask(client, c, reply, read, null, false);
        } else if (c.open.returnedAt !== null) await ask(client, c, reply, read, null);
        else await autoAnswer(client, c, reply, read);
        return false;
      default: {
        const unreachable: never = read.kind;
        return unreachable;
      }
    }
  }

  /** A conflict means the send moved: this send's turn ends, and the other sends go on. */
  async function turn(open: OpenSendRow, run: () => Promise<void> | void): Promise<boolean> {
    try {
      await run();
      return true;
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      log.warn({ sendId: open.id, err: error }, 'a reply could not be recorded; the send moved');
      return false;
    }
  }

  /** In a group, each participant message is sorted on its own, oldest first, a few a tick. */
  async function sortGroup(client: SlackClient, c: Conversation): Promise<void> {
    if (!(await deps.judge.ready(JudgeDecision.ReplyKind))) return;
    let sorted = 0;
    // After a bring-in, what was said before the move (the mention that brought someone in) is context.
    const { movedFrom, messageTs } = c.open;
    const sayings =
      movedFrom === null ? c.counted : c.counted.filter((m) => compareTs(m.ts, messageTs) > 0);
    for (const m of sayings) {
      if (sorted >= SORTED_PER_TICK) return;
      const open = currentOpen(c.open.id);
      if (open === undefined) return;
      if (open.handledThroughTs !== null && compareTs(m.ts, open.handledThroughTs) <= 0) continue;
      sorted += 1;
      const reply: Reply = {
        words: m.text,
        messageCount: 1,
        firstTs: m.ts,
        lastTs: m.ts,
        userId: m.userId,
        name: open.people.find((p) => p.userId === m.userId)?.name ?? m.userId,
      };
      const ok = await turn(open, async () => {
        await sortReply(client, { ...c, open }, reply, true);
      });
      if (!ok) return;
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
          handled: handledMentions,
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
      bot,
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
    const verdictInput = {
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
      handledThroughTs: open.handledThroughTs,
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
    };
    // A group's messages are each sorted before the conversation settles as it always has.
    if (!onLoneBranch(verdictInput) && proposal === null) await sortGroup(client, conversation);
    const verdict = conversationState(verdictInput);
    const newest = counted.at(-1);
    const countedSinceMove =
      open.movedFrom === null
        ? counted
        : counted.filter((m) => compareTs(m.ts, open.messageTs) > 0);
    const newestSinceMove = countedSinceMove.at(-1);
    const unhandled =
      open.handledThroughTs === null
        ? countedSinceMove
        : countedSinceMove.filter((m) => compareTs(m.ts, open.handledThroughTs ?? '0') > 0);
    if (newestSinceMove) quiet.set(open.id, newestSinceMove.ts);
    const agree = agreeDeps(client);
    switch (verdict.kind) {
      case 'lone_reply': {
        const person = open.people.find((p) => p.recipient);
        if (recipients.length !== 1 || !person) break;
        await turn(open, async () => {
          const reply: Reply = { ...verdict, userId: person.userId, name: person.name };
          if (await sortReply(client, conversation, reply, false))
            if (!answerLone(conversation, verdict))
              // No one to answer as: it is sorted once and not again every tick.
              state.write((ctx) => {
                markHandled(ctx, open.id, verdict.lastTs);
              });
        });
        break;
      }
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
        if (recipients.length === 1 && unhandled.length > 0 && open.loneReplyPendingSince === null)
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
  async function remind(client: SlackClient, r: Reading, bot: string): Promise<void> {
    const timers = getStakeholderTimers(state.db);
    const fresh = openSends(state.db, teamId).find((o) => o.id === r.open.id);
    if (!fresh || dueTimers(fresh, timers, clock.now()) !== 'remind') return;
    // A send in another team than the stored binding is taken back, never reminded (only a race leaves one).
    const owner = getInboxItem(state.db, fresh.inboxItemId);
    if (fresh.teamId !== boundTeam(state.db, owner.projectId)) {
      state.write((ctx) => {
        failSendsToBuilder(ctx, [fresh], SendFailure.WorkspaceChanged);
      });
      return;
    }
    if (findLine(r.messages, fresh.id, 'reminder', { bot }) === undefined) {
      await postLine(client, {
        channel: fresh.channelId,
        threadTs: fresh.threadTs,
        text: reminderLine(),
        sendId: fresh.id,
        line: 'reminder',
      });
    }
    state.write((ctx) => {
      const now = openSends(ctx.tx).find((o) => o.id === fresh.id);
      if (now && dueTimers(now, getStakeholderTimers(ctx.tx), clock.now()) === 'remind')
        markReminded(ctx, fresh.id, clock.now().toISOString());
    });
  }

  /**
   * Runs a Slack read for some sends. A conversation Slack no longer has (a deleted thread, an archived
   * channel) fails those sends alone and answers null; anything about the connection is thrown to the tick.
   */
  async function guard<T>(
    affected: readonly OpenSendRow[],
    read: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await read();
    } catch (error) {
      // Only an error that says the conversation is gone fails a send; anything else is the tick's.
      if (!(error instanceof SlackError) || !GONE.has(error.code)) throw error;
      const { code } = error;
      log.warn({ code, sends: affected.map((o) => o.id) }, 'a conversation could not be read');
      state.write((ctx) => {
        failSendsToBuilder(ctx, affected, code);
      });
      return null;
    }
  }

  async function once(client: SlackClient): Promise<void> {
    try {
      const bot = await identity(client);
      await deps.sends.recoverSending(teamId);
      const opens = openSends(state.db, teamId);
      for (const r of await reading(client, opens, bot)) {
        const stillOpen = getInboxItem(state.db, r.open.inboxItemId).state === InboxState.Open;
        if (stillOpen) await guard([r.open], () => process(client, r, bot));
        if (openSends(state.db, teamId).some((o) => o.id === r.open.id))
          await guard([r.open], () => remind(client, r, bot));
      }
      failures = 0;
      if (connections.get(teamId)?.state !== 'connected') connections.set(teamId, 'connected');
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
      connections.set(teamId, 'refused', { error: error.code });
      paused = true;
    } else if (error.code === 'no_token') {
      connections.set(teamId, 'none');
      paused = true;
    } else if (error.code === 'ratelimited') {
      notBefore = clock.now().getTime() + (error.retryAfterSeconds ?? 30) * 1000;
    } else {
      // A timeout, a 5xx, a malformed reply or any error Slack gives that is not about one conversation:
      // the tick failed, and enough in a row make Slack unreachable.
      failures += 1;
      if (failures >= UNREACHABLE_AFTER)
        connections.set(teamId, 'unreachable', { error: error.code });
    }
  }

  /** A refusal or a removed token can set this during a look, so it is read through a function. */
  const isPaused = (): boolean => paused;

  async function tick(): Promise<void> {
    if (paused) return;
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

  /** Asks Slack who the token is now, so the connection says where it stands. */
  async function check(client: SlackClient): Promise<void> {
    botUserId = null;
    failures = 0;
    try {
      await identity(client);
      paused = false;
    } catch (error) {
      classify(error);
    }
  }

  return {
    tick,
    start() {
      if (running) return;
      running = true;
      // The connection is checked at once, so it never reads "none" for an interval after a restart.
      inFlight = check(slack).finally(schedule);
    },
    async stop() {
      running = false;
      stopped = true;
      shutdown.abort();
      timer?.cancel();
      timer = null;
      await inFlight;
    },
    async reconnect() {
      // A tick in flight read with the old token; its outcome must not overwrite this check's.
      inFlight = inFlight.then(() => check(slack));
      await inFlight;
      // A watch made for a new workspace starts reading here.
      if (!running && !stopped) {
        running = true;
        schedule();
      }
    },
  };
}
