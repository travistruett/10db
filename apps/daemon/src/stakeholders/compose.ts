import { isParkChoice, type InboxItemDto, type InboxOption } from '@10db/contracts';
import type { SlackBlock } from '../slack';
import { escapeMrkdwn } from './escape';
import { joinNames, replyWithLine } from './lines';
import { OPTION_LETTERS } from './letters';

const BODY_LIMIT = 2500;
const TITLE_LIMIT = 500;
/** A section's text may be 3,000 characters; escaping can lengthen what was cut to fit. */
const SECTION_LIMIT = 2900;
const SHORTENED = ' (shortened)';

/** The lane's own options: "Park the task" is the builder's alone and never goes to Slack. */
export function stakeholderOptions(card: InboxItemDto): InboxOption[] {
  return card.options.filter((option) => !isParkChoice(option.label));
}

/** `raw` cut to `limit` characters and escaped, cut further if escaping pushed it past `escapedLimit`. */
function clipEscaped(raw: string, limit: number, escapedLimit: number): string {
  let cut = Math.min(raw.length, limit);
  for (;;) {
    const shortened = cut < raw.length;
    const candidate = escapeMrkdwn(raw.slice(0, cut)) + (shortened ? SHORTENED : '');
    if (candidate.length <= escapedLimit || cut === 0) return candidate;
    cut = Math.floor(cut * 0.9);
  }
}

function recommendedIndex(options: readonly InboxOption[], recommendation: string | null): number {
  if (recommendation === null) return -1;
  const wanted = recommendation.trim().toLowerCase();
  const byLabel = options.findIndex((o) => o.label.trim().toLowerCase() === wanted);
  return byLabel >= 0
    ? byLabel
    : OPTION_LETTERS.findIndex((letter) => letter.toLowerCase() === wanted);
}

export interface ComposeInput {
  readonly card: InboxItemDto;
  readonly projectName: string;
  readonly goalTitle: string | null;
  readonly builderName: string;
  readonly recipientNames: string[];
}

/**
 * The message a stakeholder reads: who is asking and about what, the question, lettered options with the
 * recommendation marked, and how to answer. Every field from the card is escaped and every text object
 * sent verbatim, so agent text cannot ping, mention or link anyone.
 */
export function composeSlackQuestion(input: ComposeInput): { text: string; blocks: SlackBlock[] } {
  const { card } = input;
  const options = stakeholderOptions(card).slice(0, OPTION_LETTERS.length);
  const to = input.recipientNames.length <= 1 ? 'you' : joinNames(input.recipientNames);
  const subject = escapeMrkdwn(input.goalTitle ?? input.projectName);
  const header = `${escapeMrkdwn(input.builderName)}'s 10db build of *${subject}* has a question for ${to}.`;

  const title = clipEscaped(card.title, TITLE_LIMIT, SECTION_LIMIT);
  const body = clipEscaped(card.body, BODY_LIMIT, Math.max(SECTION_LIMIT - title.length - 3, 0));
  const question = body === '' ? `*${title}*` : `*${title}*\n${body}`;

  const recommended = recommendedIndex(options, card.recommendation);
  const optionLines = options.map(
    (option, i) =>
      `*${OPTION_LETTERS[i] ?? ''}.* ${escapeMrkdwn(option.label)}${i === recommended ? '  _(recommended)_' : ''}`,
  );
  const closing = [
    'The work on this waits for your answer.',
    replyWithLine(OPTION_LETTERS.slice(0, options.length)),
  ].join('\n');

  const sections = [header, question, optionLines.join('\n'), closing].filter((s) => s !== '');
  return {
    text: sections.join('\n\n'),
    blocks: sections.map((text) => ({
      type: 'section',
      text: { type: 'mrkdwn', text, verbatim: true },
    })),
  };
}
