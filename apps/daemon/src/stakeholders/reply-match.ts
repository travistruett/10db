import { JudgeDecision } from '@10db/contracts';
import type { OpenSendRow } from '@10db/db';
import type { Judge } from '../judge';
import type { Logger } from '../log';
import { compareTs, type SlackClient, type SlackMessage } from '../slack';
import { newMessages, type CountedMessage } from './conversation';
import { blocksOf } from './slack-text';

/** What the watch remembers between ticks about messages typed at the top of a conversation. */
export interface MatchState {
  /** A top-level message's `ts` to the send it answers; `consumed` for a number that only chose one. */
  readonly assigned: Map<string, string>;
  /** Per channel, the "Which one is this for?" line posted and the newest message it was asked for. */
  readonly asked: Map<string, { postTs: string; forTs: string }>;
}

export interface MatchDeps {
  readonly judge: Judge;
  readonly slack: SlackClient;
  readonly log: Logger;
  readonly state: MatchState;
  readonly titleOf: (open: OpenSendRow) => string;
  readonly floor: () => number;
}

/** How much of the unassigned messages the judge is sent. */
const JUDGED_MESSAGES = 50;
const JUDGED_TEXT = 1000;
const CONSUMED = 'consumed';
const NUMBER = /^\s*\(?(\d{1,2})[.)]?\s*$/;
const UNCLEAR = 'unclear';

/**
 * Decides which open question each message typed at the top of a conversation answers. A person with one
 * open question there answers it. With several, the judge picks (`reply_match`) when it is sure; otherwise
 * 10db asks "Which one is this for?" once, and a reply that is a number chooses. A message that nothing
 * assigns is left alone and read again next tick. Answers the send for each message that has one.
 */
export async function matchReply(
  deps: MatchDeps,
  input: {
    readonly channel: string;
    readonly bot: string;
    readonly opens: readonly OpenSendRow[];
    readonly messages: readonly SlackMessage[];
  },
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const first = input.opens[0];
  if (!first) return result;
  const everyone = [...new Set(input.opens.flatMap((o) => o.people.map((p) => p.userId)))];
  const counted = newMessages({
    messages: input.messages,
    participants: everyone,
    botUserId: input.bot,
    afterTs: first.messageTs,
  });
  const pending: { message: CountedMessage; eligible: OpenSendRow[] }[] = [];
  for (const message of counted) {
    const eligible = input.opens.filter(
      (o) =>
        compareTs(message.ts, o.messageTs) > 0 && o.people.some((p) => p.userId === message.userId),
    );
    if (eligible.length === 0) continue;
    const cached = deps.state.assigned.get(message.ts);
    if (cached !== undefined) {
      if (cached !== CONSUMED && eligible.some((o) => o.id === cached))
        result.set(message.ts, cached);
      continue;
    }
    const only = eligible[0];
    if (eligible.length === 1 && only) {
      result.set(message.ts, only.id);
      continue;
    }
    const asked = deps.state.asked.get(input.channel);
    const chosen = Number(NUMBER.exec(message.text)?.[1] ?? 0);
    const target = eligible[chosen - 1];
    if (asked !== undefined && compareTs(message.ts, asked.postTs) > 0 && target) {
      deps.state.assigned.set(message.ts, CONSUMED);
      for (const earlier of pending.splice(0)) {
        deps.state.assigned.set(earlier.message.ts, target.id);
        result.set(earlier.message.ts, target.id);
      }
      continue;
    }
    pending.push({ message, eligible });
  }
  const newest = pending.at(-1);
  if (!newest) return result;
  const asked = deps.state.asked.get(input.channel);
  if (asked !== undefined && compareTs(asked.forTs, newest.message.ts) >= 0) return result;
  const options = newest.eligible;
  const picked = await judged(
    deps,
    options,
    pending.map((p) => p.message),
  );
  if (picked !== null) {
    for (const p of pending) {
      deps.state.assigned.set(p.message.ts, picked.id);
      result.set(p.message.ts, picked.id);
    }
    return result;
  }
  const text = [
    'Which one is this for?',
    ...options.map((o, i) => `${String(i + 1)}) ${deps.titleOf(o)}`),
  ].join('\n');
  const posted = await deps.slack.post({ channel: input.channel, text, blocks: blocksOf(text) });
  deps.state.asked.set(input.channel, { postTs: posted.ts, forTs: newest.message.ts });
  return result;
}

/** The send the judge is sure the messages answer, or null (unsure, no key, off, or "unclear"). */
async function judged(
  deps: MatchDeps,
  options: readonly OpenSendRow[],
  messages: readonly CountedMessage[],
): Promise<OpenSendRow | null> {
  if (deps.judge.off) return null;
  const labels = options.map((_o, i) => String(i + 1));
  const criteria = Object.fromEntries([
    ...options.map((o, i) => [String(i + 1), deps.titleOf(o)] as const),
    [UNCLEAR, 'Cannot tell which question this answers'],
  ]);
  try {
    const answer = await deps.judge.choose({
      decision: JudgeDecision.ReplyMatch,
      state: JSON.stringify({
        // The newest words only, each cut: a long run of messages must not become an unbounded request.
        reply: messages.slice(-JUDGED_MESSAGES).map((m) => m.text.slice(0, JUDGED_TEXT)),
        questions: options.map((o, i) => ({ n: i + 1, title: deps.titleOf(o) })),
      }),
      question: 'Which of these open questions is the reply answering?',
      options: [UNCLEAR, ...labels],
      criteria,
    });
    if (answer.kind !== 'answered' || answer.confidence < deps.floor()) return null;
    return options[labels.indexOf(answer.choice)] ?? null;
  } catch (error) {
    deps.log.warn({ err: error }, 'a reply could not be matched to a question');
    return null;
  }
}
