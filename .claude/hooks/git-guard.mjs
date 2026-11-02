#!/usr/bin/env node
// PreToolUse guard for Bash commands in this repository. It enforces the git rules in AGENTS.md.
// Fail-open: any parse problem or internal error allows the command, because a broken guard must
// never wedge a session. Kill switch: TENDB_GIT_GUARD=off in the environment Claude Code starts
// with. A Bash command can't set it for the hook, and there is no kill-switch file an agent could
// write.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

/**
 * @typedef {{
 *   raw: string,
 *   words: string[],
 *   separator: string,
 *   closesExpansion: boolean,
 *   substitutions: string[],
 *   heredocs: string[],
 * }} Segment
 * `raw` keeps the segment text for quote-aware checks, `separator` is the operator that ended it,
 * `closesExpansion` is true when that operator is the `)` of a `$(...)`, `<(...)`, `>(...)` or
 * `$((...))` rather than of a subshell, `substitutions` holds the commands of `$(...)` and backticks that run inside double quotes or an
 * unquoted heredoc, and `heredocs` holds the bodies of heredocs fed to the segment.
 */

/**
 * Reads a heredoc marker (`<<WORD`, `<<-WORD`, quoted or escaped parts allowed) at the start of
 * `text`. The delimiter is a full shell word. Returns null for anything it can't read with
 * certainty, so the caller treats the text as ordinary commands instead of skipping it.
 * @param {string} text
 * @returns {{ length: number, delimiter: string, stripTabs: boolean, quoted: boolean } | null}
 */
function readHeredocMarker(text) {
  const opener = /^<<(-?)[ \t]*/.exec(text);
  if (!opener) return null;
  let i = opener[0].length;
  let delimiter = '';
  let quoted = false;
  while (i < text.length && !/[\s;|&()<>]/.test(text[i])) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const close = text.indexOf(ch, i + 1);
      const part = close < 0 ? '' : text.slice(i + 1, close);
      if (close < 0 || /[\\\n]/.test(part) || (ch === '"' && /[$`]/.test(part))) return null;
      delimiter += part;
      quoted = true;
      i = close + 1;
    } else if (ch === '\\') {
      if (i + 1 >= text.length || text[i + 1] === '\n') return null;
      delimiter += text[i + 1];
      quoted = true;
      i += 2;
    } else if (ch === '$' || ch === '`') {
      return null;
    } else {
      delimiter += ch;
      i += 1;
    }
  }
  if (delimiter === '') return null;
  return { length: i, delimiter, stripTabs: opener[1] === '-', quoted };
}

/**
 * The command inside the `$(...)` or backtick substitution that starts at `pos`, and where the
 * substitution ends. A substitution that never closes runs to the end of the text, so everything
 * after it is judged as commands.
 * @param {string} source
 * @param {number} pos
 * @returns {{ inner: string, end: number }}
 */
function substitutionSpan(source, pos) {
  if (source[pos] === '`') {
    let i = pos + 1;
    while (i < source.length && source[i] !== '`') i += source[i] === '\\' ? 2 : 1;
    if (i >= source.length) return { inner: source.slice(pos + 1), end: source.length };
    return { inner: source.slice(pos + 1, i), end: i + 1 };
  }
  const nested = new Scanner(source, pos + 2, true);
  nested.scan();
  if (nested.closedAt === null) return { inner: source.slice(pos + 2), end: source.length };
  return { inner: source.slice(pos + 2, nested.closedAt), end: nested.closedAt + 1 };
}

/**
 * The commands of every `$(...)` and backtick substitution in text that the shell expands.
 * @param {string} text
 */
function expansionsIn(text) {
  /** @type {string[]} */
  const found = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\') i += 2;
    else if (text[i] === '`' || (text[i] === '$' && text[i + 1] === '(')) {
      const span = substitutionSpan(text, i);
      found.push(span.inner);
      i = span.end;
    } else i += 1;
  }
  return found;
}

/**
 * A small shell tokenizer: it only needs to find where commands start and what their words are.
 * It understands quotes, backslash escapes, `#` comments, heredoc bodies, command separators
 * and command substitutions, which is enough to stop any of them from hiding a later command.
 * Where it can't be sure (an unreadable heredoc delimiter, an unclosed substitution), it keeps
 * the text as commands rather than skipping it.
 */
class Scanner {
  /**
   * @param {string} source
   * @param {number} [start] where to begin reading
   * @param {boolean} [stopAtParen] stop at the `)` that closes a `$(` the caller is inside
   */
  constructor(source, start = 0, stopAtParen = false) {
    this.source = source;
    this.pos = start;
    this.stopAtParen = stopAtParen;
    /** Index of the closing `)` once stopAtParen found it, else null. @type {number | null} */
    this.closedAt = null;
    /** @type {Segment[]} */
    this.out = [];
    this.raw = '';
    this.word = '';
    /** @type {string[]} */
    this.words = [];
    /** @type {string[]} */
    this.substitutions = [];
    /** @type {string | null} */
    this.quote = null;
    /** True while inside `$'...'`, where a backslash escapes any character. */
    this.ansiQuote = false;
    this.parenDepth = 0;
    /** For each open `(`: whether it opens an expansion rather than a subshell. @type {boolean[]} */
    this.openParens = [];
    /** Whether the last `)` read closed an expansion. */
    this.closedExpansion = false;
    /** Open parentheses of the `$((...))` or `((...))` being read; heredocs can't start there. */
    this.arithParens = 0;
    /** Whether the arithmetic being read opened with `$((`, an expansion, not a bare `((`. */
    this.arithExpansion = false;
    /**
     * @type {{
     *   delimiter: string,
     *   stripTabs: boolean,
     *   quoted: boolean,
     *   segmentIndex: number,
     * }[]}
     */
    this.pendingHeredocs = [];
  }

  /** @returns {Segment[]} */
  scan() {
    while (this.pos < this.source.length && this.closedAt === null) {
      if (this.quote) this.scanQuoted();
      else this.scanUnquoted();
    }
    this.endSegment('');
    return this.out;
  }

  endWord() {
    if (this.word !== '') this.words.push(this.word);
    this.word = '';
  }

  /**
   * @param {string} separator
   * @param {boolean} [closesExpansion] the separator is a `)` that closes a `$(`, `<(`, `>(` or `$((`
   */
  endSegment(separator, closesExpansion = false) {
    this.endWord();
    if (this.raw.trim() !== '') {
      this.out.push({
        raw: this.raw.trim(),
        words: this.words,
        separator,
        closesExpansion,
        substitutions: this.substitutions,
        heredocs: [],
      });
    }
    this.raw = '';
    this.words = [];
    this.substitutions = [];
  }

  /** Text that belongs to the current word, kept verbatim in the raw segment text too. */
  append(/** @type {string} */ text, /** @type {string} */ wordText = text) {
    this.raw += text;
    this.word += wordText;
  }

  scanUnquoted() {
    const ch = this.source[this.pos];
    if (ch === '\\') this.scanEscape();
    else if (ch === '#' && this.atWordStart()) this.skipComment();
    else if (ch === '$' && this.source[this.pos + 1] === "'") this.openQuote("$'");
    else if (ch === "'" || ch === '"') this.openQuote(ch);
    else if (this.scanHeredocMarker()) return;
    else if (this.scanOperator()) return;
    else this.scanPlain(ch);
  }

  /** @param {string} ch */
  scanPlain(ch) {
    this.raw += ch;
    this.pos += 1;
    if (ch === ' ' || ch === '\t') this.endWord();
    else this.word += ch;
  }

  /** @param {string} opener `'`, `"` or `$'` (ANSI-C quoting) */
  openQuote(opener) {
    this.ansiQuote = opener === "$'";
    this.quote = this.ansiQuote ? "'" : opener;
    this.raw += opener;
    this.pos += opener.length;
  }

