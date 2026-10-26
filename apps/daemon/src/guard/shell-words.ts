import { basename } from 'node:path';
import { decodeAnsiC } from './ansi-c';

export interface ShellSegment {
  /** The segment's text with quotes kept and comments and line continuations left out. */
  readonly raw: string;
  /** Words with quotes removed and escapes resolved. */
  readonly words: string[];
  /** The operator that ended the segment: `&&`, `||`, `;`, `|`, `&`, `(`, `)`, newline, or empty at the end. */
  readonly separator: string;
  /** The subshells around the segment, outermost first, each numbered in the order it opens. */
  readonly subshells: readonly number[];
  /**
   * Scripts the shell runs for the segment, in the directory the segment runs in: the bodies of its
   * `$(…)`, backtick, `<(…)` and `>(…)` substitutions, and its here-documents.
   */
  readonly nested: readonly string[];
  /**
   * The words are the ones the shell passes. False when an ANSI-C escape the scanner does not
   * decode keeps its `$'…'` text, or a lone `{` or `}` stands in the middle of a command, where zsh
   * may read it as a group.
   */
  readonly wordsCertain: boolean;
}

/** A command split into the segments it runs. */
interface ShellParse {
  readonly segments: ShellSegment[];
  /**
   * Every parenthesis opens a subshell where a command starts, opens a substitution, or closes one
   * of those, and every quote, parenthesis and substitution is closed. Otherwise a `)` may not end
   * the subshell it seems to, and a directory change inside may outlive it.
   */
  readonly certain: boolean;
}

interface Scan extends ShellParse {
  /** Where scanning stopped: past the `)` that closed a substitution, or the end of the command. */
  readonly end: number;
  /** The `)` that closes a substitution was found. */
  readonly closed: boolean;
}

interface HereDocument {
  readonly delimiter: string;
  /** `<<-`: tabs before the closing line are ignored. */
  readonly tabs: boolean;
  /** The nested scripts of the segment that reads it. */
  readonly into: string[];
}

/** The delimiter of a here-document whose `<<` ends just before `at`, with quotes and escapes removed. */
function hereDocumentDelimiter(
  command: string,
  at: number,
): { delimiter: string; tabs: boolean } | null {
  let i = at;
  const tabs = command.charAt(i) === '-';
  if (tabs) i += 1;
  while (command.charAt(i) === ' ' || command.charAt(i) === '\t') i += 1;
  let delimiter = '';
  let quote: string | null = null;
  for (; i < command.length; i += 1) {
    const ch = command.charAt(i);
    if (quote !== null) {
      if (ch === quote) quote = null;
      else delimiter += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '\\') {
      delimiter += command.charAt(i + 1);
      i += 1;
    } else if (/[\s;&|<>()]/.test(ch)) {
      break;
    } else {
      delimiter += ch;
    }
  }
  return delimiter === '' ? null : { delimiter, tabs };
}

/**
 * Moves the bodies of the here-documents a line opened, read from `at` (the start of the next
 * line), into the segments that read them, and returns where commands go on: after the last
 * closing line. A body with no closing line is left to be read as commands.
 */
function readHereDocuments(command: string, at: number, pending: readonly HereDocument[]): number {
  let resume = at;
  for (const doc of pending) {
    let line = resume;
    let closing = -1;
    for (;;) {
      const newline = command.indexOf('\n', line);
      const end = newline === -1 ? command.length : newline;
      const text = command.slice(line, end);
      if ((doc.tabs ? text.replace(/^\t+/, '') : text) === doc.delimiter) {
        closing = end;
        break;
      }
      if (newline === -1) break;
      line = newline + 1;
    }
    if (closing === -1) return resume;
    doc.into.push(command.slice(resume, line));
    resume = closing + 1;
  }
  return resume;
}

const SEPARATORS: ReadonlySet<string> = new Set([';', '|', '&']);

/** Reserved words a command may follow and still run, in this shell (`time` is a wrapper). */
const BEFORE_COMMAND: ReadonlySet<string> = new Set([
  '!',
  'if',
  'then',
  'elif',
  'else',
  'do',
  'while',
  'until',
]);
/** Words after which a lone `{` still opens a group: the reserved words above, and `time`. */
const GROUP_LEADERS: ReadonlySet<string> = new Set([...BEFORE_COMMAND, 'time']);

