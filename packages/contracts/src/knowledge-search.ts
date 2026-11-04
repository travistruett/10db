// How Knowledge search reads text. The daemon's full-text query (packages/db knowledge-search.ts) and
// the Proposals tab's filter (apps/desktop) both use these, so a search behaves the same on every tab.

/** Lower-cased, accents removed: what FTS5's unicode61 tokenizer makes of a word. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** The words of free text: runs of letters and digits, folded. Anything else only separates words. */
export function searchTerms(text: string): string[] {
  return fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];
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