  atWordStart() {
    return this.word === '' && (this.raw === '' || /[ \t]$/.test(this.raw));
  }

  /** A comment runs to the end of the line; the newline itself still ends the segment. */
  skipComment() {
    const end = this.source.indexOf('\n', this.pos);
    this.pos = end < 0 ? this.source.length : end;
  }

  /** Outside quotes a backslash makes the next character literal; before a newline it vanishes. */
  scanEscape() {
    const next = this.source[this.pos + 1];
    this.pos += 2;
    if (next === undefined || next === '\n') return;
    this.append(`\\${next}`, next);
  }

  /**
   * `&&`, `||`, `;`, `|`, `&`, newline, parentheses and backticks end a segment. `>&` and `&>`
   * are redirections, not separators.
   */
  scanOperator() {
    const pair = this.source.slice(this.pos, this.pos + 2);
    if (pair === '&&' || pair === '||') {
      this.endSegment(pair);
      this.pos += 2;
      return true;
    }
    const ch = this.source[this.pos];
    if (!';|&\n()`'.includes(ch)) return false;
    if (ch === '&' && (/[<>]$/.test(this.raw) || this.source[this.pos + 1] === '>')) return false;
    if (ch === '(') this.openParen();
    if (ch === ')' && this.closeParen()) return true;
    this.endSegment(ch, ch === ')' && this.closedExpansion);
    this.pos += 1;
    if (ch === '\n') this.skipHeredocBodies();
    return true;
  }

  openParen() {
    if (this.arithParens > 0) this.arithParens += 1;
    else if (this.source.startsWith('((', this.pos)) {
      // `$((` anywhere, or `((` where a command would start, opens an arithmetic expression.
      if (this.word.endsWith('$') || this.raw === '') {
        this.arithParens = 1;
        this.arithExpansion = this.word.endsWith('$');
      }
    }
    this.parenDepth += 1;
    // `$(`, `<(`, `>(` and the parentheses of `$((...))` open an expansion; any other `(` opens a
    // subshell or group. The scanner is looking at the raw text before the `(`, so adjacency holds.
    // A bare `((` stays a group: bash reads it as nested subshells when its close isn't `))`.
    const inArithExpansion = this.arithParens > 0 && this.arithExpansion;
    this.openParens.push(inArithExpansion || /(^|[^\\])[$<>]$/.test(this.raw));
  }

  /** @returns {boolean} true when this `)` closes the substitution being read */
  closeParen() {
    if (this.arithParens > 0) this.arithParens -= 1;
    if (this.parenDepth === 0 && this.stopAtParen) {
      this.closedAt = this.pos;
      return true;
    }
    this.parenDepth = Math.max(0, this.parenDepth - 1);
    // A `)` with nothing open (a `case` pattern's) is not known to close an expansion.
    this.closedExpansion = this.openParens.pop() === true;
    return false;
  }

  /**
   * Records `<<WORD` so its body can be read at the next newline. A here-string (`<<<`), a marker
   * that can't be read with certainty, and a shift inside `$((...))` are not heredocs.
   */
  scanHeredocMarker() {
    if (!this.source.startsWith('<<', this.pos) || this.source[this.pos + 2] === '<') return false;
    if (this.source[this.pos - 1] === '<') return false;
    const marker = readHeredocMarker(this.source.slice(this.pos));
    if (marker === null || this.arithParens > 0) return false;
    this.endWord();
    // The marker stays in the raw text so the segment exists for its body to attach to.
    this.raw += this.source.slice(this.pos, this.pos + marker.length);
    this.pendingHeredocs.push({ ...marker, segmentIndex: this.out.length });
    this.pos += marker.length;
    return true;
  }

  /**
   * Reads each pending heredoc body and hands it to the segment that owns it. If a delimiter line
   * never appears, nothing is skipped and the text is judged as commands.
   */
  skipHeredocBodies() {
    for (const { delimiter, stripTabs, quoted, segmentIndex } of this.pendingHeredocs) {
      const body = this.readHeredocBody(delimiter, stripTabs);
      if (body === null) break;
      const owner = this.out[segmentIndex];
      owner?.heredocs.push(body);
      // An unquoted delimiter leaves $(...) and backticks in the body live.
      if (!quoted) owner?.substitutions.push(...expansionsIn(body));
    }
    this.pendingHeredocs = [];
  }

  /**
   * @param {string} delimiter
   * @param {boolean} stripTabs
   * @returns {string | null} the body, with the position moved past the delimiter line
   */
  readHeredocBody(delimiter, stripTabs) {
    /** @type {string[]} */
    const lines = [];
    let cursor = this.pos;
    while (cursor < this.source.length) {
      const end = this.source.indexOf('\n', cursor);
      const line = this.source.slice(cursor, end < 0 ? this.source.length : end);
      cursor = end < 0 ? this.source.length : end + 1;
      if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) {
        this.pos = cursor;
        return lines.join('\n');
      }
      lines.push(line);
    }
    return null;
  }

  scanQuoted() {
    const ch = this.source[this.pos];
    if (ch === this.quote) {
      this.quote = null;
      this.ansiQuote = false;
      this.raw += ch;
      this.pos += 1;
    } else if (this.ansiQuote) this.scanAnsiQuoted(ch);
    else if (this.quote === '"') this.scanDoubleQuoted(ch);
    else this.scanPlainQuoted(ch);
  }

  /** @param {string} ch */
  scanPlainQuoted(ch) {
    this.append(ch);
    this.pos += 1;
  }

  /**
   * Inside `$'...'` a backslash escapes any character, including the closing quote.
   * @param {string} ch
   */
  scanAnsiQuoted(ch) {
    const next = this.source[this.pos + 1];
    if (ch === '\\' && next !== undefined) {
      this.append(`\\${next}`, next);
      this.pos += 2;
    } else this.scanPlainQuoted(ch);
  }

  /**
   * Inside double quotes a backslash escapes only `$`, a backtick, `"`, `\` and a newline, and
   * `$(...)` and backticks still run commands.
   * @param {string} ch
   */
  scanDoubleQuoted(ch) {
    const next = this.source[this.pos + 1];
    if (ch === '\\' && next !== undefined && '$`"\\\n'.includes(next)) {
      this.append(`\\${next}`, next === '\n' ? '' : next);
      this.pos += 2;
    } else if (ch === '`' || (ch === '$' && next === '(')) this.scanSubstitution();
    else this.scanPlainQuoted(ch);
  }

  /** Keeps the substitution's text in the word and records its command to be judged. */
  scanSubstitution() {
    const { inner, end } = substitutionSpan(this.source, this.pos);
    this.append(this.source.slice(this.pos, end));
    this.substitutions.push(inner);
    this.pos = end;
  }
}

/**
 * Splits a shell command into segments at unquoted `&&`, `||`, `;`, `|`, `&`, newlines,
 * parentheses and backticks, and each segment into words with quotes removed.
 * @param {string} command
 * @returns {Segment[]}
 */
