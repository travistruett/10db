import { compareTs, tsMillis, type SlackMessage, type SlackReaction } from '../slack';
import { looksLikeApproval } from './approval-words';
import { letterOf, namesLetter, OPTION_LETTERS } from './letters';

/** A message that counts toward a conversation, with its author. */
export interface CountedMessage {
  readonly ts: string;
  readonly userId: string;
  readonly text: string;
}

export type ConversationState =
  | { readonly kind: 'waiting' }
  | {
      readonly kind: 'lone_reply';
      readonly words: string;
      readonly messageCount: number;
      readonly lastTs: string;
    }
  | { readonly kind: 'settled' }
  | { readonly kind: 'approval_seen'; readonly by: string }
  | { readonly kind: 'approved'; readonly by: string }
  | { readonly kind: 'picked'; readonly by: string; readonly choice: string }
  | { readonly kind: 'disagreed' }
  | { readonly kind: 'withdrawn' }
  | { readonly kind: 'approval_lost' };

export interface ConversationInput {
  /** Every message of the conversation since the question, from the thread and the DM's top level alike. */
  readonly messages: readonly SlackMessage[];
  /** Who can answer the card, in routing order. */
  readonly recipients: readonly string[];
  /** Everyone whose words count: the recipients and anyone brought in. */
  readonly participants: readonly string[];
  readonly botUserId: string;
  /**
   * The newest counted message the previous tick had already read, or null on the first look. A message
   * newer than it means the conversation is still moving.
   */
  readonly quietSince: string | null;
  readonly now: Date;
  /** The option 10db proposed and is waiting on, with the reactions on its message. */
  readonly proposal: {
    readonly ts: string;
    readonly letter: string;
    readonly reactions: readonly SlackReaction[];
  } | null;
  /** The newest message an earlier settle, proposal or which-way line already covered. */
  readonly settledThroughTs: string | null;
  readonly askedWhichWay: { readonly at: Date; readonly ts: string } | null;
  /** An approval an earlier tick saw: the newest message it had read, and who approved. */
  readonly approvalSeen: { readonly at: string; readonly by: string } | null;
  /** How many options the question has, so a letter past them is not a pick. Default four. */
  readonly optionCount?: number;
  /**
   * The recipients disagreed before and the card came back: a pick then needs every recipient's latest letter
   * to be the same letter, not one recipient's letter beside another's silence.
   */
  readonly afterDisagreement?: boolean;
  /** A reply's message `ts` mapped to whether the judge read it as approving the proposal. */
  readonly judgedApprovals?: ReadonlyMap<string, boolean>;
}

/** A conversation with nothing said for this long is read as finished. */
const SETTLE_AFTER_MS = 30 * 60 * 1000;
const APPROVAL_REACTIONS: ReadonlySet<string> = new Set([
  'white_check_mark',
  'heavy_check_mark',
  '+1',
]);
const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

const WAITING = { kind: 'waiting' } as const;

/**
 * The messages that count: written by a participant, not by the bot or another bot, not an edit or
 * deletion event, and after `afterTs`; oldest first.
 */
export function newMessages(input: {
  messages: readonly SlackMessage[];
  participants: readonly string[];
  botUserId: string;
  afterTs: string;
}): CountedMessage[] {
  const counted: CountedMessage[] = [];
  for (const m of input.messages) {
    if (m.user === null || m.user === input.botUserId || m.botId !== null) continue;
    if (
      m.subtype === 'bot_message' ||
      m.subtype === 'message_changed' ||
      m.subtype === 'message_deleted'
    )
      continue;
    if (!input.participants.includes(m.user) || compareTs(m.ts, input.afterTs) <= 0) continue;
    counted.push({ ts: m.ts, userId: m.user, text: m.text });
  }
  return counted.sort((a, b) => compareTs(a.ts, b.ts));
}

/** The people a participant mentioned who are neither the bot nor already in the conversation. */
export function mentionsToAdd(
  messages: readonly SlackMessage[],
  participants: readonly string[],
  botUserId: string,
): string[] {
  const found: string[] = [];
  for (const { text } of newMessages({ messages, participants, botUserId, afterTs: '0' })) {
    for (const match of text.matchAll(MENTION)) {
      const id = match[1];
      if (id !== undefined && id !== botUserId && !participants.includes(id) && !found.includes(id))
        found.push(id);
    }
  }
  return found;
}

type Stance =
  | { readonly kind: 'letter'; readonly letter: string; readonly ts: string }
  | { readonly kind: 'approval'; readonly ts: string | null }
  | { readonly kind: 'other' };

interface Reading {
  readonly counted: readonly CountedMessage[];
  readonly input: ConversationInput;
  readonly optionCount: number;
}

