/**
 * Characters that can hide, reorder or add lines to text the builder reads: C0 and C1 controls, the
 * Unicode line and paragraph separators, zero-width and joiner characters, and bidi controls.
 */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Repo-controlled text with every unsafe character shown as `\u{…}`, as the approval card shows it. */
export function visibleText(text: string): string {
  return text.replace(UNSAFE_CHARS, (c) => `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`);
}
