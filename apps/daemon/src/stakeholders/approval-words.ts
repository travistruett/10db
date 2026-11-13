/**
 * What counts as approving a proposal when no judge read the reply. Case, punctuation, emoji skin tones and
 * a trailing courtesy ("sir", "thanks") are ignored, so "Yes sir." approves and "yes but" does not.
 */
const APPROVAL_PHRASES: ReadonlySet<string> = new Set([
  'yes',
  'yep',
  'yeah',
  'sure',
  'ok',
  'okay',
  'approve',
  'approved',
  'sounds good',
  'go ahead',
  'do it',
  '👍',
  '✅',
]);

const TRAILING_COURTESY = /(?:\s+(?:sir|maam|ma'am|please|thanks|thank you|mate|boss))+$/;
const SKIN_TONES = /[\u{1F3FB}-\u{1F3FF}]/gu;
const EMOJI_VARIATION_SELECTOR = /\uFE0F/g;
const NOT_A_WORD = /[^\p{L}\p{N}\p{Extended_Pictographic}\s']/gu;

export function looksLikeApproval(text: string): boolean {
  const plain = text
    .toLowerCase()
    .replace(SKIN_TONES, '')
    .replace(EMOJI_VARIATION_SELECTOR, '')
    .replace(NOT_A_WORD, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(TRAILING_COURTESY, '');
  return APPROVAL_PHRASES.has(plain);
}
