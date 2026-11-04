// How Knowledge search reads text. The daemon's full-text query (packages/db knowledge-search.ts) and
// the Proposals tab's filter (apps/desktop) both use these, so a search behaves the same on every tab.

/** How a search's words select records. */
export const SearchMatch = {
  /** Free text from an agent or a task: a record sharing any whole word, the most shared first. */
  AnyWord: 'any_word',
  /** The builder typing in Knowledge: every word starts a word of the record, as `matchesSearch` reads it. */
  AllPrefixes: 'all_prefixes',
} as const;
export type SearchMatch = (typeof SearchMatch)[keyof typeof SearchMatch];

/** An accented a to z without its accent; a letter with two accents keeps them, as unicode61 does. */
function withoutAccent(letter: string): string {
  return /^([a-z])\p{M}$/u.exec(letter.normalize('NFD'))?.[1] ?? letter;
}

/** The combining marks unicode61 drops from inside a word; any other mark ends the word. */
const DROPPED_MARKS =
  /[\u{300}-\u{304}\u{306}-\u{30c}\u{30f}\u{311}\u{31b}\u{323}-\u{328}\u{32d}\u{32e}\u{330}\u{331}]/gu;

/**
 * What FTS5's unicode61 tokenizer makes of a word: lower-cased, with accents gone from Latin letters
 * only. Hangul, й and が keep their spelling, so no letter stays decomposed. The long s, plain or
 * dotted, reads as s. Text is composed first, so pasted decomposed text meets its stored spelling.
 */
function fold(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\u{17f}\u{1e9b}]/gu, 's')
    .replace(/\p{Script=Latin}/gu, withoutAccent)
    .replace(DROPPED_MARKS, '');
}

/**
 * The words of free text: runs of letters, digits and private-use characters, folded. Anything else
 * only separates words.
 */
export function searchTerms(text: string): string[] {
  return fold(text).match(/[\p{L}\p{N}\p{Co}]+/gu) ?? [];
}

/** Whether `query` holds a word. One that does not, such as "-", is no search: every record stays listed. */
export function isSearch(query: string): boolean {
  return searchTerms(query).length > 0;
}

/**
 * Whether `text` answers `query`: every word of the query is the start of some word of the text,
 * so a word still being typed ("slee") finds "sleep", and each added word narrows the result.
 * A query with no word matches everything.
 */
export function matchesSearch(text: string, query: string): boolean {
  const words = searchTerms(text);
  return searchTerms(query).every((term) => words.some((word) => word.startsWith(term)));
}
