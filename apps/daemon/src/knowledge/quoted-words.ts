/** The most of a stakeholder's words that go into a decision or a prompt in one quote. */
export const QUOTED_WORDS_LIMIT = 4000;

/**
 * Someone else's words as data: cut to `max` characters, any guillemet inside replaced by a plain quote so
 * the quote cannot be closed early, and wrapped in guillemets. Text from Slack reaches knowledge and lane
 * prompts only through this.
 */
export function quotedWords(text: string, max: number = QUOTED_WORDS_LIMIT): string {
  return `«${text.slice(0, max).replace(/[«»]/g, '"')}»`;
}
