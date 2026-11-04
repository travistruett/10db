/** At most this many rules are proposed from one answer, so a long note can't flood the inbox. */
const MAX_STANDING_RULES = 3;
const MIN_WORDS = 3;
const STATEMENT_MAX = 500;

/** Sentences that state a standing rule with the word "always" or "never" (spec §9 capture). */
export function standingRules(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim().replace(/^[-*•]\s*/, ''))
    .filter((s) => /\b(?:always|never)\b/i.test(s) && s.split(/\s+/).length >= MIN_WORDS)
    .slice(0, MAX_STANDING_RULES)
    .map((s) => s.slice(0, STATEMENT_MAX));
}
