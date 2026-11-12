import {
  ConflictError,
  JudgeDecision,
  JudgeOutcome,
  type InboxItemDto,
  type JudgeCallId,
  type PersonId,
} from '@10db/contracts';
import {
  getJudgeConfig,
  markApprovalSeen,
  markAnswered,
  markAskedWhichWay,
  markReturned,
  markSettled,
  recordJudgeOutcome,
  sendForCard,
  setLastRead,
  setProposal,
  type OpenSendRow,
} from '@10db/db';
import type { Clock } from '../clock';
import type { StateStore } from '../events';
import type { InboxService } from '../inbox';
import type { Judge } from '../judge';
import type { Logger } from '../log';
import { compareTs, SlackError, type SlackClient, type SlackMessage } from '../slack';
import { findLine, postLine } from './bot-lines';
import { stakeholderOptions } from './compose';
import type { CountedMessage } from './conversation';
import { proposalLine, whichWayLine } from './lines';
import { letterOf, OPTION_LETTERS } from './letters';

/** How much of a conversation the judge is sent. */
const JUDGED_MESSAGES = 50;
const JUDGED_TEXT = 1000;
const NO_CLEAR_ANSWER = 'no_clear_answer';
const APPROVES = 'approves';
const DOES_NOT = 'does_not_approve';

export interface AgreeDeps {
  readonly client: SlackClient;
  readonly state: StateStore;
  readonly judge: Judge;
  readonly inbox: Pick<InboxService, 'answerAs'>;
  readonly clock: Clock;
  readonly log: Logger;
}

/** What one send's conversation has to work with this tick. */
export interface Conversation {
  readonly open: OpenSendRow;
  readonly card: InboxItemDto;
  /** Messages that count, oldest first. */
  readonly counted: readonly CountedMessage[];
  /** Everything in the current thread, bot lines included, for finding lines already posted. */
  readonly thread: readonly SlackMessage[];
  /** `ts` values that were typed at the top of the DM, not in the thread. */
  readonly topLevel: ReadonlySet<string>;
}

const nameOf = (open: OpenSendRow, userId: string): string =>
  open.people.find((p) => p.userId === userId)?.name ?? userId;

const recipientIds = (open: OpenSendRow): string[] =>
  open.people.filter((p) => p.recipient).map((p) => p.userId);

/** The judge's read of a reply the fixed list cannot judge: does it approve the open proposal? */
export async function judgeApprovals(
  deps: AgreeDeps,
  c: Conversation,
  cache: Map<string, boolean | null>,
): Promise<Map<string, boolean>> {
  const { open } = c;
  const proposal = open.proposal;
  const answers = (): Map<string, boolean> =>
    new Map([...cache].flatMap(([ts, read]) => (read === null ? [] : [[ts, read] as const])));
  if (proposal === null || deps.judge.off) return answers();
  const label = optionLabel(c.card, proposal.choice);
  const recipients = recipientIds(open);
  for (const m of c.counted.slice(-JUDGED_MESSAGES)) {
    if (!recipients.includes(m.userId) || cache.has(m.ts)) continue;
    if (proposal.ts !== null && compareTs(m.ts, proposal.ts) <= 0) continue;
    try {
      const answer = await deps.judge.choose({
        decision: JudgeDecision.ApprovalRead,
        state: JSON.stringify({
          proposal: `${proposal.choice}: ${label}`,
          reply: m.text.slice(0, JUDGED_TEXT),
        }),
        question: 'Does this reply approve the proposed answer?',
        options: [APPROVES, DOES_NOT],
        criteria: {
          [APPROVES]: 'The reply agrees with the proposal as it stands',
          [DOES_NOT]: 'The reply asks for something else, objects, or is unrelated',
        },
      });
      const floor = getJudgeConfig(deps.state.db).decisions[JudgeDecision.ApprovalRead].floor;
      // A reading below the floor is remembered too, so the same message is not put to the judge every tick.
      cache.set(
        m.ts,
        answer.kind === 'answered' && answer.confidence >= floor
          ? answer.choice === APPROVES
          : null,
      );
    } catch (error) {
      deps.log.warn({ err: error }, 'a reply could not be read for approval');
    }
  }
  return answers();
}

function optionLabel(card: InboxItemDto, letter: string): string {
  const index = OPTION_LETTERS.findIndex((l) => l === letter);
  return stakeholderOptions(card)[index]?.label ?? letter;
}

/**
 * A settled conversation: the judge reads which option it landed on (`thread_answer`). Sure of a letter, 10db
 * proposes it and seeds the ✅ on its own line; otherwise it asks which way. The line, the marks and the
 * judge call's outcome are written together, and a line found in the thread by its metadata is not posted twice.
 */