function segments(command) {
  return new Scanner(command).scan();
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELLS = ['bash', 'sh', 'zsh'];
// Programs that read their stdin or arguments as a script to run.
const SCRIPT_RUNNERS = [...SHELLS, 'eval', 'source', '.'];

<<<<<<< d75987291b5435bf13f08517e2216bd2713f10c2
/**
 * `loneDash`: a `-` on its own is an option (env reads it as `-i`), not the command.
 * @typedef {{ valueOptions: string[], operands: number, loneDash?: boolean }} Wrapper
 */
||||||| 20f56e6
/** @typedef {{ valueOptions: string[], operands: number }} Wrapper */
=======
/**
 * @typedef {object} Wrapper
 * @property {string[]} valueOptions options that take a value, attached or as the next word
 * @property {string[]} flags options that take no value
 * @property {string[]} [attachedOptions] options whose value, if any, is only ever attached
 * @property {number} operands positional words before the command
 */
// The option tables decide only what the guard lets through without asking: an option before the
// command that appears in none of a wrapper's lists could take a value, so the guard can't tell
// which word is the command and asks (`unknownWrapperOption`). Add an option here only after
// checking whether it takes a value; a missing one costs a question, a wrong one hides a command.
>>>>>>> 62bd96747d827f6f3717400e8126afcc8ce974f8
/** @type {Wrapper} */
const PLAIN_WRAPPER = { valueOptions: [], flags: [], operands: 0 };
/** @type {string[]} */
const INFO_OPTIONS = ['--help', '--version'];
const DIGITS = [...'0123456789'].map((d) => `-${d}`);
// Words that run another command without changing what it is: shell keywords and wrappers. Each
// lists the options that take a separate value and how many positional words precede the command.
/** @type {Map<string, Wrapper>} */
const WRAPPERS = new Map([
  ...['!', '{', '}', 'if', 'elif', 'while', 'until', 'then', 'do', 'else'].map(
    (keyword) => /** @type {[string, Wrapper]} */ ([keyword, PLAIN_WRAPPER]),
  ),
<<<<<<< d75987291b5435bf13f08517e2216bd2713f10c2
  ...['time', 'command', 'nohup', 'setsid'].map(
    (name) => /** @type {[string, Wrapper]} */ ([name, PLAIN_WRAPPER]),
  ),
  ['exec', { valueOptions: ['-a'], operands: 0 }],
  ['nice', { valueOptions: ['-n', '--adjustment'], operands: 0 }],
  // -P altpath is BSD/macOS env's.
  [
    'env',
    {
      valueOptions: ['-u', '-C', '-a', '-P', '--unset', '--chdir', '--argv0'],
      operands: 0,
      loneDash: true,
    },
  ],
||||||| 20f56e6
  ...['time', 'command', 'nohup', 'setsid'].map(
    (name) => /** @type {[string, Wrapper]} */ ([name, PLAIN_WRAPPER]),
  ),
  ['exec', { valueOptions: ['-a'], operands: 0 }],
  ['nice', { valueOptions: ['-n', '--adjustment'], operands: 0 }],
  // -P altpath is BSD/macOS env's.
  ['env', { valueOptions: ['-u', '-C', '-a', '-P', '--unset', '--chdir', '--argv0'], operands: 0 }],
=======
  ['time', { ...PLAIN_WRAPPER, flags: ['-p'] }],
  ['command', { ...PLAIN_WRAPPER, flags: ['-p', '-v', '-V'] }],
  ['nohup', { ...PLAIN_WRAPPER, flags: INFO_OPTIONS }],
  ['setsid', { ...PLAIN_WRAPPER, flags: ['-c', '-f', '-w', '--ctty', '--fork', '--wait'] }],
  ['exec', { valueOptions: ['-a'], flags: ['-c', '-l'], operands: 0 }],
  [
    'nice',
    { valueOptions: ['-n', '--adjustment'], flags: [...DIGITS, ...INFO_OPTIONS], operands: 0 },
  ],
  [
    'env',
    {
      valueOptions: [
        ...['-u', '-C', '-S', '-a', '-P'],
        ...['--unset', '--chdir', '--split-string', '--argv0'],
      ],
      flags: [
        ...['-i', '-0', '-v'],
        ...['--ignore-environment', '--null', '--debug', ...INFO_OPTIONS],
        // These take a value only with =.
        ...['--block-signal', '--default-signal', '--ignore-signal', '--list-signal-handling'],
      ],
      operands: 0,
    },
  ],
>>>>>>> 62bd96747d827f6f3717400e8126afcc8ce974f8
  [
    'stdbuf',
    {
      valueOptions: [...['-i', '-o', '-e'], ...['--input', '--output', '--error']],
      flags: INFO_OPTIONS,
      operands: 0,
    },
  ],
  [
    'timeout',
    {
      valueOptions: [...['-s', '-k'], ...['--signal', '--kill-after']],
      flags: [
        ...['-f', '-p', '-v'],
        ...['--foreground', '--preserve-status', '--verbose', ...INFO_OPTIONS],
      ],
      operands: 1,
    },
  ],
  [
    'sudo',
    {
      valueOptions: [
        ...['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t', '-c'],
        ...['--chdir', '--chroot', '--user', '--group', '--host', '--prompt', '--role', '--type'],
        ...['--other-user', '--close-from', '--command-timeout', '--login-class'],
      ],
      flags: [
        ...['-A', '-b', '-B', '-E', '-e', '-H', '-i', '-K', '-k', '-l', '-n', '-P', '-S', '-s'],
        ...['-V', '-v', '--askpass', '--background', '--bell', '--edit', '--set-home', '--login'],
        ...['--remove-timestamp', '--reset-timestamp', '--list', '--non-interactive', '--stdin'],
        ...['--preserve-groups', '--shell', '--validate', '--preserve-env', ...INFO_OPTIONS],
      ],
      operands: 0,
    },
  ],
  [
    'xargs',
    {
      valueOptions: [
        ...['-n', '-I', '-L', '-P', '-d', '-s', '-E', '-a', '-J', '-R', '-S'],
        ...['--max-args', '--max-procs', '--delimiter', '--max-chars', '--arg-file'],
        '--process-slot-var',
      ],
      flags: [
        ...['-0', '-o', '-p', '-r', '-t', '-x', '-z'],
        ...['--null', '--open-tty', '--interactive', '--no-run-if-empty', '--verbose'],
        ...['--exit', '--show-limits', ...INFO_OPTIONS],
        // --replace, --eof and --max-lines take an optional value, given only with =, so
        // the word after them is the command.
        ...['--replace', '--eof', '--max-lines'],
      ],
      // -e, -i and -l take an optional value, given only attached (`-i{}`).
      attachedOptions: ['-e', '-i', '-l'],
      operands: 0,
    },
  ],
]);

const ENV_WRAPPER = /** @type {Wrapper} */ (WRAPPERS.get('env'));

/**
 * How a wrapper reads an option word that starts with `-` (not `-` or `--`): whether the table
 * knows every part of it, and whether its value is the next word. getopt takes a short option's
 * value attached (`-CDIR`) or in the next word, so in a group of short options (`-iC DIR`) the value
 * comes next only when the option that takes one is last, and what follows a value option is its
 * value. A long option takes its value in the next word unless it carries `=`, and getopt_long
 * accepts any unambiguous prefix of a name, so a prefix of a listed long option counts (`--ch DIR`).
 * An exact name wins over a prefix, as in getopt_long: sudo's `--login` is a flag even though it
 * is also a prefix of the value option `--login-class`.
 * @param {string} word
 * @param {Wrapper} wrapper
 * @returns {{ known: boolean, takesNext: boolean }}
 */
function readOption(word, wrapper) {
  if (word.startsWith('--')) {
    const name = word.split('=')[0];
    if (wrapper.valueOptions.includes(name)) return { known: true, takesNext: !word.includes('=') };
    if (wrapper.flags.includes(name)) return { known: true, takesNext: false };
    const prefixes = (/** @type {string[]} */ list) =>
      list.some((option) => option.startsWith('--') && option.startsWith(name));
    return {
      known: prefixes([...wrapper.valueOptions, ...wrapper.flags]),
      takesNext: !word.includes('=') && prefixes(wrapper.valueOptions),
    };
  }
  for (let k = 1; k < word.length; k += 1) {
    const short = `-${word[k]}`;
    if (wrapper.valueOptions.includes(short)) {
      return { known: true, takesNext: k === word.length - 1 };
    }
    if (wrapper.attachedOptions?.includes(short)) return { known: true, takesNext: false };
    if (!wrapper.flags.includes(short)) return { known: false, takesNext: false };
  }
  return { known: true, takesNext: false };
}

/**
 * Where the word after a wrapper's options and positional operands is, and whether one of those
 * options is missing from the wrapper's table.
 * @param {string[]} words
 * @param {number} from index just past the wrapper word
 * @param {Wrapper} wrapper
 */
function skipWrapperArguments(words, from, wrapper) {
  let i = from;
<<<<<<< d75987291b5435bf13f08517e2216bd2713f10c2
  while (
    i < words.length &&
    words[i].startsWith('-') &&
    (words[i] !== '-' || wrapper.loneDash === true)
  ) {
    if (words[i] === '-') {
      i += 1;
      continue;
    }
||||||| 20f56e6
  while (i < words.length && words[i].startsWith('-') && words[i] !== '-') {
=======
  let unknown = false;
  while (i < words.length && words[i].startsWith('-') && words[i] !== '-') {
>>>>>>> 62bd96747d827f6f3717400e8126afcc8ce974f8
    if (words[i] === '--') {
      i += 1;
      break;
    }
    const option = readOption(words[i], wrapper);
    if (!option.known) unknown = true;
    i += option.takesNext ? 2 : 1;
  }
  return { index: Math.min(i + wrapper.operands, words.length), unknown };
}

/**
 * Index of the first word after leading `VAR=value` words, wrappers and their options, and whether
 * a wrapper on the way has an option its table doesn't know.
 * @param {string[]} words
 */
function walkWrappers(words) {
  let i = 0;
  let unknown = false;
  while (i < words.length) {
    const wrapper = WRAPPERS.get(posix.basename(words[i]));
    if (ENV_ASSIGNMENT.test(words[i])) i += 1;
    else if (wrapper) {
      const skipped = skipWrapperArguments(words, i + 1, wrapper);
      i = skipped.index;
      unknown ||= skipped.unknown;
    } else break;
  }
  return { start: i, unknown };
}

/**
 * Index of the first word after leading `VAR=value` words, wrappers and their options.
 * @param {string[]} words
 */
function commandStart(words) {
  return walkWrappers(words).start;
}

/**
 * True when a wrapper before the command has an option the table doesn't know. It might take a
 * value, so which word is the command is a guess.
 * @param {string[]} words
 */
function unknownWrapperOption(words) {
  return walkWrappers(words).unknown;
}

/**
 * The program's name without its directory, so `/usr/bin/git` is `git`.
 * @param {string[]} words
 * @param {number} i
 */
function programAt(words, i) {
  return posix.basename(words[i] ?? '');
}

// git options placed before the verb that take their value as the next word.
const GIT_OPTIONS_WITH_VALUE = [
  '-C',
  '-c',
  '--config-env',
  '--git-dir',
  '--work-tree',
  '--namespace',
];

/**
 * The git verb and its arguments, skipping leading `VAR=value` words, wrappers, and git's global
 * options. `config` collects every `-c key=value` and `--config-env key=VAR` passed to git itself,
 * and `dirs` every `-C <dir>`, in order. `retargeted` is true when something else points git at
 * another repository: `--git-dir`, `--work-tree`, a `GIT_DIR`-style assignment, or a wrapper's own
 * directory option (`env -C`, `sudo -D`, `--chdir`), which the guard doesn't follow.
 * @param {string[]} words
 */
function gitSubcommand(words) {
  let i = commandStart(words);
  if (programAt(words, i) !== 'git') return null;
  let retargeted = words.slice(0, i).some(
    (w) =>
      // getopt takes a short option's value attached (`-CDIR`) or in the next word, and a
      // cluster can carry it (`-iCDIR`), so any C, D or R in a short option word counts.
      // A long option may be shortened to any prefix (`--ch`, `--chd=DIR`).
      /^--(c|ch|chd|chdi|chdir|chr|chro|chroo|chroot)(=|$)/.test(w) ||
      /^-[A-Za-z]*[CDR]/.test(w) ||
      /^GIT_(DIR|WORK_TREE|COMMON_DIR)=/.test(w),
  );
  i += 1;
  /** @type {string[]} */
  const config = [];
  /** @type {string[]} */
  const dirs = [];
  while (i < words.length && words[i].startsWith('-')) {
    const word = words[i];
    if (word === '-c' || word === '--config-env') config.push(words[i + 1] ?? '');
    if (word.startsWith('--config-env=')) config.push(word.slice('--config-env='.length));
    if (word === '-C') dirs.push(words[i + 1] ?? '');
    if (/^--(git-dir|work-tree)(=|$)/.test(word)) retargeted = true;
    i += GIT_OPTIONS_WITH_VALUE.includes(word) ? 2 : 1;
  }
  return { verb: words[i] ?? '', args: words.slice(i + 1), config, dirs, retargeted };
}

// Programs and keywords that can change the shell's directory, or run text that can.
const DIRECTORY_CHANGERS = ['cd', 'pushd', 'popd', 'chdir', 'builtin', 'eval', 'source', '.'];

/**
 * True when a segment may change the directory the following segments run in: it names a
 * directory-changing builtin or a script runner as its command, has `cd`, `pushd`, `popd`, `chdir`
 * or `builtin` anywhere as a word (`command cd`, `time cd`), or its command word is built by the
 * shell (`$X dir`).
 * @param {string[]} words
 */
function mayChangeDirectory(words) {
  const start = commandStart(words);
  const command = words[start] ?? '';
  return (
    DIRECTORY_CHANGERS.includes(programAt(words, start)) ||
    DIRECTORY_CHANGERS.includes(command) ||
    /[$`]/.test(command) ||
    words.some((w) => ['cd', 'pushd', 'popd', 'chdir', 'builtin'].includes(w))
  );
}

/**
 * The directory `target` names from `base`, or null when the guard can't tell: no known base for
 * a relative path, a path the shell expands (`$`, backtick, `~`, glob, braces), an empty path, or
 * one that is not an existing directory.
 * @param {string | null} base
 * @param {string} target
 * @returns {string | null}
 */
function resolveDirectory(base, target) {
  if (target === '' || target === '-' || /[$`~*?[\]{}\\]/.test(target)) return null;
  if (!posix.isAbsolute(target) && base === null) return null;
  const dir = posix.resolve(base ?? '/', target);
  return attempt(() => statSync(dir).isDirectory()) === true ? dir : null;
}

/**
 * The directory a plain `cd` segment leaves the shell in, or null when it can't be read: a cd with
 * no operand, more than one, or a path `resolveDirectory` can't resolve. `-L` and `--` are the
 * only options read.
 * @param {string[]} words the segment's words, the first being `cd`
 * @param {string | null} base the directory it runs in
 * @returns {string | null}
 */
function cdDestination(words, base) {
  let i = 1;
  if (words[i] === '-L') i += 1;
  if (words[i] === '--') i += 1;
  if (words.length !== i + 1) return null;
  return resolveDirectory(base, words[i]);
}

/**
 * The string `env -S` / `env --split-string` runs as a command line, if the segment has one.
 * @param {string[]} words
 * @returns {string | null}
 */
function envSplitString(words) {
  const envAt = words.findIndex((w) => posix.basename(w) === 'env');
  if (envAt < 0) return null;
  for (let j = envAt + 1; j < words.length; j += 1) {
    const word = words[j];
    // getopt_long takes any unambiguous prefix of a long option; `--s` is already unique to
    // --split-string among env's options.
    const long = /^--(s[a-z-]*)(=|$)/.exec(word);
    if (long && '--split-string'.startsWith(`--${long[1]}`)) {
      return long[2] === '=' ? word.slice(long[0].length) : (words[j + 1] ?? null);
    }
    if (/^-[A-Za-z]*S$/.test(word)) return words[j + 1] ?? null;
    if (/^-[A-Za-z]*S./.test(word)) return word.slice(word.indexOf('S') + 1);
    if (word.startsWith('-') && word !== '-' && readOption(word, ENV_WRAPPER).takesNext) j += 1;
    else if (!word.startsWith('-') && !ENV_ASSIGNMENT.test(word)) break;
  }
  return null;
}

// The options GNU and BSD/macOS env know. `-S` and `--split-string` hand the rest to a nested env.
const ENV_FLAG_LETTERS = 'i0v';
const ENV_VALUE_LETTERS = 'uCaP';
const ENV_FLAG_LONG = [
  ...['--ignore-environment', '--null', '--debug', '--version', '--help'],
  ...['--block-signal', '--default-signal', '--ignore-signal', '--list-signal-handling'],
];
const ENV_VALUE_LONG = ['--unset', '--chdir', '--argv0'];
const ENV_VALUE_OPTIONS = [...[...ENV_VALUE_LETTERS].map((l) => `-${l}`), ...ENV_VALUE_LONG];

/**
 * True when the leading env options in `words` (the words after `env`) include one this guard
 * doesn't know, so it can't tell whether the word after it is a value or the command.
 * @param {string[]} words
 */
function hasUnknownEnvOption(words) {
  let i = 0;
  while (i < words.length && words[i].startsWith('-') && words[i] !== '-') {
    const word = words[i];
    if (word === '--') return false;
    if (word.startsWith('--')) {
      const name = word.split('=')[0];
      if (name.length > 2 && '--split-string'.startsWith(name)) return false;
      const known = [...ENV_FLAG_LONG, ...ENV_VALUE_LONG];
      if (name.length <= 2 || !known.some((long) => long.startsWith(name))) return true;
    } else {
      for (let k = 1; k < word.length; k += 1) {
        const letter = word[k];
        if (letter === 'S') return false;
        if (ENV_VALUE_LETTERS.includes(letter)) break;
        if (!ENV_FLAG_LETTERS.includes(letter)) return true;
      }
    }
    i += takesNextWord(word, ENV_VALUE_OPTIONS) ? 2 : 1;
  }
  return false;
}

/**
 * The command a `bash -c`, `sh -c`, `zsh -c`, `eval` or `env -S` segment runs, so it can be
 * judged too. A flag cluster such as `-ce` or `-lc` counts as `-c`. env puts the words an -S
 * string splits into back in its arguments and keeps parsing options from them, so that string is
 * judged as `env <string>`.
 * @param {string[]} words
 * @returns {string | null}
 */
function nestedCommand(words) {
  const split = envSplitString(words);
  if (split !== null) return `env ${split}`;
  const i = commandStart(words);
  if (words[i] === 'eval') return words.slice(i + 1).join(' ');
  if (!SHELLS.includes(programAt(words, i))) return null;
  const flag = words.findIndex((w, j) => j > i && /^-[a-z]*c[a-z]*$/.test(w));
  return flag >= 0 ? (words[flag + 1] ?? null) : null;
}

/**
 * The scripts fed to a shell on stdin by a heredoc or here-string, which it runs as commands.
 * @param {Segment} seg
 * @param {number} start index of the program word
 * @returns {string[]}
 */
function stdinScripts(seg, start) {
  if (!SCRIPT_RUNNERS.includes(programAt(seg.words, start))) return [];
  const hereStrings = seg.words.flatMap((word, j) =>
    word.startsWith('<<<') ? [word.length > 3 ? word.slice(3) : (seg.words[j + 1] ?? '')] : [],
  );
  return [...seg.heredocs, ...hereStrings];
}

/**
 * Runs a git lookup and returns null when it can't answer (no repository, no git), so a rule that
 * needs git state is skipped while every other rule still applies.
 * @template T
 * @param {() => T} lookup
 * @returns {T | null}
 */
function attempt(lookup) {
  try {
    return lookup();
  } catch {
    return null;
  }
}

/** @param {string} cwd @param {string[]} args */
function gitOutput(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

// Options a branch deletion may carry and still count as one plain delete: the delete flags, force
// and quiet. `-r` (remote-tracking branches) and everything else is not one.
const BRANCH_DELETE_OPTIONS = [
  '-D',
  '-d',
  '-f',
  '-df',
  '-fd',
  '-q',
  '--quiet',
  '--delete',
  '--force',
];
// A branch name made of characters git allows and no revision syntax: no `~`, `^`, `@{`, `:`, `..`
// or glob. A name that doesn't fit is asked about, never resolved.
const PLAIN_BRANCH_NAME = /^[A-Za-z0-9_][A-Za-z0-9_./+-]*$/;
// One `gh pr list` may wait this long, and all the lookups for one command together wait at most
// GH_BUDGET_MS. Claude Code cancels a hook that outlasts its timeout (60 s by default) and then
// runs the command unjudged, so the total stays well below that. TENDB_GIT_GUARD_GH_BUDGET_MS
// overrides the total, for tests.
const GH_LOOKUP_TIMEOUT_MS = 15000;
const GH_BUDGET_MS = 20000;

function ghBudgetMs() {
  const override = Number(process.env.TENDB_GIT_GUARD_GH_BUDGET_MS);
  return Number.isFinite(override) && override > 0 ? override : GH_BUDGET_MS;
}

/**
 * True when `git branch <delete flags> <names>` deletes only local branches whose pull request has
 * merged and whose tip is that pull request's head commit, so the deletion loses no commit. The
 * repository squash-merges, so a merged branch is never an ancestor of main and only `-D` deletes
 * it. False whenever a branch can't be confirmed: not a plain local branch name, the checked-out
 * branch, no merged pull request with exactly that head, or gh missing, offline or unparseable.
 * @param {string[]} args the arguments after `branch`
 * @param {string} cwd
 */
function deletesOnlyMergedBranches(args, cwd) {
  const names = args.filter((x) => !x.startsWith('-'));
  const options = args.filter((x) => x.startsWith('-'));
  if (names.length === 0 || options.length === 0) return false;
  if (!options.every((x) => BRANCH_DELETE_OPTIONS.includes(x))) return false;
  if (!options.some((x) => x === '--delete' || /^-[a-zA-Z]*[dD]/.test(x))) return false;
  const checkedOut = currentBranch(cwd);
  const deadline = Date.now() + ghBudgetMs();
  return names.every((name) => {
    if (!PLAIN_BRANCH_NAME.test(name) || name.includes('..') || name === checkedOut) return false;
    const tip = attempt(() =>
      gitOutput(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}^{commit}`]).trim(),
    );
    if (!tip) return false;
    // The branches share one budget; a lookup that starts with none left is an unconfirmed branch.
    const left = deadline - Date.now();
    if (left <= 0) return false;
    const pulls = attempt(() =>
      JSON.parse(
        execFileSync(
          'gh',
          [
            'pr',
            'list',
            '--head',
            name,
            '--state',
            'merged',
            '--limit',
            '100',
            '--json',
            'headRefName,headRefOid,state',
          ],
          {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: Math.min(GH_LOOKUP_TIMEOUT_MS, left),
          },
        ),
      ),
    );
    return (
      Array.isArray(pulls) &&
      pulls.some(
        (pull) => pull?.state === 'MERGED' && pull.headRefName === name && pull.headRefOid === tip,
      )
    );
  });
}

/** Paths staged right now, relative to the repository root. @param {string} cwd */
function stagedPaths(cwd) {
  return gitOutput(cwd, ['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean);
}

/** The checked-out branch, or '' when HEAD is detached or unreadable. @param {string} cwd */
function currentBranch(cwd) {
  return attempt(() => gitOutput(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).trim()) ?? '';
}

/**
 * True when `cwd` is inside a linked worktree that sits directly in `10db-worktrees/` beside its
 * main checkout, where AGENTS.md puts the worktrees agents make by hand. A directory there whose
 * `.git` file points at the main repository or at another worktree's git directory is not one: the
 * worktree's own git directory must differ from the common one and name this `.git` file back in
 * its `gitdir`. False when git can't say.
 * @param {string} cwd
 */
function inAgentWorktree(cwd) {
  const lines = attempt(() =>
    gitOutput(cwd, [
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--git-dir',
      '--git-common-dir',
    ]).split('\n'),
  );
  const [top, gitDir, common] = lines ?? [];
  if (!top || !gitDir || !common || gitDir === common) return false;
  if (posix.basename(common) !== '.git') return false;
  const linked = attempt(
    () =>
      realpathSync(readFileSync(join(gitDir, 'gitdir'), 'utf8').trim()) ===
      realpathSync(join(top, '.git')),
  );
  if (linked !== true) return false;
  const checkout = posix.dirname(common);
  return posix.dirname(top) === posix.join(posix.dirname(checkout), '10db-worktrees');
}

// Words that make a command act on a directory other than the cwd the guard judged: a change of
// directory, git's own retargeting options and its repository variables. Matched anywhere in the
// command, nested scripts and quoted text included, so a match only ever costs a prompt.
const RETARGETS =
  /(^|[\s;&|(){}`'"=])(cd|pushd|popd|chdir|-C|--chdir(=\S*)?|--git-dir(=\S*)?|--work-tree(=\S*)?)(?=$|[\s;&|(){}`'"])|\bGIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY)\b/;

// Variables that point git at a repository; after a cd they make the directory unknowable.
const GIT_REPOSITORY_VARIABLE = /\bGIT_(DIR|WORK_TREE|COMMON_DIR)\b/;

/**
 * True when every pathspec names one file: no option, glob, pathspec magic, expansion syntax
 * (`$`, backtick, `~`, braces), `.`, directory or parent path, and the index holds exactly one
 * entry under it, the path itself. A tracked file deleted from disk still has its entry; a path
 * that names a tracked directory, or nothing tracked, does not pass. An empty list is false, since
 * git then takes the whole tree or refuses.
 * @param {string[]} paths
 * @param {string} cwd
 */
function namesSingleFiles(paths, cwd) {
  return (
    paths.length > 0 &&
    paths.every((p) => {
      const normal = posix.normalize(p);
      return (
        !p.startsWith('-') &&
        !p.startsWith(':') &&
        !/[*?[\]\\$`{}~]/.test(p) &&
        normal !== '.' &&
        normal !== '..' &&
        !normal.startsWith('../') &&
        !posix.isAbsolute(normal) &&
        attempt(() => existsSync(join(cwd, p)) && statSync(join(cwd, p)).isDirectory()) !== true &&
        trackedAsOneFile(normal, cwd)
      );
    })
  );
}

/**
 * True when the index has exactly one entry under `path` and it is `path` itself. `ls-files`
 * prints paths relative to `cwd`, as `path` is. False when git can't say.
 * @param {string} path a normalized, cwd-relative path
 * @param {string} cwd
 */
function trackedAsOneFile(path, cwd) {
  const entries = attempt(() =>
    gitOutput(cwd, ['--literal-pathspecs', 'ls-files', '-z', '--', path])
      .split('\0')
      .filter(Boolean),
  );
  return entries !== null && entries.length === 1 && entries[0] === path;
}

/**
 * True for the discards an agent may run without asking in its own worktree: `checkout [-q]
 * [<commit>] -- <file>...` and `restore` of named files with only the options that pick which copy.
 * `stash` is never one: `refs/stash` is shared by every worktree of the repository.
 * @param {string} verb
 * @param {string[]} a
 * @param {string} cwd
 */
function isFileDiscard(verb, a, cwd) {
  const dashDash = a.indexOf('--');
  if (verb === 'checkout') {
    if (dashDash < 0) return false;
    const before = a.slice(0, dashDash).filter((x) => x !== '-q' && x !== '--quiet');
    const commit = before.length === 0 || (before.length === 1 && !before[0].startsWith('-'));
    return commit && namesSingleFiles(a.slice(dashDash + 1), cwd);
  }
  if (verb === 'restore') {
    const options = dashDash < 0 ? a : a.slice(0, dashDash);
    /** @type {string[]} */
    const paths = dashDash < 0 ? [] : a.slice(dashDash + 1);
    for (let j = 0; j < options.length; j += 1) {
      const x = options[j];
      if (x === '-s' || x === '--source') j += 1;
      else if (/^-[SWq]+$/.test(x) || /^--(source=.+|staged|worktree|quiet)$/.test(x)) continue;
      else if (x.startsWith('-')) return false;
      else paths.push(x);
    }
    return namesSingleFiles(paths, cwd);
  }
  return false;
}

/**
 * Turns a cwd-relative pathspec into a repository-relative one.
 * @param {string} prefix
 * @param {string} path
 */
function repoRelative(prefix, path) {
  return posix.normalize(posix.join(prefix, path)).replace(/\/$/, '');
}

/**
 * True when `x` abbreviates the long option, as git allows.
 * @param {string} x
 * @param {string} option
 * @param {number} [min]
 */
function isLongOption(x, option, min = 4) {
  return x.length >= min && x.startsWith('--') && option.startsWith(x);
}

/** @param {string[]} args @param {string} option @param {number} [min] */
function hasLongOption(args, option, min = 4) {
  return args.some((x) => isLongOption(x, option, min));
}

/**
 * True when a short-flag cluster such as `-uf` contains one of `letters`.
 * @param {string[]} args
 * @param {string} letters
 */
function hasShortFlag(args, letters) {
  return args.some(
    (x) => /^-[A-Za-z]+$/.test(x) && [...x.slice(1)].some((c) => letters.includes(c)),
  );
}

const TEST_RUNNER = /\b(vitest|pnpm (-s )?(test|gate)|make (gate|check)|cargo test|playwright)\b/;
const BULK_ADD = ['-A', '--all', '.', '-u', '--update', ':/', ':/.', '*'];
// Environment assignments that skip or reroute the git hooks: lefthook's own switches
// (LEFTHOOK=0, LEFTHOOK_EXCLUDE, LEFTHOOK_CONFIG, LEFTHOOK_BIN) and git's config-by-environment
// variables, which can set core.hooksPath. Any value counts, quoted or not. LEFTHOOK=1 and
// GIT_CONFIG_NOSYSTEM are harmless.
const HOOK_SKIP = /^(LEFTHOOK(_EXCLUDE|_CONFIG|_BIN)?|GIT_CONFIG(_[A-Z0-9_]+)?)=/;
const HOOK_SKIP_HARMLESS = /^(LEFTHOOK=(1|true)|GIT_CONFIG_NOSYSTEM=.*)$/s;
// Git accepts any unambiguous prefix of a long option, so --no-verif skips hooks too.
const isNoVerify = (/** @type {string} */ x) => x.length >= 6 && '--no-verify'.startsWith(x);
const HOOKS_DIR = /(^|\/)\.git\/hooks(\/|$)/;
const READ_ONLY = ['ls', 'cat', 'head', 'tail', 'stat', 'file', 'grep', 'rg', 'find'];
const CONFIG_READ = ['--get', '--get-all', '--get-regexp', '--list', '-l', 'get', 'list'];
// gh api paths that change enforcement: rulesets, environments, secrets, Actions permissions, the
// repository itself (repos/<owner>/<repo>) and its security toggles.
const GH_SETTINGS_PATH = new RegExp(
  '(^|/)(rulesets|environments|secrets|actions/permissions|vulnerability-alerts|' +
    'private-vulnerability-reporting|automated-security-fixes)(/|$)|^/?repos/[^/]+/[^/]+/?$',
);
// The script that applies the GitHub settings, and the programs that run a script by path.
// Matched on the normalized basename, so `node github-settings.mjs` after a `cd scripts` and
// `scripts/../scripts/github-settings.mjs` count too.
const isGithubSettingsScript = (/** @type {string} */ word) =>
  posix.basename(posix.normalize(word)) === 'github-settings.mjs';
const SCRIPT_PROGRAMS = ['node', 'nodejs', 'bun', 'deno', 'tsx', 'pnpm', 'npx', 'pnpx', 'mise'];
const MAIN_REFSPEC = /^\+?((HEAD|[\w./-]+):)?(refs\/heads\/)?main$/;
const PUSH_FORCE_OPTIONS = [
  '--force',
  '--force-with-lease',
  '--force-if-includes',
  '--delete',
  '--mirror',
  '--all',
];
const SEVERITY = { warn: 1, ask: 2, deny: 3 };

/**
 * @typedef {{ decision: 'deny' | 'ask' | 'warn', reason: string }} Verdict
 * @param {string} command
 * @param {string} cwd
 * @param {string} [whole] the command as the agent ran it, when `command` is a script nested in it
 * @param {string | null} [startDir] the directory `command` starts in, null when a `cd` before it
 *   left the guard unable to tell; `cwd` when it is the hook's own directory
 * @returns {Verdict | null} the most severe verdict any segment earns
 */
function judge(command, cwd, whole = command, startDir = cwd) {
  const segs = segments(command);
  /** @type {Verdict[]} */
  const verdicts = [];
  /** @type {string[]} */
  const addedPaths = [];
  // The directory each segment runs in, as far as `cd` earlier in the command line moves it: null
  // when the guard can't tell. Rules that read the repository fall back to `cwd` then, as before;
  // a bare push into an unknown directory asks.
  let dir = startDir;
  let touchedDirectory = startDir !== cwd;
  // Whether every segment of the current `&&`/`||` list so far was a cd that is certain to have run.
  let listCertain = true;
  // A cd that follows a command in its list may not have run when the next list starts.
  let uncertainAtListEnd = false;
  // Past the first parenthesis or substitution, a cd may be in a subshell and not last.
  let grouped = false;
  // Whether a cd in this command has moved `dir`. The scanner keeps no segment for the `(` or
  // backtick that opens a group, so a cd first in a subshell reads as a plain cd; once that group
  // closes, or a list goes to the background (bash runs a whole `a && b &` list in a subshell),
  // the shell may be back where it was, so the directory becomes unknown.
  let followedCd = false;
  /** @type {string | null | undefined} undefined until looked up; null when git can't say */
  let prefix;
  const repoPrefix = () => {
    if (prefix === undefined) {
      prefix = attempt(() => gitOutput(dir ?? cwd, ['rev-parse', '--show-prefix']).trim());
    }
    return prefix;
  };
  for (const [index, seg] of segs.entries()) {
    const start = commandStart(seg.words);
    const previous = index > 0 ? segs[index - 1].separator : '';
    if (['(', ')', '`'].includes(previous)) grouped = true;
    // A substitution's `)` leaves the shell where it was; a cd inside it already made `dir` null.
    const closedExpansion = index > 0 && segs[index - 1].closesExpansion;
    if (followedCd && [')', '`', '&'].includes(previous) && !closedExpansion) dir = null;
    if (['', ';', '\n'].includes(previous)) {
      if (uncertainAtListEnd) dir = null;
      uncertainAtListEnd = false;
      listCertain = true;
    }
    if (mayChangeDirectory(seg.words)) {
      touchedDirectory = true;
      const inLine = ['', ';', '\n', '&&'];
      const plainCd = start === 0 && seg.words[0] === 'cd';
      const readable =
        plainCd && !grouped && inLine.includes(previous) && inLine.includes(seg.separator);
      const destination = readable ? cdDestination(seg.words, dir) : null;
      if (destination !== null && !listCertain) uncertainAtListEnd = true;
      dir = destination;
      if (destination === null) listCertain = false;
      else followedCd = true;
    } else listCertain = false;
    const split = envSplitString(seg.words);
    if (split !== null && hasUnknownEnvOption(segments(split)[0]?.words ?? [])) {
      verdicts.push({
        decision: 'ask',
        reason:
          'An env option inside the -S string is not one the guard knows, so it cannot tell which word is the command.',
      });
    }
    const scripts = [nestedCommand(seg.words), ...seg.substitutions, ...stdinScripts(seg, start)];
    for (const inner of scripts) {
      const verdict = inner === null ? null : judge(inner, cwd, whole, dir);
      if (verdict) verdicts.push(verdict);
    }
    if (seg.words.some((w) => HOOK_SKIP.test(w) && !HOOK_SKIP_HARMLESS.test(w))) {
      verdicts.push({
        decision: 'deny',
        reason:
          'Agents never disable or reroute the git hooks (LEFTHOOK*, GIT_CONFIG*). Fix what the hook reports.',
      });
    }
    if (unknownWrapperOption(seg.words)) {
      verdicts.push({
        decision: 'ask',
        reason:
          'A wrapper option the guard does not know comes before the command, so it cannot tell which word runs. Run the command without the wrapper, or approve it.',
      });
    }
    const program = programAt(seg.words, start);
    const rest = seg.words.slice(start + 1);
    if (
      (seg.words.some((w) => HOOKS_DIR.test(w)) && !READ_ONLY.includes(program)) ||
      (seg.words.includes('lefthook') && seg.words.includes('uninstall'))
    ) {
      verdicts.push({
        decision: 'ask',
        reason: 'This changes the installed git hooks. Fix what the hook reports instead.',
      });
    }
    const pipedIntoShell = segs[index - 1]?.separator === '|' && nestedCommand(seg.words) === null;
    if (SHELLS.includes(program) && pipedIntoShell) {
      verdicts.push({
        decision: 'ask',
        reason: 'A command piped into a shell runs unjudged. Run the command directly instead.',
      });
    }
    if (
      (program === 'make' && rest.includes('github-settings')) ||
      isGithubSettingsScript(seg.words[start] ?? '') ||
      (SCRIPT_PROGRAMS.includes(program) && rest.some(isGithubSettingsScript))
    ) {
      verdicts.push({
        decision: 'ask',
        reason: 'github-settings rewrites the live rulesets and repo settings on GitHub.',
      });
    }
    if (program === 'gh') {
      const method = rest
        .flatMap((x, j) =>
          x === '-X' || x === '--method'
            ? [rest[j + 1] ?? '']
            : /^(-X|--method=)./.test(x)
              ? [x.replace(/^(-X|--method=)/, '')]
              : [],
        )
        .map((m) => m.toUpperCase())[0];
      const sendsBody = rest.some((x) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(x));
      const writes = method === undefined ? sendsBody : method !== 'GET';
      const adminMerge = rest[0] === 'pr' && rest[1] === 'merge' && rest.includes('--admin');
      const settingsWrite =
        (rest[0] === 'api' && writes && rest.some((x) => GH_SETTINGS_PATH.test(x))) ||
        (rest[0] === 'secret' && ['set', 'delete', 'remove'].includes(rest[1] ?? ''));
      if (adminMerge || settingsWrite) {
        verdicts.push({
          decision: 'ask',
          reason: adminMerge
            ? '--admin bypasses the code-owner review. Read every .github/, hook and agent-rule change in the PR first.'
            : 'This changes rulesets, environments, secrets or repository settings on GitHub.',
        });
      }
    }
    const git = gitSubcommand(seg.words);
    if (git) {
      const a = git.args;
      if (
        a.some(isNoVerify) ||
        (git.verb === 'commit' && a.some((x) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(x)))
      ) {
        verdicts.push({
          decision: 'deny',
          reason: 'Agents never skip git hooks (--no-verify). Fix what the hook reports.',
        });
      }
      const setsHooksPath =
        git.verb === 'config' &&
        a.some((x) => /^core\.hookspath(=|$)/i.test(x)) &&
        !a.some((x) => CONFIG_READ.includes(x));
      if (setsHooksPath || git.config.some((c) => /^core\.hookspath(=|$)/i.test(c))) {
        verdicts.push({
          decision: 'deny',
          reason: 'Agents never redirect core.hooksPath. Fix what the hook reports.',
        });
      }
      if (git.verb === 'add') {
        const bulk =
          a.some((x) => BULK_ADD.includes(x)) ||
          hasShortFlag(a, 'Au') ||
          hasLongOption(a, '--all', 3) ||
          hasLongOption(a, '--update', 3) ||
          hasLongOption(a, '--no-ignore-removal', 6);
        if (bulk) {
          verdicts.push({
            decision: 'deny',
            reason: 'Name each path: git add <path> <path>. Bulk adds sweep in other work.',
          });
        }
        const paths = a.filter((x) => !x.startsWith('-'));
        addedPaths.push(...paths.map((p) => repoRelative(repoPrefix() ?? '', p)));
        const dirs = paths.filter(
          (p) =>
            !BULK_ADD.includes(p) &&
            attempt(
              () => existsSync(join(dir ?? cwd, p)) && statSync(join(dir ?? cwd, p)).isDirectory(),
            ),
        );
        if (dirs.length > 0) {
          verdicts.push({
            decision: 'warn',
            reason: `git add ${dirs.join(' ')} stages every change under that directory. Check git diff --cached before committing.`,
          });
        }
      }
      if (git.verb === 'commit') {
        if (hasShortFlag(a, 'a') || hasLongOption(a, '--all', 3)) {
          verdicts.push({
            decision: 'deny',
            reason: 'git commit -a stages everything. Use git add <path> <path>, then commit.',
          });
        }
        if (/(?:^|\s)(?:-[a-zA-Z]*m|--message)\s*=?\s*"[^"]*`/.test(seg.raw)) {
          verdicts.push({
            decision: 'deny',
            reason: 'zsh runs backticks inside double quotes. Use single quotes for -m.',
          });
        }
        const dashDash = a.indexOf('--');
        // --include commits the paths on top of the whole index, so a pathspec no longer limits it.
        const includesIndex = hasShortFlag(a, 'i') || hasLongOption(a, '--include');
        const namesPaths = dashDash >= 0 && dashDash < a.length - 1 && !includesIndex;
        if (hasLongOption(a, '--amend')) {
          verdicts.push({
            decision: 'ask',
            reason: 'Amending rewrites a commit. Make a new commit instead.',
          });
        } else if (!namesPaths) {
          // Without a pathspec, a commit takes the whole index. Allow it only when everything
          // staged was added by this same command, so another session's staged work is never swept in.
          // When git can't list the index (no repository), this one rule is skipped.
          const covered = (/** @type {string} */ p) =>
            addedPaths.some((added) => p === added || p.startsWith(`${added}/`));
          const staged = attempt(() => stagedPaths(dir ?? cwd));
          const foreign =
            staged === null
              ? []
              : addedPaths.length === 0
                ? ['(nothing added in this command)']
                : staged.filter((p) => !covered(p));
          if (foreign.length > 0) {
            verdicts.push({
              decision: 'deny',
              reason: `This commit would take the whole index, including ${foreign.slice(0, 3).join(', ')}. Name the paths: git commit -m '...' -- <path> <path>.`,
            });
          }
        }
      }
      const pushTargets = git.verb === 'push' ? a.filter((x) => !x.startsWith('-')).slice(1) : [];
      // A bare push sends the branch checked out where git runs: the directory the command line's
      // `cd` and `-C` lead to. Unknown (null) when a cd or retargeting can't be read, and then it asks.
      let pushDir = dir;
      for (const target of git.dirs) pushDir = resolveDirectory(pushDir, target);
      if (git.retargeted || (touchedDirectory && GIT_REPOSITORY_VARIABLE.test(whole))) {
        pushDir = null;
      }
      const pushesMain =
        git.verb === 'push' &&
        (pushTargets.some((t) => MAIN_REFSPEC.test(t)) ||
          (pushTargets.length === 0 && (pushDir === null || currentBranch(pushDir) === 'main')));
      // A `+` refspec forces the update and a `:` refspec deletes the remote ref.
      const rewritesRefs =
        git.verb === 'push' &&
        (hasShortFlag(a, 'fd') ||
          PUSH_FORCE_OPTIONS.some((option) => hasLongOption(a, option)) ||
          pushTargets.some((t) => t.startsWith('+') || t.startsWith(':')));
      const irreversible =
        (git.verb === 'push' && (pushesMain || rewritesRefs)) ||
        (git.verb === 'reset' &&
          ['--hard', '--keep', '--merge'].some((option) => hasLongOption(a, option))) ||
        (git.verb === 'clean' && (hasShortFlag(a, 'f') || hasLongOption(a, '--force'))) ||
        (git.verb === 'checkout' && (a.includes('--') || a.includes('.'))) ||
        (git.verb === 'restore' && !a.includes('--staged')) ||
        (git.verb === 'branch' && (hasShortFlag(a, 'D') || hasLongOption(a, '--delete'))) ||
        git.verb === 'rebase' ||
        git.verb === 'filter-branch' ||
        (git.verb === 'filter-repo' && !a.includes('--version')) ||
        (git.verb === 'stash' && !['list', 'show'].includes(a[0] ?? '')) ||
        (git.verb === 'tag' && (hasShortFlag(a, 'd') || hasLongOption(a, '--delete')));
      // The exception holds only for a command that is this one plain git call: no other segment,
      // wrapper, assignment, git option before the verb, substitution, heredoc or `$`, so nothing
      // the shell runs or expands first, and no config, can point git at another checkout.
      const loneGitCall =
        whole === command &&
        segs.filter((x) => x.words.length > 0).length === 1 &&
        seg.words[0] === 'git' &&
        seg.words[1] === git.verb &&
        git.config.length === 0 &&
        seg.substitutions.length === 0 &&
        seg.heredocs.length === 0 &&
        !/[$`]/.test(whole);
      const ownDiscard =
        loneGitCall &&
        ['checkout', 'restore'].includes(git.verb) &&
        isFileDiscard(git.verb, a, cwd) &&
        !RETARGETS.test(whole) &&
        inAgentWorktree(cwd);
      // Deleting a branch whose pull request merged loses nothing, but only as a lone plain git
      // call, for the same reason as above; the cwd is the repository the branch names live in.
      // GitHub is asked only for a call that would ask otherwise (`&&` stops before the lookup).
      if (
        irreversible &&
        !ownDiscard &&
        !(
          loneGitCall &&
          git.verb === 'branch' &&
          !RETARGETS.test(whole) &&
          deletesOnlyMergedBranches(a, cwd)
        )
      ) {
        verdicts.push({
          decision: 'ask',
          reason: pushesMain
            ? 'main changes only through a pull request.'
            : `git ${git.verb} ${a.join(' ')} cannot be undone easily.`,
        });
      }
    }
    const next = segs[index + 1];
    if (TEST_RUNNER.test(seg.raw) && next) {
      const pipedToTail = seg.separator === '|' && /^(tail|head)\b/.test(next.raw);
      const echoesStatus = seg.separator === ';' && /^echo \$\?/.test(next.raw);
      if (pipedToTail || echoesStatus) {
        verdicts.push({
          decision: 'warn',
          reason:
            'Run test commands plainly: piping to tail or echoing $? hides failures and exit codes.',
        });
      }
    }
  }
  if (verdicts.length === 0) return null;
  const worst = Math.max(...verdicts.map((v) => SEVERITY[v.decision]));
  const top = verdicts.filter((v) => SEVERITY[v.decision] === worst);
  return { decision: top[0].decision, reason: top.map((v) => v.reason).join(' ') };
}

function main() {
  if (process.env.TENDB_GIT_GUARD === 'off') return;
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (input?.tool_name !== 'Bash' || typeof input?.tool_input?.command !== 'string') return;
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const verdict = judge(input.tool_input.command, cwd);
  if (!verdict) return;
  const hookSpecificOutput =
    verdict.decision === 'warn'
      ? { hookEventName: 'PreToolUse', additionalContext: verdict.reason }
      : {
          hookEventName: 'PreToolUse',
          permissionDecision: verdict.decision,
          permissionDecisionReason: verdict.reason,
        };
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
}

try {
  main();
} catch {
  // Fail open: a guard bug must never block work.
}
process.exitCode = 0;
