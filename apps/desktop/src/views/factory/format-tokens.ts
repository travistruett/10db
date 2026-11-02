/** A token count as the digest says it: "850", "412k", "1.3M". */
export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${String(Math.round(tokens / 1_000))}k`;
  return `${String(Math.round(tokens / 100_000) / 10)}M`;
}
