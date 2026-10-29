#!/usr/bin/env node
// PreToolUse guard for Bash commands in this repository. It enforces the git rules in AGENTS.md.
// Fail-open: any parse problem or internal error allows the command, because a broken guard must
// never wedge a session. Kill switch: TENDB_GIT_GUARD=off in the environment Claude Code starts
// with. A Bash command can't set it for the hook, and there is no kill-switch file an agent could
// write.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

/**
 * @typedef {{
 *   raw: string,
 *   words: string[],
 *   separator: string,
 *   substitutions: string[],
 *   heredocs: string[],
 * }} Segment
 * `raw` keeps the segment text for quote-aware checks, `separator` is the operator that ended it,
 * `substitutions` holds the commands of `$(...)` and backticks that run inside double quotes or an
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
    /** Open parentheses of the `$((...))` or `((...))` being read; heredocs can't start there. */
    this.arithParens = 0;
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

  /** @param {string} separator */
  endSegment(separator) {
    this.endWord();
    if (this.raw.trim() !== '') {
      this.out.push({
        raw: this.raw.trim(),
        words: this.words,
        separator,
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
    this.endSegment(ch);
    this.pos += 1;
    if (ch === '\n') this.skipHeredocBodies();
    return true;
  }

  openParen() {
    if (this.arithParens > 0) this.arithParens += 1;
    else if (this.source.startsWith('((', this.pos)) {
      // `$((` anywhere, or `((` where a command would start, opens an arithmetic expression.
      if (this.word.endsWith('$') || this.raw === '') this.arithParens = 1;
    }
    this.parenDepth += 1;
  }

  /** @returns {boolean} true when this `)` closes the substitution being read */
  closeParen() {
    if (this.arithParens > 0) this.arithParens -= 1;
    if (this.parenDepth === 0 && this.stopAtParen) {
      this.closedAt = this.pos;
      return true;
    }
    this.parenDepth = Math.max(0, this.parenDepth - 1);
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

/** @typedef {{ valueOptions: string[], operands: number }} Wrapper */
/** @type {Wrapper} */
const PLAIN_WRAPPER = { valueOptions: [], operands: 0 };
// Words that run another command without changing what it is: shell keywords and wrappers. Each
// lists the options that take a separate value and how many positional words precede the command.
/** @type {Map<string, Wrapper>} */
const WRAPPERS = new Map([
  ...['!', '{', '}', 'if', 'elif', 'while', 'until', 'then', 'do', 'else'].map(
    (keyword) => /** @type {[string, Wrapper]} */ ([keyword, PLAIN_WRAPPER]),
  ),
  ...['time', 'command', 'nohup', 'setsid'].map(
    (name) => /** @type {[string, Wrapper]} */ ([name, PLAIN_WRAPPER]),
  ),
  ['exec', { valueOptions: ['-a'], operands: 0 }],
  ['nice', { valueOptions: ['-n'], operands: 0 }],
  ['env', { valueOptions: ['-u', '-C'], operands: 0 }],
  ['stdbuf', { valueOptions: ['-i', '-o', '-e'], operands: 0 }],
  ['timeout', { valueOptions: ['-s', '-k'], operands: 1 }],
  [
    'sudo',
    {
      valueOptions: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t'],
      operands: 0,
    },
  ],
  ['xargs', { valueOptions: ['-n', '-I', '-L', '-P', '-d', '-s', '-E', '-a'], operands: 0 }],
]);

/**
 * Index of the word after a wrapper's options and positional operands.
 * @param {string[]} words
 * @param {number} from index just past the wrapper word
 * @param {Wrapper} wrapper
 */
function skipWrapperArguments(words, from, wrapper) {
  let i = from;
  while (i < words.length && words[i].startsWith('-') && words[i] !== '-') {
    if (words[i] === '--') {
      i += 1;
      break;
    }
    i += wrapper.valueOptions.includes(words[i]) ? 2 : 1;
  }
  return Math.min(i + wrapper.operands, words.length);
}

/**
 * Index of the first word after leading `VAR=value` words, wrappers and their options.
 * @param {string[]} words
 */
function commandStart(words) {
  let i = 0;
  while (i < words.length) {
    const wrapper = WRAPPERS.get(posix.basename(words[i]));
    if (ENV_ASSIGNMENT.test(words[i])) i += 1;
    else if (wrapper) i = skipWrapperArguments(words, i + 1, wrapper);
    else break;
  }
  return i;
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
 * options. `config` collects every `-c key=value` and `--config-env key=VAR` passed to git itself.
 * @param {string[]} words
 */
function gitSubcommand(words) {
  let i = commandStart(words);
  if (programAt(words, i) !== 'git') return null;
  i += 1;
  /** @type {string[]} */
  const config = [];
  while (i < words.length && words[i].startsWith('-')) {
    const word = words[i];
    if (word === '-c' || word === '--config-env') config.push(words[i + 1] ?? '');
    if (word.startsWith('--config-env=')) config.push(word.slice('--config-env='.length));
    i += GIT_OPTIONS_WITH_VALUE.includes(word) ? 2 : 1;
  }
  return { verb: words[i] ?? '', args: words.slice(i + 1), config };
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
    if (word === '--split-string' || /^-[A-Za-z]*S$/.test(word)) return words[j + 1] ?? null;
    if (word.startsWith('--split-string=')) return word.slice('--split-string='.length);
    if (/^-[A-Za-z]*S./.test(word)) return word.slice(word.indexOf('S') + 1);
    if (word === '-u' || word === '-C') j += 1;
    else if (!word.startsWith('-') && !ENV_ASSIGNMENT.test(word)) break;
  }
  return null;
}

/**
 * The command a `bash -c`, `sh -c`, `zsh -c`, `eval` or `env -S` segment runs, so it can be
 * judged too. A flag cluster such as `-ce` or `-lc` counts as `-c`.
 * @param {string[]} words
 * @returns {string | null}
 */
function nestedCommand(words) {
  const split = envSplitString(words);
  if (split !== null) return split;
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
 * main checkout, where AGENTS.md puts the worktrees agents make by hand. False when git can't say.
 * @param {string} cwd
 */
function inAgentWorktree(cwd) {
  const lines = attempt(() =>
    gitOutput(cwd, [
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--git-common-dir',
    ]).split('\n'),
  );
  const [top, common] = lines ?? [];
  if (!top || !common || posix.basename(common) !== '.git') return false;
  const checkout = posix.dirname(common);
  return posix.dirname(top) === posix.join(posix.dirname(checkout), '10db-worktrees');
}

// Words that make a command act on a directory other than the cwd the guard judged: a change of
// directory, git's own retargeting options and its repository variables. Matched anywhere in the
// command, nested scripts and quoted text included, so a match only ever costs a prompt.
const RETARGETS =
  /(^|[\s;&|(){}`'"=])(cd|pushd|popd|chdir|-C|--chdir(=\S*)?|--git-dir(=\S*)?|--work-tree(=\S*)?)(?=$|[\s;&|(){}`'"])|\bGIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY)\b/;

/**
 * True when every pathspec names one file: no option, glob, pathspec magic, expansion syntax
 * (`$`, backtick, `~`, braces), `.`, directory or parent path. An empty list is false, since git then takes the whole tree or refuses.
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
        attempt(() => existsSync(join(cwd, p)) && statSync(join(cwd, p)).isDirectory()) !== true
      );
    })
  );
}

/**
 * True for the discards an agent may run without asking in its own worktree: `checkout [-q]
 * [<commit>] -- <file>...`, `restore` of named files with only the options that pick which copy, and
 * `stash store`, which only adds an entry.
 * @param {string} verb
 * @param {string[]} a
 * @param {string} cwd
 */
function isFileDiscard(verb, a, cwd) {
  if (verb === 'stash') return a[0] === 'store';
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
 * @returns {Verdict | null} the most severe verdict any segment earns
 */
function judge(command, cwd, whole = command) {
  const segs = segments(command);
  /** @type {Verdict[]} */
  const verdicts = [];
  /** @type {string[]} */
  const addedPaths = [];
  /** @type {string | null | undefined} undefined until looked up; null when git can't say */
  let prefix;
  const repoPrefix = () => {
    if (prefix === undefined) {
      prefix = attempt(() => gitOutput(cwd, ['rev-parse', '--show-prefix']).trim());
    }
    return prefix;
  };
  for (const [index, seg] of segs.entries()) {
    const start = commandStart(seg.words);
    const scripts = [nestedCommand(seg.words), ...seg.substitutions, ...stdinScripts(seg, start)];
    for (const inner of scripts) {
      const verdict = inner === null ? null : judge(inner, cwd, whole);
      if (verdict) verdicts.push(verdict);
    }
    if (seg.words.some((w) => HOOK_SKIP.test(w) && !HOOK_SKIP_HARMLESS.test(w))) {
      verdicts.push({
        decision: 'deny',
        reason:
          'Agents never disable or reroute the git hooks (LEFTHOOK*, GIT_CONFIG*). Fix what the hook reports.',
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
            attempt(() => existsSync(join(cwd, p)) && statSync(join(cwd, p)).isDirectory()),
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
          const staged = attempt(() => stagedPaths(cwd));
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
      const pushesMain =
        git.verb === 'push' &&
        (pushTargets.some((t) => MAIN_REFSPEC.test(t)) ||
          (pushTargets.length === 0 && currentBranch(cwd) === 'main'));
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
      // wrapper, assignment, substitution, heredoc or `$`, so nothing the shell runs or expands
      // first can point git at another checkout.
      const loneGitCall =
        whole === command &&
        segs.filter((x) => x.words.length > 0).length === 1 &&
        seg.words[0] === 'git' &&
        seg.substitutions.length === 0 &&
        seg.heredocs.length === 0 &&
        !/[$`]/.test(whole);
      const ownDiscard =
        loneGitCall &&
        ['checkout', 'restore', 'stash'].includes(git.verb) &&
        isFileDiscard(git.verb, a, cwd) &&
        !RETARGETS.test(whole) &&
        inAgentWorktree(cwd);
      if (irreversible && !ownDiscard) {
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
