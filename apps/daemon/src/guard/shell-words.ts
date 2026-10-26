import { basename } from 'node:path';

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
  let opened = 0;
  let raw = '';
  let word = '';
  let inWord = false;
  let words: string[] = [];
  let nested: string[] = [];
  let quote: "'" | '"' | null = null;
  // The previous character, when it was neither quoted nor escaped.
  let lastPlain = '';

  const flushWord = (): void => {
    if (word !== '') words.push(word);
    word = '';
    inWord = false;
  };
  const flush = (separator: string): void => {
    flushWord();
    const text = raw.trim();
    if (text !== '') {
      const subshells = parens.filter((p): p is number => p !== null);
      segments.push({ raw: text, words, separator, subshells, nested });
    }
    raw = '';
    words = [];
    nested = [];
  };
  const append = (text: string): void => {
    raw += text;
    word += text;
    inWord = true;
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
      else word += ch;
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
      word += next;
      inWord = true;
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
      else word += ch;
      continue;
    }
    if (ch === '$' && next === "'") {
      // ANSI-C quoting: a backslash escapes a quote, a backslash or a double quote; every other
      // escape (`\n`, `\t`, `\x41`) decodes to a character this scanner does not model.
      let j = i + 2;
      while (j < command.length && command.charAt(j) !== "'") {
        const escaped = command.charAt(j) === '\\' && j + 1 < command.length;
        if (escaped && !`'\\"`.includes(command.charAt(j + 1))) certain = false;
        word += command.charAt(escaped ? j + 1 : j);
        j += escaped ? 2 : 1;
      }
      if (j >= command.length) certain = false;
      const end = Math.min(j, command.length);
      raw += command.slice(i, end + 1);
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
    // A lone `&` backgrounds the command before it; `>&`, `<&` and `&>` are redirections.
    const redirection = ch === '&' && (before === '>' || before === '<' || next === '>');
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
    // `{` and `}` only open or close a group when they stand alone as words.
    if ((ch === '{' || ch === '}') && !inWord && /^[\s;]?$/.test(next)) {
      flush('');
      continue;
    }
    raw += ch;
    if (ch === ' ' || ch === '\t') {
      flushWord();
    } else {
      word += ch;
      inWord = true;
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

/**
 * The words of a segment from its command on, past the reserved words before it: whether a `!`
 * inverts its status, and whether it belongs to a loop or a function.
 */
export function leadingWords(words: readonly string[]): {
  readonly command: string[];
  readonly negated: boolean;
  readonly outOfOrder: boolean;
} {
  let negated = false;
  let outOfOrder = false;
  let i = 0;
  for (; i < words.length; i += 1) {
    const word = words[i] ?? '';
    if (OUT_OF_ORDER.has(word)) outOfOrder = true;
    if (!BEFORE_COMMAND.has(word)) break;
    if (word === '!') negated = true;
  }
  return { command: words.slice(i), negated, outOfOrder };
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
  ['env', wrapper(['-u', '-C', '-S', '-P', '--unset', '--chdir'])],
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
export function flagSpan(flag: string, valueFlags: ReadonlySet<string>): number {
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
}

/** Walks the leading `VAR=value` assignments and pass-through wrappers with their flags. */
function prefixes(words: readonly string[], lookThroughRunners: boolean): Prefixes {
  const flags: { wrapper: string; flag: string }[] = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i] ?? '';
    const name = commandName(w);
    const wrapped =
      WRAPPERS.get(name) ?? (lookThroughRunners ? RUNNER_WRAPPERS.get(name) : undefined);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i += 1;
    } else if (wrapped) {
      i += 1;
      while (i < words.length && (words[i] ?? '').startsWith('-')) {
        const flag = words[i] ?? '';
        flags.push({ wrapper: name, flag });
        i += flagSpan(flag, wrapped.valueFlags);
      }
      i += wrapped.positionals;
    } else {
      break;
    }
  }
  return { at: i, flags };
}

/**
 * Drops leading `VAR=value` assignments and pass-through wrappers such as `env`, `nohup` and
 * `xargs` together with their flags, and names the command it finds by its basename. With
 * `keepCommandPath` the command keeps the path it was written with: `/tmp/x/git` runs another
 * program than `git`.
 */
export function stripCommandPrefixes(
  words: readonly string[],
  options: { readonly lookThroughRunners?: boolean; readonly keepCommandPath?: boolean } = {},
): string[] {
  const rest = words.slice(prefixes(words, options.lookThroughRunners === true).at);
  const head = rest[0];
  if (head === undefined || options.keepCommandPath === true) return rest;
  return [commandName(head), ...rest.slice(1)];
}

/** env's flags that take a value, so a letter after one in a cluster is part of that value. */
const ENV_VALUE_LETTERS: ReadonlySet<string> = new Set(['u', 'C', 'P']);

/**
 * Whether env's flag is its split string: `-S`, attached or in a cluster such as `-iS`, or
 * `--split-string`, abbreviated as GNU env allows. `-uS` unsets a variable named S.
 */
function isSplitString(flag: string): boolean {
  if (flag.startsWith('--')) {
    const name = flag.split('=')[0] ?? flag;
    return name.length > 2 && '--split-string'.startsWith(name);
  }
  for (const letter of flag.slice(1)) {
    if (letter === 'S') return true;
    if (ENV_VALUE_LETTERS.has(letter)) return false;
  }
  return false;
}

/**
 * Whether the command runs through env with a split string, which env splits into words and runs
 * as a command of its own the guard never reads.
 */
export function runsEnvSplitString(words: readonly string[]): boolean {
  return prefixes(words, true).flags.some((f) => f.wrapper === 'env' && isSplitString(f.flag));
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