export async function settleConversation(deps: AgreeDeps, c: Conversation): Promise<void> {
  const { open, card } = c;
  const options = stakeholderOptions(card).slice(0, OPTION_LETTERS.length);
  const letters: string[] = options.map((_o, i) => OPTION_LETTERS[i] ?? '');
  const newest = c.counted.at(-1);
  if (!newest) return;
  let verdict: { letter: string; confidence: number; callId: JudgeCallId } | null = null;
  let weak: JudgeCallId | null = null;
  if (!deps.judge.off && letters.length > 0) {
    try {
      const answer = await deps.judge.choose({
        decision: JudgeDecision.ThreadAnswer,
        state: JSON.stringify({
          question: card.title,
          options: options.map((o, i) => ({ letter: letters[i], label: o.label })),
          // The newest words only, each cut: a long thread must not become an unbounded request.
          messages: c.counted
            .slice(-JUDGED_MESSAGES)
            .map((m) => ({ author: nameOf(open, m.userId), text: m.text.slice(0, JUDGED_TEXT) })),
        }),
        question: 'Which option did the conversation land on?',
        options: [NO_CLEAR_ANSWER, ...letters],
        criteria: {
          ...Object.fromEntries(options.map((o, i) => [letters[i] ?? '', o.label])),
          [NO_CLEAR_ANSWER]: 'No option clearly won',
        },
      });
      if (answer.kind === 'answered') {
        const floor = getJudgeConfig(deps.state.db).decisions[JudgeDecision.ThreadAnswer].floor;
        if (letters.includes(answer.choice) && answer.confidence >= floor)
          verdict = { letter: answer.choice, confidence: answer.confidence, callId: answer.callId };
        else weak = answer.callId;
      }
    } catch (error) {
      deps.log.warn({ err: error }, 'a conversation could not be read for its answer');
    }
  }
  // The conversation may have been answered, or moved on, while the judge thought.
  const fresh = sendForCard(deps.state.db, card.id);
  if (fresh?.state !== 'sent') return;
  const recipients = recipientIds(open);
  if (verdict !== null) {
    const letter = verdict.letter;
    const favoured = [
      ...new Set(
        c.counted
          .filter((m) => letterOf(m.text, letters.length) === letter)
          .map((m) => nameOf(open, m.userId)),
      ),
    ];
    const label = options[letters.indexOf(letter)]?.label ?? letter;
    const text = proposalLine(letter, label, favoured, recipients);
    const found = findLine(c.thread, open.id, 'proposal', { after: newest.ts });
    const ts =
      found?.ts ??
      (await postLine(deps.client, {
        channel: open.channelId,
        threadTs: open.threadTs,
        text,
        sendId: open.id,
        line: 'proposal',
      }));
    // The ✅ is seeded so a recipient clicks the one that is there; losing it only costs them a click.
    try {
      await deps.client.addReaction(open.channelId, ts, 'white_check_mark');
    } catch (error) {
      if (!(error instanceof SlackError && error.code === 'already_reacted'))
        deps.log.warn({ err: error }, 'the ✅ could not be added to a proposal');
    }
    const callId = verdict.callId;
    deps.state.write((ctx) => {
      setProposal(ctx, open.id, { choice: letter, confidence: verdict.confidence, ts });
      markSettled(ctx, open.id, newest.ts);
      recordJudgeOutcome(ctx, callId, JudgeOutcome.Acted);
    });
    return;
  }
  const text = whichWayLine(letters, recipients);
  const found = findLine(c.thread, open.id, 'which_way', { after: newest.ts });
  const ts =
    found?.ts ??
    (await postLine(deps.client, {
      channel: open.channelId,
      threadTs: open.threadTs,
      text,
      sendId: open.id,
      line: 'which_way',
    }));
  const callId = weak;
  deps.state.write((ctx) => {
    markAskedWhichWay(ctx, open.id, {
      at: deps.clock.now().toISOString(),
      ts,
      throughTs: newest.ts,
    });
    if (callId !== null) recordJudgeOutcome(ctx, callId, JudgeOutcome.BelowFloor);
  });
}

/** Answers the card as the recipient who approved or picked, with the conversation quoted. */
export function answerAgreed(
  deps: AgreeDeps,
  c: Conversation,
  agreed: { readonly by: string; readonly letter: string; readonly readAs: 'approved' | 'option' },
): void {
  const { open, card } = c;
  const person = open.people.find((p) => p.userId === agreed.by && p.recipient);
  const last = c.counted.at(-1);
  if (!person?.personId || !last) return;
  const personId: PersonId = person.personId;
  const mine = c.counted.filter((m) => m.userId === agreed.by).at(-1);
  const label = optionLabel(card, agreed.letter);
  const words = mine?.text ?? '✅';
  const others = [
    ...new Set(
      c.counted
        .map((m) => m.userId)
        .filter((u) => u !== agreed.by)
        .map((u) => nameOf(open, u)),
    ),
  ];
  const via = mine !== undefined && c.topLevel.has(mine.ts) ? 'top_level' : 'thread';
  try {
    deps.inbox.answerAs(
      card.id,
      {
        readAs: agreed.readAs,
        answer:
          agreed.readAs === 'option' && mine
            ? { choice: label, note: mine.text.slice(0, 4000) }
            : { choice: label },
        words,
        conversation: c.counted.map((m) => ({ name: nameOf(open, m.userId), text: m.text })),
      },
      {
        personId,
        permalink: sendForCard(deps.state.db, card.id)?.permalink ?? '',
        with: others,
      },
      (ctx) => {
        setLastRead(ctx, open.id, last.ts);
        markAnswered(ctx, open.id, {
          reply: { text: words, userId: agreed.by, ts: mine?.ts ?? last.ts },
          readAs: agreed.readAs,
          answeredBy: personId,
          replyVia: via,
        });
      },
    );
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    deps.log.info({ sendId: open.id }, 'a conversation agreed after the card was answered');
  }
}

/** Recipients disagree: the proposal goes, no decision is made, and the card returns to the builder. */
export function returnDisagreed(deps: AgreeDeps, open: OpenSendRow, newestTs: string | null): void {
  if (open.returnedAt !== null) return;
  deps.state.write((ctx) => {
    setProposal(ctx, open.id, null);
    markApprovalSeen(ctx, open.id, null);
    if (newestTs !== null) markSettled(ctx, open.id, newestTs);
    markReturned(ctx, open.id, 'disagreed');
  });
}
