const UNQUOTED = /[A-Za-z0-9_./:,@%+=-]/;
const DOUBLE_QUOTED_FORBIDDEN = /[$`\\!"]/;
const BLANK = new Set([' ', '\t']);
const REDIRECTS = ['2>&1', '>/dev/null', '2>/dev/null'];
/** The words, as source text and as the shell sees them, that group or negate a `find`'s tests. */
const GROUPING: readonly { readonly text: string; readonly word: string }[] = [
  { text: '\\(', word: '(' },
  { text: '\\)', word: ')' },
  { text: '!', word: '!' },
];
/** zsh `=cmd` expansion: a word's start, or after `=` or `:` under MAGIC_EQUAL_SUBST. */
export const EQUALS_EXPANSION = /(^|[=:])=/;

/**
 * With `optionGlobs`, `*`, `?` and `[`/`]` are plain in an option's value (`--include=*.ts`): after
 * the `=` of a word that starts with `-`. The shell tries the word as a file name pattern, but a
 * match must begin with the literal text before the glob (`--include=`), so it can only be a file
 * named that way, never another option such as `-delete`. In any other word the shell would fill in
 * file names the guard cannot see, so those stay refused.
 */
function isOptionGlob(wordSoFar: string, c: string): boolean {
  return wordSoFar.startsWith('-') && wordSoFar.includes('=') && '*?[]'.includes(c);
}

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
 * empty segments. The one escape accepted is a whole word `\(` or `\)` (the words `(` and `)`),
 * and a bare `!` after the command is the word `!`: `find`'s grouping and negation. A word whose decoded value, quoted or not, has `=` at its start or right after `=` or `:`
 * is refused too: zsh expands `=cmd` to a path after removing empty quotes, and MAGIC_EQUAL_SUBST
 * does the same after an option's `=` and after a `:` in an assignment-like word. Because nothing outside this grammar is accepted, the words cannot
 * differ from what runs.
 */
export function plainCommandWords(
  command: string,
  options: { readonly optionGlobs?: boolean } = {},
): string[][] | null {
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
    // A whole word that is `\(`, `\)` or `!` is the word `(`, `)` or `!`: find's grouping and
    // negation operators, which only combine tests. A `\` before the paren is the one escape
    // accepted, and only when it makes the whole word, so no other character is ever escaped.
    // A bare `!` counts after the command only; as the command it negates the pipeline.
    const group = GROUPING.find(
      (g) => command.startsWith(g.text, i) && endOfToken(i + g.text.length),
    );
    if (group !== undefined && (group.text !== '!' || words.length > 0)) {
      words.push(group.word);
      i += group.text.length;
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
      } else if (UNQUOTED.test(c) || (options.optionGlobs === true && isOptionGlob(word, c))) {
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
