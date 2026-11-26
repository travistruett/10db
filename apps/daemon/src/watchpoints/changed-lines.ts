/** A line is cut to this many characters before a pattern is tested, so no pattern runs long on a minified line. */
const MAX_LINE_CHARS = 2000;

/**
 * The added and removed lines of a unified diff, without the marker, without each file's `---`/`+++` header and
 * without a trailing carriage return, each cut to `MAX_LINE_CHARS`; `cut` says some line was, so the file was not
 * read in full, and `hunk` says the patch had any hunk (a binary file or a `-diff` one has none). A header is the lines between `diff --git` and the first `@@`; inside a hunk every `+` or `-` line is
 * content, even one that starts `---`.
 */
export function changedLines(patch: string): { lines: string[]; cut: boolean; hunk: boolean } {
  const lines: string[] = [];
  let cut = false;
  let inHunk = false;
  let hunk = false;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('diff --git ')) inHunk = false;
    else if (raw.startsWith('@@')) inHunk = hunk = true;
    else if (inHunk && (raw.startsWith('+') || raw.startsWith('-'))) {
      const line = raw.slice(1).replace(/\r$/, '');
      if (line.length > MAX_LINE_CHARS) cut = true;
      lines.push(line.slice(0, MAX_LINE_CHARS));
    }
  }
  return { lines, cut, hunk };
}
