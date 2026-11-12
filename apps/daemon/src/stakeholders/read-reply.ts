import { isParkChoice, type InboxAnswer, type InboxOption } from '@10db/contracts';
import { letterOf, OPTION_LETTERS } from './letters';

const NOTE_LIMIT = 4000;

export interface ReplyRead {
  readonly answer: InboxAnswer | null;
  readonly readAs: 'option' | 'own_words';
}

const OWN_WORDS: ReplyRead = { answer: null, readAs: 'own_words' };

/**
 * Reads a lone recipient's reply against the card's options. One message whose first word is an option
 * letter, or whose whole text is an option's label, picks that option and the words become its note.
 * Several messages joined, or anything else, are the person's own words: "B" then "wait, C" is never B.
 * "Park the task" is never an option here.
 */
export function readReply(
  reply: { words: string; messageCount: number },
  options: readonly InboxOption[],
): ReplyRead {
  const lane = options.filter((o) => !isParkChoice(o.label)).slice(0, OPTION_LETTERS.length);
  const words = reply.words.trim();
  if (reply.messageCount !== 1 || words === '') return OWN_WORDS;
  const letter = letterOf(words, lane.length);
  const byLetter =
    letter === null ? undefined : lane[OPTION_LETTERS.findIndex((l) => l === letter)];
  const picked = byLetter ?? lane.find((o) => o.label.trim().toLowerCase() === words.toLowerCase());
  if (picked === undefined) return OWN_WORDS;
  return { answer: { choice: picked.label, note: words.slice(0, NOTE_LIMIT) }, readAs: 'option' };
}
