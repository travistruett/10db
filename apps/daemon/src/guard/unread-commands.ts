import { posix } from 'node:path';
import type { HazardDef } from '@10db/contracts';
import {
  declaresInteger,
  declaresNameref,
  expandsIndirectly,
  evaluatesUnread,
  unreadArithmeticIn,
} from './arithmetic-words';
import { plainWordReadings, RUNNERS } from './command-forms';
import { commandOf, SHELL_C_FLAG, shellQuote, shellScripts } from './judge';
import {
  commandName,
  findExecCommands,
  leadingWords,
  parseShell,
  redirectionSpan,
  stripCommandPrefixes,
  wrapperUse,
  type ShellSegment,
} from './shell-words';
import { XARGS_VALUE_FLAGS, XARGS_VALUELESS_LONG_FLAGS } from './xargs-options';

/** Why 10db cannot tell, from a command's text, that it runs no hazard. */
export const UnreadReason = {
  /** The parser is unsure where commands begin and end: an open quote or parenthesis, a group, a case. */
  Structure: 'STRUCTURE',
  /** A `<(…)` or `>(…)` hands what a command writes or reads to another command. */
  ProcessSubstitution: 'PROCESS_SUBSTITUTION',
  /** The program that runs is not a plain name: an expansion, a substitution, a glob, or a program that runs another. */
  CommandName: 'COMMAND_NAME',
  /** A shell, `eval` or `find -exec` runs text 10db cannot read, or follows nesting past its limit. */
  Script: 'SCRIPT',
  /** A program that has a hazard form gets an argument that could select it. */
  HazardForm: 'HAZARD_FORM',
} as const;
export type UnreadReason = (typeof UnreadReason)[keyof typeof UnreadReason];

export interface Unread {
  readonly reason: UnreadReason;
  /** The part of the command that could not be read. */
  readonly text: string;
}

/** The deepest `sh -c`, `eval` and `find -exec` nesting followed, as in `hazardHit`. */
const MAX_DEPTH = 3;

/** Stands for an argument the shell expands, which may become any number of words. */
const UNREAD_WORD = '\u0000';
/** Stands for a quoted expansion, which the shell passes as exactly one word, whatever it holds. */
const ONE_WORD = '\u0001';