function isQuiet(reading: Reading, newestTs: string): boolean {
  const { quietSince } = reading.input;
  return quietSince !== null && compareTs(newestTs, quietSince) <= 0;
}

/** How a recipient's message stands toward an open proposal. */
function stanceOf(reading: Reading, message: CountedMessage): Stance {
  const letter = letterOf(message.text, reading.optionCount);
  if (letter !== null) return { kind: 'letter', letter, ts: message.ts };
  const judged = reading.input.judgedApprovals?.get(message.ts);
  if (judged ?? looksLikeApproval(message.text)) return { kind: 'approval', ts: message.ts };
  return { kind: 'other' };
}

/** The recipients, in routing order, who put an approving reaction on the proposal. */
function reactionApprovers(reading: Reading): ReadonlySet<string> {
  const reacted = new Set<string>();
  for (const reaction of reading.input.proposal?.reactions ?? []) {
    if (!APPROVAL_REACTIONS.has(reaction.name.split('::')[0] ?? '')) continue;
    for (const user of reaction.users) reacted.add(user);
  }
  return new Set(reading.input.recipients.filter((r) => reacted.has(r)));
}

function afterTs(messages: readonly CountedMessage[], ts: string): CountedMessage[] {
  return messages.filter((m) => compareTs(m.ts, ts) > 0);
}

/** A recipient's last message since a point decides where they stand; a ✅ counts when they wrote nothing. */
function recipientStances(reading: Reading, since: readonly CountedMessage[]): Map<string, Stance> {
  const approvers = reactionApprovers(reading);
  const stances = new Map<string, Stance>();
  for (const recipient of reading.input.recipients) {
    const last = since.filter((m) => m.userId === recipient).at(-1);
    if (last !== undefined) stances.set(recipient, stanceOf(reading, last));
    else if (approvers.has(recipient)) stances.set(recipient, { kind: 'approval', ts: null });
  }
  return stances;
}

function earliest<T extends { ts: string }>(items: readonly T[]): T | undefined {
  return [...items].sort((a, b) => compareTs(a.ts, b.ts))[0];
}

function openProposal(reading: Reading): ConversationState {
  const { input } = reading;
  const proposal = input.proposal;
  if (proposal === null) return WAITING;
  const post = afterTs(reading.counted, proposal.ts);
  if (input.approvalSeen !== null) return seenApproval(reading, post, proposal, input.approvalSeen);

  const stances = recipientStances(reading, post);
  const agreeing = [...stances].filter(([, s]) => s.kind !== 'other');
  const dissenting = [...stances].filter(([, s]) => s.kind === 'other');
  const chose = new Set(
    agreeing.map(([, s]) => (s.kind === 'letter' ? s.letter : proposal.letter)),
  );
  const outsiders = post.filter((m) => !input.recipients.includes(m.userId));

  if (agreeing.length === 0)
    return dissenting.length > 0 || outsiders.length > 0 ? { kind: 'withdrawn' } : WAITING;
  if (chose.size > 1 || dissenting.length > 0) return { kind: 'disagreed' };

  const letters = agreeing.flatMap(([userId, s]) =>
    s.kind === 'letter' ? [{ userId, letter: s.letter, ts: s.ts }] : [],
  );
  const firstLetter = earliest(letters);
  if (firstLetter !== undefined) {
    return { kind: 'picked', by: firstLetter.userId, choice: firstLetter.letter };
  }

  // An approval is not a pick, so anyone writing after it may be objecting. A ✅ has no time, so it
  // is read as given right after the proposal.
  const approvalTimes = agreeing.map(([, s]) => (s.kind === 'approval' ? s.ts : null));
  const anchor = approvalTimes.includes(null)
    ? proposal.ts
    : (earliest(approvalTimes.flatMap((ts) => (ts === null ? [] : [{ ts }])))?.ts ?? proposal.ts);
  if (afterTs(outsiders, anchor).length > 0) return { kind: 'withdrawn' };
  const first = agreeing[0];
  return first === undefined ? WAITING : { kind: 'approval_seen', by: first[0] };
}

/** The tick after an approval was seen: it stands unless it was withdrawn, contested or taken back. */
function seenApproval(
  reading: Reading,
  post: readonly CountedMessage[],
  proposal: NonNullable<ConversationInput['proposal']>,
  seen: NonNullable<ConversationInput['approvalSeen']>,
): ConversationState {
  const since = afterTs(post, seen.at);
  for (const recipient of reading.input.recipients) {
    if (recipient === seen.by) continue;
    const last = since.filter((m) => m.userId === recipient).at(-1);
    if (last === undefined) continue;
    const stance = stanceOf(reading, last);
    if (stance.kind === 'other' || (stance.kind === 'letter' && stance.letter !== proposal.letter))
      return { kind: 'disagreed' };
  }
  const own = since.filter((m) => m.userId === seen.by).at(-1);
  if (own !== undefined) {
    const stance = stanceOf(reading, own);
    if (stance.kind === 'letter') return { kind: 'picked', by: seen.by, choice: stance.letter };
    if (stance.kind === 'other') return { kind: 'withdrawn' };
  }
  const stands =
    reactionApprovers(reading).has(seen.by) ||
    post.some((m) => m.userId === seen.by && stanceOf(reading, m).kind === 'approval');
  return stands ? { kind: 'approved', by: seen.by } : { kind: 'approval_lost' };
}

