/** One line `git grep` matched. */
export interface GrepMatch {
  readonly path: string;
  readonly line: number;
  /** The line's text, trimmed and cut to `MAX_MATCH_TEXT`. */
  readonly text: string;
}

/** The most of a matched line kept. */
const MAX_MATCH_TEXT = 200;

/**
 * The matches of `git grep -n -z <rev>` output: `<rev>:<path>\0<line>\0<text>\n` per line. A last line cut
 * short by a byte cap is dropped, as is anything past `maxMatches`.
 */
export function parseGrepOutput(
  out: Buffer,
  rev: string,
  maxMatches: number,
): { matches: GrepMatch[]; cut: boolean } {
  const matches: GrepMatch[] = [];
  const prefix = `${rev}:`;
  let offset = 0;
  while (offset < out.length) {
    const end = out.indexOf(0x0a, offset);
    if (end === -1) return { matches, cut: true };
    const record = out.subarray(offset, end).toString('utf8');
    offset = end + 1;
    const first = record.indexOf('\0');
    const second = record.indexOf('\0', first + 1);
    if (first === -1 || second === -1 || !record.startsWith(prefix)) continue;
    const line = Number(record.slice(first + 1, second));
    if (!Number.isSafeInteger(line) || line < 1) continue;
    if (matches.length >= maxMatches) return { matches, cut: true };
    matches.push({
      path: record.slice(prefix.length, first),
      line,
      text: record
        .slice(second + 1)
        .trim()
        .slice(0, MAX_MATCH_TEXT),
    });
  }
  return { matches, cut: false };
}
