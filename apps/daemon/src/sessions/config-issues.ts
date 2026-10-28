import type { z } from 'zod';

/** Characters that can hide, reorder or add lines to text the builder reads. */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** A path segment from a repo file, with every unsafe character shown as `\n` or `\u{…}`. */
function shownSegment(segment: PropertyKey): string {
  return String(segment).replace(UNSAFE_CHARS, (c) =>
    c === '\n' ? '\\n' : `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`,
  );
}

/**
 * A repo config file's validation issues as one line for a flag. A key the repo wrote is part of an
 * issue's path, so it is escaped: it can add no line to the flag and reorder none of its text.
 */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.map(shownSegment).join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}