/**
 * Splits from `from` to the end of the command or, for a substitution, to the unquoted `)` that
 * closes it. Quotes, escapes, comments and here-documents are read as the shell reads them, so
 * a parenthesis or an operator inside one does not split.
 */
function scan(command: string, from: number, substitution: boolean): Scan {
  const segments: ShellSegment[] = [];
  // Open parentheses: a subshell's number, or null for one that is not a subshell.
  const parens: (number | null)[] = [];
  const pending: HereDocument[] = [];
  let certain = true;
  let wordsCertain = true;
  let opened = 0;
  let raw = '';
  let word = '';
  let inWord = false;
  let words: string[] = [];
  let nested: string[] = [];
  let quote: "'" | '"' | null = null;
  // The previous character, when it was neither quoted nor escaped.
  let lastPlain = '';

  // Where in the current word an ANSI-C escape decoded to a newline.
  let decodedNewlines: number[] = [];
  // The word's characters, with every quoted, escaped or decoded one blanked to NUL, so only the
  // literal `{ } , ..` the shell reads as brace syntax remain.
  let wordMask = '';
  // Brace groups opened by a lone `{` in command position and not yet closed. A `}` ending a word
  // closes one, which hides where that word really ends.
  let openGroups = 0;
  const addWord = (text: string, literal: boolean): void => {
    word += text;
    wordMask += literal ? text : '\0'.repeat(text.length);
    inWord = true;
  };
  const flushWord = (): void => {
    // A decoded newline is only read the same way at the end of a word (`IFS=$'\n'`).
    if (decodedNewlines.some((at) => at < word.length - 1)) {
      certain = false;
      wordsCertain = false;
    }
    // zsh may read a brace in a word as a group boundary, where bash keeps it. A `${…}` parameter
    // expansion's braces are blanked first. The word is uncertain when it holds an unmatched brace
    // (a `{` that opens a group, or a `}` that closes one opened earlier), or when a balanced
    // `{…}` stands in command position, where zsh runs it as a one-word group (`{pwd}`). A brace
    // expansion (a `,` or `..` between the braces) and a balanced `{…}` in an argument (`find {}`,
    // `echo {x}`) are literal in both shells. A lone brace token is handled above.
    const braces = wordMask.replace(/\$\{[^{}]*\}/g, (m) => '\0'.repeat(m.length));
    let pairs = braces.replace(/[^{}]/g, '');
    for (let prev = ''; pairs !== prev;) {
      prev = pairs;
      pairs = pairs.replace('{}', '');
    }
    const expansion = /\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(braces);
    const atCommand = words.every((w) => GROUP_LEADERS.has(w));
    const unmatchedClose = (pairs.match(/\}/g) ?? []).length;
    // A `}` that closes an open group, where the word's real end is hidden.
    const closesGroup = unmatchedClose > 0 && openGroups > 0;
    if (closesGroup) openGroups = Math.max(0, openGroups - unmatchedClose);
    if (
      !expansion &&
      (pairs.includes('{') || (atCommand && braces.startsWith('{')) || closesGroup)
    ) {
      certain = false;
      wordsCertain = false;
    }
    if (word !== '') words.push(word);
    word = '';
    wordMask = '';
    inWord = false;
    decodedNewlines = [];
  };
  const flush = (separator: string): void => {
    flushWord();
    const text = raw.trim();
    if (text !== '') {
      const subshells = parens.filter((p): p is number => p !== null);
      segments.push({ raw: text, words, separator, subshells, nested, wordsCertain });
    }
    raw = '';
    words = [];
    nested = [];
    wordsCertain = true;
  };
  // Where a lone `{` or `}` opens or closes a group: no word yet, or only reserved words a command
  // may follow, or after `function name`.
  const commandPosition = (): boolean =>
    word === '' &&
    (words.every((w) => GROUP_LEADERS.has(w)) || (words.length === 2 && words[0] === 'function'));
  const append = (text: string): void => {
    raw += text;
    addWord(text, false);
  };
  // A substitution's body runs as commands; its text stays in the word.
  const substitute = (at: number, bodyStart: number): number => {
    const inner = scan(command, bodyStart, true);
    if (!inner.closed) certain = false;
    nested.push(command.slice(bodyStart, inner.closed ? inner.end - 1 : inner.end));
    append(command.slice(at, inner.end));
    return inner.end - 1;
  };

  for (let i = from; i < command.length; i += 1) {
    const ch = command.charAt(i);
    const next = command.charAt(i + 1);
    const before = lastPlain;
    lastPlain = '';
    if (quote === "'") {
      raw += ch;
      if (ch === "'") quote = null;
      else addWord(ch, false);
      continue;
    }
    if (ch === '\\') {
      // A line continuation: the shell drops both characters.
      if (next === '\n') {
        i += 1;
        continue;
      }
      // Inside double quotes a backslash escapes only `$`, a backtick, `"` and itself.
      if (next === '' || (quote === '"' && !['$', '`', '"', '\\'].includes(next))) {
        append(ch);
        continue;
      }
      raw += ch + next;
      addWord(next, false);
      i += 1;
      continue;
    }
    if (ch === '$' && next === '(') {
      i = substitute(i, i + 2);
      continue;
    }
    if (ch === '`') {
      let j = i + 1;
      while (j < command.length && command.charAt(j) !== '`')
        j += command.charAt(j) === '\\' ? 2 : 1;
      if (j >= command.length) certain = false;
      const end = Math.min(j, command.length);
      nested.push(command.slice(i + 1, end).replace(/\\([`$\\])/g, '$1'));
      append(command.slice(i, end + 1));
      i = end;
      continue;
    }
    if (quote === '"') {
      raw += ch;
      if (ch === '"') quote = null;
      else addWord(ch, false);
      continue;
    }
    if (ch === '$' && next === "'") {
      // ANSI-C quoting, decoded with bash's escape set. The raw text gets the decoded word in
      // single quotes, so rules that read the text see what the shell passes. A body that does not
      // decode exactly, or is never closed, keeps its `$'…'` text and leaves the words uncertain.
      let j = i + 2;
      while (j < command.length && command.charAt(j) !== "'")
        j += command.charAt(j) === '\\' && j + 1 < command.length ? 2 : 1;
      const end = Math.min(j, command.length);
      const text = command.slice(i, end + 1);
      const ansi = decodeAnsiC(command.slice(i + 2, end));
      if (!ansi.exact || j >= command.length) {
        certain = false;
        wordsCertain = false;
        raw += text;
        addWord(text, false);
      } else {
        // Permission rules match plain text only, so any real escape keeps them away.
        if (ansi.escapes) certain = false;
        decodedNewlines.push(...ansi.newlines.map((at) => word.length + at));
        raw += `'${ansi.text.replaceAll("'", "'\\''")}'`;
        addWord(ansi.text, false);
      }
      inWord = true;
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      raw += ch;
      inWord = true;
      continue;
    }
    // A comment starts where a word could and runs to the end of the line.
    if (ch === '#' && !inWord) {
      const newline = command.indexOf('\n', i);
      i = (newline === -1 ? command.length : newline) - 1;
      continue;
    }
    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      flush(ch + next);
      i += 1;
      continue;
    }
    // Inside `${…}`, `$[…]` or a substitution's word, `<<` is text or a shift, not a here-document.
    const hereDocument = !/[$`{[]/.test(word);
    if (
      hereDocument &&
      ch === '<' &&
      next === '<' &&
      command.charAt(i + 2) !== '<' &&
      before !== '<'
    ) {
      const doc = hereDocumentDelimiter(command, i + 2);
      if (doc) pending.push({ ...doc, into: nested });
      append('<<');
      i += 1;
      continue;
    }
    // zsh's clobber operators `>!`, `>>!`, `&>!`, `2>!` and `>|`: a `!` or `|` straight after a `>`
    // belongs to the redirection, not a word or a pipe, and bash does not read it, so the segment
    // is uncertain. The `|` must not split into a pipe.
    if ((ch === '!' || ch === '|') && before === '>') {
      certain = false;
      wordsCertain = false;
    }
    // A lone `&` backgrounds the command before it; `>&`, `<&` and `&>` are redirections, and a
    // `>|` clobber is not a pipe.
    const redirection =
      (ch === '&' && (before === '>' || before === '<' || next === '>')) ||
      (ch === '|' && before === '>');
    if (SEPARATORS.has(ch) && !redirection) {
      flush(ch);
      continue;
    }
    if (ch === '\n') {
      flush('\n');
      if (pending.length > 0) {
        i = readHereDocuments(command, i + 1, pending) - 1;
        pending.length = 0;
      }
      continue;
    }
    if (ch === '(') {
      if (before === '<' || before === '>') {
        i = substitute(i, i + 1);
      } else if (raw.trim() === '') {
        // `((` is arithmetic, where `<<` shifts instead of opening a here-document.
        if (next === '(') certain = false;
        flush('(');
        opened += 1;
        parens.push(opened);
      } else {
        // A function's `()`, an array or a case pattern: not a subshell.
        certain = false;
        flush('(');
        parens.push(null);
      }
      continue;
    }
    if (ch === ')') {
      if (parens.length > 0) {
        flush(')');
        parens.pop();
      } else if (substitution) {
        flush('');
        return { segments, certain, end: i + 1, closed: true };
      } else {
        // A case pattern's `)`, or one with nothing to close.
        certain = false;
        flush(')');
      }
      continue;
    }
    // `{` and `}` only open or close a group when they stand alone as words where a command
    // starts. Anywhere else bash passes them as words, while zsh may still read a group there.
    if ((ch === '{' || ch === '}') && !inWord && /^[\s;]?$/.test(next)) {
      if (commandPosition()) {
        if (ch === '{') openGroups += 1;
        else openGroups = Math.max(0, openGroups - 1);
        flush('');
        continue;
      }
      certain = false;
      wordsCertain = false;
    }
    raw += ch;
    if (ch === ' ' || ch === '\t') {
      flushWord();
    } else {
      addWord(ch, true);
      lastPlain = ch;
    }
  }
  flush('');
  if (parens.length > 0 || quote !== null) certain = false;
  return { segments, certain, end: command.length, closed: false };
}

/** The segments a command runs, in order, each with the scripts nested in it. */
export function parseShell(command: string): ShellParse {
  const { segments, certain } = scan(command, 0, false);
  return { segments, certain };
}

/**
 * Splits a shell command at unquoted `&&`, `||`, `;`, `|`, `&`, newlines, parentheses and standalone
 * braces. The scripts nested in a segment (substitution bodies and here-documents) are split too and
 * appended as their own segments, because they run as commands.
 */
export function splitCommand(command: string): ShellSegment[] {
  const { segments } = parseShell(command);
  return [...segments, ...segments.flatMap((s) => s.nested.flatMap((body) => splitCommand(body)))];
}

/** Reserved words of loops and functions, whose commands run later, again or not at all. */
const OUT_OF_ORDER: ReadonlySet<string> = new Set([
  'for',
  'while',
  'until',
  'select',
  'repeat',
  'foreach',
  'function',
  'do',
  'done',
  'coproc',
]);

/** A `<` or `>`, which may be part of a redirection the guard does not read, such as `{fd}>x`. */
const ANGLE = /[<>]/;
/** A redirection word: an optional descriptor (`2`, `&`), the operator, and its target if attached. */
const REDIRECTION_WORD = /^(?:\d+|&)?(?:<<<|<<-?|<>|<&|>>|>\||>&|<|>)/;

/**
 * How many words a redirection at `at` takes: none when the word is not one, one when its target is
 * attached (`2>/dev/null`), two when the target is the next word (`> out`).
 */
function redirectionSpan(words: readonly string[], at: number): number {
  const word = words[at] ?? '';
  const operator = REDIRECTION_WORD.exec(word);
  if (!operator) return 0;
  return operator[0] === word ? 2 : 1;
}

/**
 * The words of a segment from its command on, past the reserved words and the redirections before
 * it (`2>/dev/null rm` runs `rm`): whether a `!` inverts its status, and whether it belongs to a
 * loop or a function.
 */
export function leadingWords(words: readonly string[]): {
  readonly command: string[];
  readonly negated: boolean;
  readonly outOfOrder: boolean;
  /** A word before the command holds a `<` or `>` that is not a redirection the guard reads. */
  readonly hiddenByRedirection: boolean;
} {
  let negated = false;
  let outOfOrder = false;
  let hiddenByRedirection = false;
  let i = 0;
  while (i < words.length) {
    const word = words[i] ?? '';
    const redirection = redirectionSpan(words, i);
    if (redirection > 0) {
      i += redirection;
      continue;
    }
    if (ANGLE.test(word)) hiddenByRedirection = true;
    if (OUT_OF_ORDER.has(word)) outOfOrder = true;
    if (!BEFORE_COMMAND.has(word)) break;
    if (word === '!') negated = true;
    i += 1;
  }
  return { command: words.slice(i), negated, outOfOrder, hiddenByRedirection };
}

interface Wrapper {
  /** Flags that take the next word as their value. */
  readonly valueFlags: ReadonlySet<string>;
  /** Positional words before the wrapped command, such as `timeout`'s duration. */
  readonly positionals: number;
}
const wrapper = (valueFlags: readonly string[] = [], positionals = 0): Wrapper => ({
  valueFlags: new Set(valueFlags),
  positionals,
});

/** Wrappers that run the rest of the line. */
const WRAPPERS: ReadonlyMap<string, Wrapper> = new Map([
  ['env', wrapper(['-u', '-C', '-S', '-P', '--unset', '--chdir', '--split-string'])],
  ['command', wrapper()],
  ['nohup', wrapper()],
  ['time', wrapper(['-f', '-o', '--format', '--output'])],
  ['exec', wrapper(['-a'])],
  ['xargs', wrapper(['-n', '-I', '-P', '-L', '-s', '-d', '-E', '-a'])],
]);

/**
 * Further wrappers that run the rest of the line. The guard looks through them to judge the command
 * they run; a permission prefix keeps them as the command, so they are separate.
 */
const RUNNER_WRAPPERS: ReadonlyMap<string, Wrapper> = new Map([
  ['nice', wrapper(['-n', '--adjustment'])],
  ['timeout', wrapper(['-s', '-k', '--signal', '--kill-after'], 1)],
  ['caffeinate', wrapper(['-t', '-w'])],
  ['stdbuf', wrapper(['-i', '-o', '-e'])],
  ['builtin', wrapper()],
]);

/** A command's name as the shell would run it: `/usr/bin/git` and `\git` are both `git`. */
function commandName(word: string): string {
  return basename(word.replace(/^\\+/, ''));
}

/**
 * How many words a wrapper's flag takes. A short-flag cluster reads as getopt reads it: its first
 * letter that takes a value takes the rest of the word, or the next word when it is the last letter,
 * so `env -iP /tmp/x git` runs `git`.
 */
function flagSpan(flag: string, valueFlags: ReadonlySet<string>): number {
  if (valueFlags.has(flag)) return 2;
  if (flag.startsWith('--')) return 1;
  for (let i = 1; i < flag.length; i += 1) {
    if (valueFlags.has(`-${flag.charAt(i)}`)) return i === flag.length - 1 ? 2 : 1;
  }
  return 1;
}

interface Prefixes {
  /** Where the command starts. */
  readonly at: number;
  /** The flags each wrapper was given, by the wrapper's name. */
  readonly flags: readonly { readonly wrapper: string; readonly flag: string }[];
  /**
   * With `skipRedirections`: a redirection follows a wrapper, where it may stand for a flag's
   * value, or a word holds a `<` or `>` that is not a redirection the guard reads.
   */
  readonly hidden: boolean;
}

/**
 * Walks the leading `VAR=value` assignments and pass-through wrappers with their flags. With
 * `skipRedirections`, redirections before the first wrapper are skipped (`X=1 >x rm` runs `rm`),
 * and any other `<` or `>` up to the command marks the walk `hidden`: after a wrapper a redirection
 * may sit where a flag's value goes (`env -u >x FOO rm`), and `{fd}>x` is not read at all.
 */
function prefixes(
  words: readonly string[],
  lookThroughRunners: boolean,
  skipRedirections = false,
): Prefixes {
  const flags: { wrapper: string; flag: string }[] = [];
  const angled = (from: number, to: number): boolean =>
    skipRedirections && words.slice(from, to).some((w) => ANGLE.test(w));
  let wrappers = 0;
  let i = 0;
  while (i < words.length) {
    const w = words[i] ?? '';
    const name = commandName(w);
    const wrapped =
      WRAPPERS.get(name) ?? (lookThroughRunners ? RUNNER_WRAPPERS.get(name) : undefined);
    const redirection = skipRedirections ? redirectionSpan(words, i) : 0;
    if (redirection > 0 && wrappers === 0) {
      i += redirection;
    } else if (angled(i, i + 1)) {
      return { at: i, flags, hidden: true };
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i += 1;
    } else if (wrapped) {
      wrappers += 1;
      i += 1;
      while (i < words.length && (words[i] ?? '').startsWith('-')) {
        const flag = words[i] ?? '';
        const span = flagSpan(flag, wrapped.valueFlags);
        if (angled(i, i + span)) return { at: i, flags, hidden: true };
        flags.push({ wrapper: name, flag });
        i += span;
      }
      if (angled(i, i + wrapped.positionals + 1)) return { at: i, flags, hidden: true };
      i += wrapped.positionals;
    } else {
      break;
    }
  }
  return { at: i, flags, hidden: false };
}

/**
 * Whether a redirection among a command's prefix words, or one the guard does not read, may hide
 * which command runs (see `prefixes`).
 */
export function redirectionHidesCommand(words: readonly string[]): boolean {
  return prefixes(words, true, true).hidden;
}

/**
 * Drops leading `VAR=value` assignments and pass-through wrappers such as `env`, `nohup` and
 * `xargs` together with their flags, and names the command it finds by its basename. With
 * `keepCommandPath` the command keeps the path it was written with: `/tmp/x/git` runs another
 * program than `git`. With `skipRedirections` the redirections among them are dropped too, so the
 * guard judges the command they would hide.
 */
export function stripCommandPrefixes(
  words: readonly string[],
  options: {
    readonly lookThroughRunners?: boolean;
    readonly keepCommandPath?: boolean;
    readonly skipRedirections?: boolean;
  } = {},
): string[] {
  const at = prefixes(
    words,
    options.lookThroughRunners === true,
    options.skipRedirections === true,
  ).at;
  const rest = words.slice(at);
  const head = rest[0];
  if (head === undefined || options.keepCommandPath === true) return rest;
  return [commandName(head), ...rest.slice(1)];
}

/** env's flags that take a value, so a letter after one in a cluster is part of that value. */
const ENV_VALUE_LETTERS: ReadonlySet<string> = new Set(['u', 'C', 'P']);
/** GNU env's long options, spelled in full. */
const ENV_LONG_OPTIONS: ReadonlySet<string> = new Set([
  '--ignore-environment',
  '--null',
  '--unset',
  '--chdir',
  '--split-string',
  '--block-signal',
  '--default-signal',
  '--ignore-signal',
  '--list-signal-handling',
  '--debug',
  '--help',
  '--version',
]);

/**
 * Whether an env word is a long option not spelled in full. GNU env takes any unique abbreviation,
 * so in `env --uns X git status` X is a value, not the program; 10db reads none of them. `--` only
 * ends the options.
 */
function isUnknownEnvLongFlag(flag: string): boolean {
  if (!flag.startsWith('--') || flag === '--') return false;
  return !ENV_LONG_OPTIONS.has(flag.split('=')[0] ?? flag);
}

/** Whether env's flag is its split string: `-S`, attached or in a cluster such as `-iS`, or `--split-string`. */
function isSplitString(flag: string): boolean {
  if (flag.startsWith('--')) return (flag.split('=')[0] ?? flag) === '--split-string';
  for (const letter of flag.slice(1)) {
    if (letter === 'S') return true;
    if (ENV_VALUE_LETTERS.has(letter)) return false;
  }
  return false;
}

/**
 * Whether env hides the command it runs: a split string, which env splits into a command of its own,
 * or a long option not spelled in full, after which the guard can't tell a value from the program.
 */
export function hidesEnvCommand(words: readonly string[]): boolean {
  return prefixes(words, true, true).flags.some(
    (f) => f.wrapper === 'env' && (isSplitString(f.flag) || isUnknownEnvLongFlag(f.flag)),
  );
}

const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const FIND_EXEC_END = new Set([';', '\\;', '\\', '+']);

/** The commands a `find` runs through `-exec` and its kin, each without its `;` or `+` terminator. */
export function findExecCommands(words: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < words.length; i += 1) {
    if (!FIND_EXEC.has(words[i] ?? '')) continue;
    const command: string[] = [];
    for (i += 1; i < words.length && !FIND_EXEC_END.has(words[i] ?? ''); i += 1)
      command.push(words[i] ?? '');
    out.push(command);
  }
  return out;
}
