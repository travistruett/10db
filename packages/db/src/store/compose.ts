/**
 * Text as Knowledge stores it: composed (NFC). The FTS5 index holds stored text as written and its
 * tokenizer leaves Hangul syllables and й composed, so a record stored decomposed (pasted from a macOS
 * file name, say) could never meet the composed query `searchTerms` makes. Composing on write makes the
 * stored text what the query side already assumes. Every indexed column goes through here.
 */
export function composed(text: string): string;
export function composed(text: string | null): string | null;
export function composed(text: string | null | undefined): string | null | undefined;
export function composed(text: string | null | undefined): string | null | undefined {
  return text?.normalize('NFC');
}