function joined(messages: readonly CountedMessage[]): ConversationState {
  const last = messages.at(-1);
  if (last === undefined) return WAITING;
  return {
    kind: 'lone_reply',
    words: messages.map((m) => m.text).join('\n'),
    messageCount: messages.length,
    lastTs: last.ts,
  };
}

/**
 * Several recipients: different letters disagree at once, one agreed letter is a pick once quiet. A recipient
 * whose latest message is not a letter, after they named one, has taken it back: that is no pick. After a
 * disagreement every recipient must have a latest letter, and they must agree.
 */
function recipientPicks(
  reading: Reading,
  recent: readonly CountedMessage[],
): ConversationState | null {
  const { recipients } = reading.input;
  const triggered = recent.some(
    (m) => recipients.includes(m.userId) && letterOf(m.text, reading.optionCount) !== null,
  );
  if (!triggered) return null;
  const latest: { userId: string; letter: string; ts: string }[] = [];
  for (const userId of recipients) {
    const mine = reading.counted.filter((m) => m.userId === userId);
    const last = mine.at(-1);
    if (last === undefined) continue;
    const letter = letterOf(last.text, reading.optionCount);
    if (letter !== null) {
      latest.push({ userId, letter, ts: last.ts });
    } else if (mine.some((m) => letterOf(m.text, reading.optionCount) !== null)) {
      return null;
    }
  }
  const letters = new Set(latest.map((l) => l.letter));
  if (letters.size > 1) return { kind: 'disagreed' };
  if (reading.input.afterDisagreement === true && latest.length < recipients.length) return null;
  const newest = recent.at(-1);
  const first = earliest(latest);
  if (first === undefined || newest === undefined || !isQuiet(reading, newest.ts)) return null;
  return { kind: 'picked', by: first.userId, choice: first.letter };
}

function settle(reading: Reading): ConversationState {
  const { input, counted } = reading;
  const recent =
    input.settledThroughTs === null ? counted : afterTs(counted, input.settledThroughTs);
  const newest = recent.at(-1);
  if (newest === undefined) return WAITING;
  if (input.recipients.length > 1) {
    const verdict = recipientPicks(reading, recent);
    if (verdict !== null) return verdict;
  }
  const namedALetter = recent.some((m) => namesLetter(m.text, reading.optionCount));
  const quietLongEnough = input.now.getTime() - tsMillis(newest.ts) >= SETTLE_AFTER_MS;
  return (isQuiet(reading, newest.ts) && namedALetter) || quietLongEnough
    ? { kind: 'settled' }
    : WAITING;
}

/**
 * Where a send's conversation stands, from what was said and what the last tick already saw. Pure: the
 * watch acts on the answer (posts a line, asks the judge, answers the card) and stores the marks.
 *
 * A lone recipient who alone replied is a `lone_reply` once a tick finds nothing newer. With anyone else
 * in the conversation, or several recipients, it `settled` after a message naming a letter and a quiet
 * tick, or after 30 minutes. With a proposal open, a recipient's ✅ or approving reply is `approval_seen`,
 * confirmed as `approved` on the next tick; a letter is `picked`; recipients who disagree are `disagreed`;
 * anything else `withdrawn` the proposal.
 */
export function conversationState(input: ConversationInput): ConversationState {
  const counted = newMessages({
    messages: input.messages,
    participants: input.participants,
    botUserId: input.botUserId,
    afterTs: '0',
  });
  const reading: Reading = {
    counted,
    input,
    optionCount: input.optionCount ?? OPTION_LETTERS.length,
  };
  if (input.proposal !== null) return openProposal(reading);

  const [only, ...others] = input.recipients;
  if (only !== undefined && others.length === 0) {
    if (input.askedWhichWay !== null) {
      const after = afterTs(counted, input.askedWhichWay.ts);
      const mine = after.filter((m) => m.userId === only);
      const newest = after.at(-1);
      if (mine.length > 0 && newest !== undefined)
        return isQuiet(reading, newest.ts) ? joined(mine) : WAITING;
    } else if (counted.length > 0 && counted.every((m) => m.userId === only)) {
      const newest = counted.at(-1);
      return newest !== undefined && isQuiet(reading, newest.ts) ? joined(counted) : WAITING;
    }
  }
  return settle(reading);
}