/** A program name the shell runs as written: a path or a name of plain characters, or a test bracket. */
const PLAIN_PROGRAM = /^(?:[A-Za-z0-9_@+%,:./-]+|\[\[?)$/;
/** A character that makes the shell replace a word: an expansion, a substitution, a glob or a redirection. */
const EXPANDING = /[$`*?[\]~^#()<>|{}]/;
/** A substitution in a here-document body, which the shell may run whoever reads the body. */
const EXECUTED_IN_BODY = /\$\(|`/;
/** A script the invoking shell expands before the inner shell reads it. */
const EXPANDED_SCRIPT = /[$`]/;

/** Words that only shape a loop or end a compound command; they run nothing themselves. */
const SYNTAX: ReadonlySet<string> = new Set(['for', 'select', 'done', 'fi', 'esac']);
/** Programs that run another command or define one for later, which the guard does not look through. */
const OPAQUE: ReadonlySet<string> = new Set([
  'sudo',
  'doas',
  'su',
  'noglob',
  'nocorrect',
  'coproc',
  'repeat',
  'foreach',
  'function',
  'alias',
  // Run text on a signal, or rebind a name to another program, for a later command to meet.
  'trap',
  'hash',
]);
/** Builtins that run a file the shell reads, which stdin or a here-string makes unreadable. */
const SOURCING: ReadonlySet<string> = new Set(['.', 'source']);
/** A redirection that feeds a command from a file, a descriptor or a here-string. */
const INPUT_REDIRECTION = /^\d*<(?!<<)|^\d*<<</;
const SHELLS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'csh',
  'tcsh',
]);

/**
 * The word sequences that make a command a hazard, as `hazardHit` compares them: each hazard's
 * command, and that command run through a runner such as `pnpm exec`. Taken from the project's
 * hazards, so a custom command is covered the same way as the defaults.
 */
function hazardPatterns(hazards: readonly HazardDef[]): string[][] {
  const commands = hazards.flatMap((hazard) =>
    hazard.commands.map((command) => command.split(' ').filter((word) => word !== '')),
  );
  return [...commands, ...RUNNERS.flatMap((runner) => commands.map((c) => [...runner, ...c]))];
}

/**
 * Whether the words may start with the pattern once each unread word is read as whatever fits. An
 * unread word reached before the pattern ends can supply the rest of it. A one-word stand-in that is
 * still a plain word could be a flag or a word of the pattern, so it is unread too; it only helps
 * where a flag's value slot swallows it.
 */
function mayStartWith(words: readonly string[], pattern: readonly string[]): boolean {
  for (let at = 0; at < pattern.length; at += 1) {
    const word = words[at];
    if (word === undefined) return false;
    if (word === UNREAD_WORD || word === ONE_WORD) return true;
    if (word !== pattern[at]) return false;
  }
  return true;
}

/** The words of a command's arguments without its redirections and their targets. */
function withoutRedirections(words: readonly string[]): string[] {
  const out: string[] = [];
  for (let at = 0; at < words.length;) {
    const span = redirectionSpan(words, at);
    if (span > 0) {
      at += span;
    } else {
      out.push(words[at] ?? '');
      at += 1;
    }
  }
  return out;
}

/** The file a `.` or `source` reads, or null when it names none or follows an option but `--`. */
function sourceOperand(words: readonly string[]): string | null {
  const rest = withoutRedirections(words.slice(1));
  const first = rest[0];
  if (first === '--') return rest[1] ?? null;
  // An option other than `--` changes how the shell reads the operand, so the scan reads none.
  return first === undefined || first.startsWith('-') ? null : first;
}

/**
 * Whether a source operand is a file in or under the working directory, or an absolute path that is
 * not a device or process file once `.`, `..` and repeated slashes are resolved; a stream, an
 * expansion or a path that climbs out is not.
 */
function isCheckoutFile(operand: string | null): boolean {
  if (operand === null || operand === '-' || EXPANDING.test(operand)) return false;
  const path = posix.normalize(operand);
  if (path.startsWith('..')) return false;
  return !/^\/(?:dev|proc)(?:\/|$)/.test(path);
}

/** What the xargs that runs a command was given that changes which words it runs. */
interface XargsOptions {
  /** The string `-I`, `-i`, `-J` or `--replace` makes xargs swap for each input word. */
  readonly replace: string | null;
  /** What the scan cannot follow: a long flag it does not know, or more than one xargs. */
  readonly unreadFlag: string | null;
}

/** The flags of the xargs wrappers a command runs behind, or null when it has none. */
function xargsOptions(commandWords: readonly string[]): XargsOptions | null {
  const { count, flags } = wrapperUse(commandWords, 'xargs');
  if (count === 0) return null;
  if (count > 1) return { replace: null, unreadFlag: 'xargs' };
  let replace: string | null = null;
  let unreadFlag: string | null = null;
  for (const { flag, value } of flags) {
    if (flag.startsWith('--')) {
      const name = flag.split('=')[0] ?? flag;
      if (name === '--replace')
        replace = flag.includes('=') ? flag.slice(flag.indexOf('=') + 1) : '{}';
      else if (!XARGS_VALUE_FLAGS.includes(name) && !XARGS_VALUELESS_LONG_FLAGS.includes(name)) {
        unreadFlag = flag;
      }
      continue;
    }
    for (let i = 1; i < flag.length; i += 1) {
      const letter = flag.charAt(i);
      const rest = flag.slice(i + 1);
      if (letter === 'i') {
        replace = rest === '' ? '{}' : rest;
        break;
      }
      if (XARGS_VALUE_FLAGS.includes(`-${letter}`)) {
        if (letter === 'I' || letter === 'J') replace = rest === '' ? (value ?? '') : rest;
        break;
      }
    }
  }
  return { replace, unreadFlag };
}

interface Scanner {
  readonly patterns: readonly (readonly string[])[];
  /** An earlier command in the script may have changed the working directory. */
  readonly moved: boolean;
  /** The script's standard input may be a pipe from an enclosing command. */
  readonly stdin: boolean;
}

/** Programs that change the shell's working directory. */
const DIRECTORY_CHANGES: ReadonlySet<string> = new Set(['cd', 'pushd', 'popd']);

/**
 * What one argument stands for in the comparison with a hazard command: itself, or, when it has an
 * expansion, a stand-in. A fully quoted expansion is one word, which only helps where a flag's value
 * slot swallows it (`--filter "$p"`); after a literal `--flag=` it is that flag's attached value. Any
 * other expansion may become any number of words. A stand-in for a flag's value counts twice, since
 * it could also add a word.
 */
function argumentWords(word: string, single: boolean, replaced: boolean): string[] {
  if (replaced) return [UNREAD_WORD, UNREAD_WORD];
  if (!EXPANDING.test(word)) return [word];
  if (!single) return [UNREAD_WORD, UNREAD_WORD];
  if (!word.startsWith('-')) return [ONE_WORD];
  // Only a literal `--flag=` before the expansion makes it that flag's attached value.
  const prefix = word.slice(0, word.search(EXPANDING));
  return prefix.includes('=') ? [prefix] : [UNREAD_WORD, UNREAD_WORD];
}

/**
 * Whether the command's words, with every unread word free to become anything, could be a hazard.
 * An unread word counts twice: it may stand in a flag's value slot, which the comparison skips, and
 * still add a word of its own.
 */
function mayBeHazard(
  words: readonly string[],
  segment: ShellSegment,
  scanner: Scanner,
  xargs: XargsOptions | null,
): boolean {
  const program = words[0] ?? '';
  // A replace string stands for the input in every argument that holds it.
  const replaced = xargs?.replace != null;
  const offset = segment.singleWords.length - words.length;
  const arguments_: string[] = [];
  for (let at = 1; at < words.length;) {
    const span = redirectionSpan(words, at);
    if (span > 0) {
      at += span;
      continue;
    }
    const word = words[at] ?? '';
    arguments_.push(
      ...argumentWords(word, !replaced && segment.singleWords[offset + at] === true, replaced),
    );
    at += 1;
  }
  // corepack runs the program it is given, which an expansion hides.
  const first = arguments_[0];
  if (commandName(program) === 'corepack' && (first === UNREAD_WORD || first === ONE_WORD)) {
    return scanner.patterns.length > 0;
  }
  // xargs appends the words it reads from its input to the command it runs.
  if (segment.words.some((word) => commandName(word) === 'xargs')) arguments_.push(UNREAD_WORD);
  return plainWordReadings([commandName(program), ...arguments_]).some((reading) => {
    const bare = reading.map((plain) => plain.word);
    return scanner.patterns.some((pattern) => mayStartWith(bare, pattern));
  });
}

function scanShell(
  words: readonly string[],
  segment: ShellSegment,
  piped: boolean,
  depth: number,
  scanner: Scanner,
): Unread | null {
  const text = segment.raw;
  const withC = words.some((word) => SHELL_C_FLAG.test(word));
  const scripts = shellScripts(words);
  if (withC && scripts.length === 0) return { reason: UnreadReason.Script, text };
  // A script that reads as an option means the scan and the shell disagree on which word it is.
  if (scripts.some((script) => /^[-+]/.test(script))) return { reason: UnreadReason.Script, text };
  if (!withC) {
    const operands = words.slice(1).filter((word) => !word.startsWith('-'));
    const readsStdin =
      piped ||
      words.some((word) => /^\d*<(?!<)/.test(word)) ||
      (operands.length === 0 && scripts.length === 0 && segment.hereDocuments.length === 0);
    if (readsStdin) return { reason: UnreadReason.Script, text };
  }
  for (const script of [...scripts, ...segment.hereDocuments]) {
    if (EXPANDED_SCRIPT.test(script)) return { reason: UnreadReason.Script, text: script };
  }
  if (scripts.length > 0 && depth >= MAX_DEPTH) return { reason: UnreadReason.Script, text };
  for (const script of scripts) {
    const found = scanScript(script, depth + 1, scanner);
    if (found !== null) return found;
  }
  for (const body of segment.hereDocuments) {
    const found = scanScript(body, depth, scanner);
    if (found !== null) return found;
  }
  return null;
}

/** The substitutions in a here-document body that a program reads as data; the rest of the text is not commands. */
function scanSubstitutions(body: string, depth: number, scanner: Scanner): Unread | null {
  const parse = parseShell(body);
  if (!parse.certain) return { reason: UnreadReason.Structure, text: body };
  for (const segment of parse.segments) {
    for (const nested of segment.nested) {
      const found = scanScript(nested, depth, scanner);
      if (found !== null) return found;
    }
  }
  return null;
}

function scanSegment(
  segment: ShellSegment,
  piped: boolean,
  depth: number,
  outer: Scanner,
): Unread | null {
  const scanner: Scanner = { ...outer, stdin: outer.stdin || piped };
  const text = segment.raw;
  if (segment.processSubstitution) return { reason: UnreadReason.ProcessSubstitution, text };
  for (const body of segment.nested) {
    const found = scanScript(body, depth, scanner);
    if (found !== null) return found;
  }
  // A program that takes a here-document as data still has the shell run a substitution in an
  // unquoted body.
  for (const [at, body] of segment.hereDocuments.entries()) {
    // A quoted delimiter means the shell expands nothing in the body, so it is data.
    if (segment.quotedHereDocuments[at] === true) continue;
    const found = EXECUTED_IN_BODY.test(body) ? scanSubstitutions(body, depth, scanner) : null;
    if (found !== null) return found;
  }
  const run = commandOf(segment);
  if (run.hiddenByEnv || run.hiddenByRedirection) return { reason: UnreadReason.CommandName, text };
  // The command as written, with its path, so an expansion in a directory is seen too.
  const words = stripCommandPrefixes(leadingWords(segment.words).command, {
    lookThroughRunners: true,
    skipRedirections: true,
    keepCommandPath: true,
  });
  // Before the program is read: an assignment alone, `a[$(cmd)]=1`, has none.
  if (segment.words.some((word) => unreadArithmeticIn(word))) {
    return { reason: UnreadReason.Script, text };
  }
  const written = words[0];
  if (written === undefined) return null;
  const head = commandName(written);
  if (SYNTAX.has(written)) return null;
  const xargs = xargsOptions(leadingWords(segment.words).command);
  if (xargs?.unreadFlag != null)
    return { reason: UnreadReason.CommandName, text: xargs.unreadFlag };
  const replace = xargs?.replace ?? null;
  if (
    OPAQUE.has(head) ||
    !PLAIN_PROGRAM.test(written) ||
    (replace !== null && written.includes(replace))
  ) {
    return { reason: UnreadReason.CommandName, text: written };
  }
  if (evaluatesUnread(head, words)) {
    return { reason: UnreadReason.Script, text };
  }
  if (head === 'eval') {
    // eval runs its words as a script: read that script, or call it unread past the depth limit.
    if (depth >= MAX_DEPTH) return { reason: UnreadReason.Script, text };
    const found = scanScript(words.slice(1).join(' '), depth + 1, scanner);
    if (found !== null) return found;
  }
  if (SOURCING.has(head)) {
    const operand = sourceOperand(words);
    if (
      scanner.stdin ||
      !isCheckoutFile(operand) ||
      (scanner.moved && !posix.isAbsolute(operand ?? '')) ||
      words.some((w) => INPUT_REDIRECTION.test(w))
    ) {
      return { reason: UnreadReason.Script, text };
    }
  }
  if (SHELLS.has(head)) {
    if (replace !== null && words.slice(1).some((word) => word.includes(replace))) {
      return { reason: UnreadReason.Script, text };
    }
    const found = scanShell(words, segment, piped, depth, scanner);
    if (found !== null) return found;
  }
  if (head === 'find') {
    for (const exec of findExecCommands(words)) {
      if (depth >= MAX_DEPTH) return { reason: UnreadReason.Script, text };
      const found = scanScript(exec.map(shellQuote).join(' '), depth + 1, scanner);
      if (found !== null) return found;
    }
  }
  return mayBeHazard(words, segment, scanner, xargs)
    ? { reason: UnreadReason.HazardForm, text }
    : null;
}

/**
 * Whether the script, or a script inside it, gives a variable the integer attribute or makes a
 * name refer to another, or expands a variable by another's name.
 */
function declaresIntegerAnywhere(command: string, depth: number): boolean {
  if (depth > MAX_DEPTH + 1) return true;
  return parseShell(command).segments.some((segment) => {
    const words = stripCommandPrefixes(leadingWords(segment.words).command, {
      lookThroughRunners: true,
      skipRedirections: true,
      keepCommandPath: true,
    });
    const head = commandName(words[0] ?? '');
    if (declaresInteger(head, words) || declaresNameref(head, words)) return true;
    if (segment.words.some((word) => expandsIndirectly(word))) return true;
    // A quoted body is data unless a shell reads it.
    const bodies = SHELLS.has(head)
      ? segment.hereDocuments
      : segment.hereDocuments.filter((_, at) => segment.quotedHereDocuments[at] !== true);
    const inner = [
      ...segment.nested,
      ...bodies,
      ...(SHELLS.has(head) ? shellScripts(words) : []),
      ...(head === 'eval' ? [words.slice(1).join(' ')] : []),
      ...(head === 'find'
        ? findExecCommands(words).map((exec) => exec.map(shellQuote).join(' '))
        : []),
    ];
    return inner.some((body) => declaresIntegerAnywhere(body, depth + 1));
  });
}

function scanScript(command: string, depth: number, outer: Scanner): Unread | null {
  const parse = parseShell(command);
  if (!parse.certain) return { reason: UnreadReason.Structure, text: command };
  let previous = '';
  let moved = outer.moved;
  for (const segment of parse.segments) {
    const found = scanSegment(segment, previous === '|', depth, { ...outer, moved });
    if (found !== null) return found;
    const [first = ''] = leadingWords(segment.words).command;
    if (DIRECTORY_CHANGES.has(commandName(first))) moved = true;
    previous = segment.separator;
  }
  return null;
}

/**
 * The first reason 10db cannot say a sandboxed command is free of hazards, or null when it can.
 *
 * Every simple command, in substitutions, here-documents read by a shell, `sh -c`, `find -exec` and
 * the commands behind `env`, `exec`, `xargs` and the like, must be a program named in plain text. An
 * unread argument matters only to a program that has a hazard form: if reading the unread words as
 * anything could make the line start like one of the project's hazard commands (`pnpm $x` could be
 * `pnpm add`), the command is unread. It covers hazards the command spells out too, and a hazard hidden
 * behind a redirection that `hazardHit` does not see through. The scan never narrows `hazardHit`: the
 * caller still asks `hazardHit` first.
 */
export function firstUnread(command: string, hazards: readonly HazardDef[]): Unread | null {
  // An integer or a nameref evaluates what is assigned to it, here or in a later command, and an
  // indirect expansion looks up a name it holds, so any of them makes the whole script unread.
  if (declaresIntegerAnywhere(command, 0)) return { reason: UnreadReason.Script, text: command };
  return scanScript(command, 0, {
    patterns: hazardPatterns(hazards),
    moved: false,
    stdin: false,
  });
}
