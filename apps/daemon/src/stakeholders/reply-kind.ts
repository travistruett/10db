import {
  JudgeDecision,
  ReplyKind,
  type InboxItemDto,
  type InboxOption,
  type JudgeCallId,
} from '@10db/contracts';
import type { Judge } from '../judge';
import type { Logger } from '../log';
import { stakeholderOptions } from './compose';
import { readReply } from './read-reply';

/** How much of each text the judge is sent. */
const JUDGED_TEXT = 1000;

const QUESTION_WORDS: ReadonlySet<string> = new Set([
  'what',
  'why',
  'how',
  'who',
  'when',
  'where',
  'which',
  "what's",
  'whats',
]);

/**
 * The rule when no judge reads the reply: an option is an answer, nothing is chatter, a "?" or a question word
 * first is a question for the builder, and anything else is an answer in the person's own words. It never
 * returns `SimpleQuestion` (10db does not answer by itself without a judge) and never guesses chatter for
 * words, which could swallow a real answer.
 */
export function ruleReplyKind(
  reply: { words: string; messageCount: number },
  options: readonly InboxOption[],
): ReplyKind {
  if (readReply(reply, options).readAs === 'option') return ReplyKind.Answer;
  const words = reply.words.trim();
  if (words === '') return ReplyKind.Chatter;
  const first = words.split(/\s+/)[0]?.toLowerCase().replace(/’/g, "'") ?? '';
  const firstWord = first.replace(/[^a-z']/g, '');
  if (words.includes('?') || QUESTION_WORDS.has(firstWord)) return ReplyKind.BuilderQuestion;
  return ReplyKind.Answer;
}

export interface ReplyKindRead {
  readonly kind: ReplyKind;
  readonly source: 'rule' | 'judge';
  /** The judge call that answered, for its outcome to be recorded; null when none did. */
  readonly callId: JudgeCallId | null;
}

const CRITERIA: Readonly<Record<ReplyKind, string>> = {
  [ReplyKind.Answer]: 'It picks an option or says, in their own words, what they want done.',
  [ReplyKind.SimpleQuestion]:
    "It asks 10db to explain the question, an option, a term or why it is asked, and the question's own text or the task's description can answer it.",
  [ReplyKind.BuilderQuestion]:
    "It asks for the builder's intent, judgement, a decision, a date, money, people, or a fact not in the question; or it pushes back on the question itself.",
  [ReplyKind.Chatter]:
    "Thanks, an acknowledgement, a 'looking now' or 'back tomorrow', or talk between participants that asks nothing of 10db or the builder.",
};

/**
 * Sorts a stakeholder's reply: does it answer the card, ask 10db something it can explain, ask the builder, or
 * say nothing that needs acting on. A rule-picked option never asks the judge. With no judge, or below its
 * floor, a lone reply takes the rule and a group's takes "answer", which the caller treats as "do as before".
 * Only a judge's confident "builder question" skips the answer writer.
 */
export async function classifyReply(
  deps: { readonly judge: Judge; readonly floor: () => number; readonly log: Logger },
  input: {
    readonly card: InboxItemDto;
    readonly words: string;
    readonly messageCount: number;
    readonly author: string;
    readonly group: boolean;
  },
): Promise<ReplyKindRead> {
  const options = stakeholderOptions(input.card);
  const reply = { words: input.words, messageCount: input.messageCount };
  // A lone reply the rule reads as a question to the builder goes to the answer writer first, which passes
  // it on when it cannot answer; a group's replies are never guessed at without a judge.
  const byRule = (): ReplyKindRead => {
    const ruled = input.group ? ReplyKind.Answer : ruleReplyKind(reply, options);
    return {
      kind: ruled === ReplyKind.BuilderQuestion ? ReplyKind.SimpleQuestion : ruled,
      source: 'rule',
      callId: null,
    };
  };
  if (readReply(reply, options).readAs === 'option')
    return { kind: ReplyKind.Answer, source: 'rule', callId: null };
  if (!(await deps.judge.ready(JudgeDecision.ReplyKind))) return byRule();
  try {
    const answer = await deps.judge.choose({
      decision: JudgeDecision.ReplyKind,
      state: JSON.stringify({
        question: input.card.title.slice(0, JUDGED_TEXT),
        options: options.map((o) => o.label.slice(0, JUDGED_TEXT)),
        author: input.author.slice(0, JUDGED_TEXT),
        reply: input.words.slice(0, JUDGED_TEXT),
      }),
      question: 'What is this reply?',
      options: [
        ReplyKind.Answer,
        ReplyKind.SimpleQuestion,
        ReplyKind.BuilderQuestion,
        ReplyKind.Chatter,
      ],
      criteria: CRITERIA,
    });
    if (answer.kind !== 'answered') return byRule();
    const chosen = Object.values(ReplyKind).find((k) => k === answer.choice);
    if (chosen === undefined) return byRule();
    // Any confidence that it is a simple question tries the writer, which declines what it cannot answer.
    if (chosen === ReplyKind.SimpleQuestion || answer.confidence >= deps.floor())
      return { kind: chosen, source: 'judge', callId: answer.callId };
    // A doubtful "for the builder" also tries the writer first; other doubtful readings take the rule.
    if (chosen === ReplyKind.BuilderQuestion)
      return { kind: ReplyKind.SimpleQuestion, source: 'rule', callId: answer.callId };
    return { ...byRule(), callId: answer.callId };
  } catch (error) {
    deps.log.warn({ err: error }, 'a reply could not be sorted by the judge');
    return byRule();
  }
}
