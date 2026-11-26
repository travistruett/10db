/** A line is cut to this many characters before a pattern is tested, so no pattern runs long on a minified line. */
const MAX_LINE_CHARS = 2000;

/**
 * The added and removed lines of a unified diff, without the marker and without each file's `---`/`+++` header,
 * each cut to `MAX_LINE_CHARS`. A header is the lines between `diff --git` and the first `@@`; inside a hunk every
 * `+` or `-` line is content, even one that starts `---`.
 */
export function changedLines(patch: string): string[] {
  const out: string[] = [];
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) inHunk = false;
    else if (line.startsWith('@@')) inHunk = true;
    else if (inHunk && (line.startsWith('+') || line.startsWith('-')))
      out.push(line.slice(1, 1 + MAX_LINE_CHARS));
  }
  return out;
}
