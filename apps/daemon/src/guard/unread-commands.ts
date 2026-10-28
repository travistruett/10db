import type { HazardDef } from '@10db/contracts';
import { plainWords, RUNNERS } from './command-forms';
import { commandOf, SHELL_C_FLAG, shellQuote, shellScripts } from './judge';
import {
  commandName,
  findExecCommands,
  leadingWords,
  parseShell,
  redirectionSpan,
  stripCommandPrefixes,
  type ShellSegment,
} from './shell-words';

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
]);
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
 * unread word reached before the pattern ends can supply the rest of it.
 */
function mayStartWith(words: readonly string[], pattern: readonly string[]): boolean {
  for (let at = 0; at < pattern.length; at += 1) {
    const word = words[at];
    if (word === undefined) return false;
    if (word === UNREAD_WORD) return true;
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

interface Scanner {
  readonly patterns: readonly (readonly string[])[];
}

/**
 * Whether the command's words, with every unread word free to become anything, could be a hazard.
 * An unread word counts twice: it may stand in a flag's value slot, which the comparison skips, and
 * still add a word of its own.
 */
function mayBeHazard(words: readonly string[], segment: ShellSegment, scanner: Scanner): boolean {
  const [program = '', ...rest] = words;
  const arguments_ = withoutRedirections(rest).flatMap((word) =>
    EXPANDING.test(word) ? [UNREAD_WORD, UNREAD_WORD] : [word],
  );
  // xargs appends the words it reads from its input to the command it runs.
  if (segment.words.some((word) => commandName(word) === 'xargs')) arguments_.push(UNREAD_WORD);
  const bare = plainWords([commandName(program), ...arguments_]).map((plain) => plain.word);
  return scanner.patterns.some((pattern) => mayStartWith(bare, pattern));
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
  scanner: Scanner,
): Unread | null {
  const text = segment.raw;
  if (segment.processSubstitution) return { reason: UnreadReason.ProcessSubstitution, text };
  for (const body of segment.nested) {
    const found = scanScript(body, depth, scanner);
    if (found !== null) return found;
  }
  // A program that takes a here-document as data still has the shell run a substitution in an
  // unquoted body, and the quoting of the delimiter is not kept.
  for (const body of segment.hereDocuments) {
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
  const written = words[0];
  if (written === undefined) return null;
  const head = commandName(written);
  if (SYNTAX.has(head)) return null;
  if (OPAQUE.has(head) || !PLAIN_PROGRAM.test(written)) {
    return { reason: UnreadReason.CommandName, text: written };
  }
  if (head === 'eval') return { reason: UnreadReason.Script, text };
  if (SHELLS.has(head)) {
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
  return mayBeHazard(words, segment, scanner) ? { reason: UnreadReason.HazardForm, text } : null;
}

function scanScript(command: string, depth: number, scanner: Scanner): Unread | null {
  const parse = parseShell(command);
  if (!parse.certain) return { reason: UnreadReason.Structure, text: command };
  let previous = '';
  for (const segment of parse.segments) {
    const found = scanSegment(segment, previous === '|', depth, scanner);
    if (found !== null) return found;
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
  return scanScript(command, 0, { patterns: hazardPatterns(hazards) });
}
