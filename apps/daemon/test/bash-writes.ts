/** An interpreter one-liner, an in-place edit or tee, outside quotes. */
const WRITING_COMMAND = /python3?\s+-c|node\s+-e|perl\s+-\w*i|sed\s+-\w*i|\btee\b/;

/** A redirect that writes nothing: to a descriptor (`2>&1`, `>&2`) or to /dev/null (`>/dev/null`, `2>/dev/null`, `&>/dev/null`). */
const HARMLESS_REDIRECT = /(?:&|\d*)>>?\s*(?:&\d+|\/dev\/null\b)/g;

/** A quoted string, its quotes included; a backslash escapes inside double quotes. */
const QUOTED = /'[^']*'|"(?:\\.|[^"\\])*"/g;

/**
 * Whether a Bash command looks like it writes a file: an interpreter one-liner, an in-place
 * edit, tee, a heredoc or a redirect to something other than a descriptor or /dev/null. A `>`
 * or `<<` inside quotes (`grep -n '=>' f`) is an argument, not a redirect.
 */
export function bashWrites(command: string): boolean {
  const unquoted = command.replace(QUOTED, "''");
  if (WRITING_COMMAND.test(unquoted)) return true;
  const redirects = unquoted.replace(HARMLESS_REDIRECT, ' ');
  return redirects.includes('>') || redirects.includes('<<');
}
