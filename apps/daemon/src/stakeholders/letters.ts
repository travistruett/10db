/** The letters a question's options are given, in order: at most four options go to Slack. */
export const OPTION_LETTERS = ['A', 'B', 'C', 'D'] as const;

/**
 * A reply's first word, when it is an option letter: bare, followed by `.`, `)`, `:`, `,` or punctuation
 * that ends a word, or wrapped in parentheses; any case.
 */
const FIRST_WORD_LETTER = /^\s*(?:\(([A-Da-d])\)|([A-Da-d])(?=$|[\s.):,;!?]))/;
const OPTION_PHRASE = /\b(?:option|choice)\s+\(?([A-Da-d])\b/i;

function within(letter: string | undefined, optionCount: number): string | null {
  if (letter === undefined) return null;
  const upper = letter.toUpperCase();
  const index = OPTION_LETTERS.findIndex((l) => l === upper);
  return index >= 0 && index < Math.min(optionCount, OPTION_LETTERS.length) ? upper : null;
}

/** The option letter a message starts with, or null; a letter past `optionCount` is not one. */
export function letterOf(text: string, optionCount: number = OPTION_LETTERS.length): string | null {
  const match = FIRST_WORD_LETTER.exec(text);
  return within(match?.[1] ?? match?.[2], optionCount);
}

/** Whether a message names an option: it starts with a letter, or says "option B". */
export function namesLetter(text: string, optionCount: number = OPTION_LETTERS.length): boolean {
  return (
    letterOf(text, optionCount) !== null ||
    within(OPTION_PHRASE.exec(text)?.[1], optionCount) !== null
  );
}
