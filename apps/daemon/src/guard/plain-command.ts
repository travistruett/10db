const UNQUOTED = /[A-Za-z0-9_./:,@%+=-]/;
const DOUBLE_QUOTED_FORBIDDEN = /[$`\\!"]/;
const BLANK = new Set([' ', '\t']);
const REDIRECTS = ['2>&1', '>/dev/null', '2>/dev/null'];
/** zsh `=cmd` expansion: a word's start, or after `=` or `:` under MAGIC_EQUAL_SUBST. */
const EQUALS_EXPANSION = /(^|[=:])=/;

/** Every control character but tab: newlines and `\r` end or reshape a command. */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return true;
  }
  return false;
}

/**
 * Parses a command that uses only plain words, simple quoting and the separators `|`, `&&`,
 * `||` and `;`, and returns each segment's words exactly as the shell sees them (quotes
 * removed). Returns null for anything else: expansions, globs, comments, redirections other
 * than `2>&1`, `>/dev/null` and `2>/dev/null`, backgrounding, escapes, control characters and
 * empty segments. A word whose decoded value, quoted or not, has `=` at its start or right after `=` or `:`
 * is refused too: zsh expands `=cmd` to a path after removing empty quotes, and MAGIC_EQUAL_SUBST
 * does the same after an option's `=` and after a `:` in an assignment-like word. Because nothing outside this grammar is accepted, the words cannot
 * differ from what runs.
 */
export function plainCommandWords(command: string): string[][] | null {
  if (hasControl(command)) return null;
  const segments: string[][] = [];
  let words: string[] = [];
  let i = 0;
  const endOfToken = (at: number): boolean => {
    const ch = command.charAt(at);
    return at >= command.length || BLANK.has(ch) || ch === '|' || ch === '&' || ch === ';';
  };
  const endSegment = (): boolean => {
    if (words.length === 0) return false;
    segments.push(words);
    words = [];
    return true;
  };

  while (i < command.length) {
    const ch = command.charAt(i);
    if (BLANK.has(ch)) {
      i += 1;
      continue;
    }
    if (ch === ';') {
      if (!endSegment()) return null;
      i += 1;
      continue;
    }
    if ((ch === '|' || ch === '&') && command.charAt(i + 1) === ch) {
      if (!endSegment()) return null;
      i += 2;
      continue;
    }
    if (ch === '|') {
      if (command.charAt(i + 1) === '&' || !endSegment()) return null;
      i += 1;
      continue;
    }
    if (ch === '&') return null;
    const redirect = REDIRECTS.find((r) => command.startsWith(r, i));
    if (redirect !== undefined) {
      if (!BLANK.has(command.charAt(i - 1)) || !endOfToken(i + redirect.length)) return null;
      i += redirect.length;
      continue;
    }
    let word = '';
    while (i < command.length && !BLANK.has(command.charAt(i))) {
      const c = command.charAt(i);
      if (c === "'" || c === '"') {
        const end = command.indexOf(c, i + 1);
        if (end === -1) return null;
        const body = command.slice(i + 1, end);
        if (c === '"' && DOUBLE_QUOTED_FORBIDDEN.test(body)) return null;
        word += body;
        i = end + 1;
      } else if (UNQUOTED.test(c)) {
        word += c;
        i += 1;
      } else if (c === '|' || c === '&' || c === ';') {
        break;
      } else {
        return null;
      }
    }
    if (EQUALS_EXPANSION.test(word)) return null;
    words.push(word);
  }
  return endSegment() ? segments : null;
}
