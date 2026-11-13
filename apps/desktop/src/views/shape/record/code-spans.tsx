import { Code } from '@mantine/core';
import type { ReactNode } from 'react';

// A reviewer's or a decision's words are plain text, but they quote code in backticks as markdown
// does; each code span is drawn as code, as the documents draw it, and the rest stays text.

/**
 * The longest text read for code spans. A run with no closer is searched to the end, so a long text of
 * unmatched runs costs more than linear time; past this it stays plain, which loses nothing.
 */
export const CODE_SPANS_MAX_LENGTH = 64 * 1024;

/** The text cut into plain runs and code spans, each span without its backticks. */
export function codeSpans(text: string): { readonly code: boolean; readonly text: string }[] {
  if (text.length > CODE_SPANS_MAX_LENGTH) return [{ code: false, text }];
  const out: { code: boolean; text: string }[] = [];
  let plain = 0;
  let i = 0;
  while (i < text.length) {
    if (text.charAt(i) !== '`') {
      i += 1;
      continue;
    }
    let j = i;
    while (text.charAt(j) === '`') j += 1;
    const fence = text.slice(i, j);
    // The span ends at the next run of exactly as many backticks.
    let close = text.indexOf(fence, j);
    while (close >= 0 && text.charAt(close + fence.length) === '`') {
      let k = close;
      while (text.charAt(k) === '`') k += 1;
      close = text.indexOf(fence, k);
    }
    if (close < 0) {
      i = j;
      continue;
    }
    if (i > plain) out.push({ code: false, text: text.slice(plain, i) });
    const inner = text.slice(j, close);
    const padded = inner.length > 1 && inner.startsWith(' ') && inner.endsWith(' ');
    out.push({ code: true, text: padded && inner.trim() !== '' ? inner.slice(1, -1) : inner });
    i = close + fence.length;
    plain = i;
  }
  if (plain < text.length) out.push({ code: false, text: text.slice(plain) });
  return out;
}

export function CodeSpans({ text }: { readonly text: string }): ReactNode {
  return codeSpans(text).map((part, i) =>
    // A part is its place in the text, which never reorders.
    part.code ? <Code key={i}>{part.text}</Code> : <span key={i}>{part.text}</span>,
  );
}
