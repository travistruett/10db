import type { HazardDef } from '@10db/contracts';
import { redirectionViews, shellScripts, SHELLS, withoutRedirections } from './judge';
import { isNumericArithmetic, numericNames } from './numeric-names';
import { leadingWords, parseShell } from './shell-words';
import { executableTails, FEEDERS, takesDataArguments } from './wrapped-commands';

/** A character that makes the shell replace a word with text 10db cannot read from the command. */
const EXPANDING = /[$`*?[]/;
const EXPANDING_ALL = /[$`*?[]/g;
/** A program name written out in plain text. */
const PLAIN_PROGRAM = /^(?:~?[A-Za-z0-9_@+%,:./-]+|\[\[?)$/;

const MAX_DEPTH = 3;

const baseName = (word: string): string => word.slice(word.lastIndexOf('/') + 1);

/** What the checks compare a command with: the hazards' programs, and their commands as words. */
interface Known {
  readonly programs: ReadonlySet<string>;
  readonly commands: readonly (readonly string[])[];
  /** Variables the whole command sets only to numbers. */
  readonly numeric: ReadonlySet<string>;
}

/** A word written out in plain text: the shell fills in none of it. */
const LITERAL = /^[A-Za-z0-9_@+%,:./=-]+$/;
/** Programs `pnpm exec` runs that take their arguments as data and run no other program. */
const FIXED_PROGRAMS: ReadonlySet<string> = new Set(['prettier', 'eslint', 'vitest', 'tsc']);
/** Programs that run the script named by their first argument. */
const SCRIPT_RUNNERS: ReadonlySet<string> = new Set(['node', 'tsx']);
/** Scripts every package names the same: pnpm runs the script, and an argument goes to it. */
const FIXED_SCRIPTS: ReadonlySet<string> = new Set([
  'test',
  'lint',
  'typecheck',
  'build',
  'format',
  'check',
  'coverage',
]);
/** pnpm flags that take the next word as their value. */
const PNPM_VALUE_FLAGS: ReadonlySet<string> = new Set(['--filter', '-F', '--dir', '-C']);

/**
 * The words a pnpm command line names in plain text before its arguments, when the program or
 * script it runs is fixed: `pnpm exec prettier`, `pnpm --filter @x/y test`, `pnpm exec node
 * script.mjs`. Null when a filled-in word could pick the program or pnpm's subcommand, or the
 * program is not one that takes its arguments as data.
 */
function fixedPnpmCommand(line: readonly string[]): string[] | null {
  let at = 1;
  while (at < line.length && (line[at] ?? '').startsWith('-')) {
    const flag = line[at] ?? '';
    if (!LITERAL.test(flag)) return null;
    if (PNPM_VALUE_FLAGS.has(flag)) {
      if (!LITERAL.test(line[at + 1] ?? '')) return null;
      at += 2;
    } else at += 1;
  }
  const [sub = '', first = '', second = ''] = line.slice(at);
  // `pnpm run $x` and `pnpm run build $x` stay unread: `run` takes its script from the next word.
  if (!LITERAL.test(sub)) return null;
  if (sub === 'exec') {
    if (FIXED_PROGRAMS.has(first)) return ['pnpm', 'exec', first];
    // A script runner's own flags (`-e`, `--import`) could run any text, so its script comes first.
    if (SCRIPT_RUNNERS.has(first) && LITERAL.test(second) && !second.startsWith('-')) {
      return ['pnpm', 'exec', first, second];
    }
    return null;
  }
  if (FIXED_SCRIPTS.has(sub) || FIXED_PROGRAMS.has(sub)) return ['pnpm', sub];
  return null;
}

/**
 * Whether every word the shell fills in follows a fixed pnpm program or script, so it can only be
 * an argument to it: no word picks the program or pnpm's subcommand. A hazard command that goes on
 * from the fixed words (`pnpm lint fix`) can still be spelled by the argument, so it is not.
 */
function argumentsOnly(line: readonly string[], commands: readonly (readonly string[])[]): boolean {
  if (baseName(line[0] ?? '') !== 'pnpm') return false;
  const fixed = fixedPnpmCommand(line);
  if (fixed === null) return false;
  // `pnpm exec prettier` and `pnpm prettier` run the same program.
  const spellings = [fixed, ...(fixed[1] === 'exec' ? [['pnpm', ...fixed.slice(2)]] : [])];
  return !spellings.some((spelling) =>
    commands.some(
      (command) =>
        command.length > spelling.length && spelling.every((word, i) => command[i] === word),
    ),
  );
}

/** The fail-closed checks on one reading of a segment's words. */
function readingAsk(words: readonly string[], known: Known, tail: boolean): string | null {
  const hazardPrograms = known.programs;
  const program = programOf(words);
  const line = words.slice(words.indexOf(program));
  if (!tail && program !== '' && !PLAIN_PROGRAM.test(program)) {
    return `The program "${program}" is not written out, so 10db cannot tell what it runs.`;
  }
  // A hazard program anywhere in the command line (behind env, command, nice...) with a word the
  // shell expands after it: the expansion could select a hazard form.
  const at = line.findIndex((word) => hazardPrograms.has(baseName(word)));
  if (
    at >= 0 &&
    !takesDataArguments(program) &&
    line.slice(at + 1).some((word) => EXPANDING.test(word)) &&
    !argumentsOnly(line.slice(at), known.commands)
  ) {
    return 'A program with hazard forms is followed by a word the shell expands.';
  }
  // A feeder anywhere before the hazard program, however many wrappers stand between them.
  const feeder = line.findIndex((word) => FEEDERS.has(baseName(word)));
  if (feeder >= 0 && line.slice(feeder + 1).some((word) => hazardPrograms.has(baseName(word)))) {
    return `"${baseName(line[feeder] ?? '')}" feeds a program with hazard forms its arguments.`;
  }
  return null;
}

/** The program a segment runs: its first word that is not an assignment. */
function programOf(words: readonly string[]): string {
  return words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? '';
}

/**
 * A fail-closed reading of one command: a program that is not plain text, a hazard program followed
 * by a word the shell expands, or a wrapper that runs a hazard program, each of which could spell a
 * hazard 10db cannot see. Everything else is left to `hazardHit`.
 */
export function unreadableHazard(command: string, hazards: readonly HazardDef[]): string | null {
  return unreadableIn(
    command,
    {
      programs: hazardPrograms(hazards),
      commands: hazards.flatMap((hazard) => hazard.commands.map((c) => c.split(' '))),
      numeric: numericNames(command),
    },
    0,
  );
}

function unreadableIn(command: string, known: Known, depth: number): string | null {
  const hazardPrograms = known.programs;
  const segments = parseShell(command).segments;
  for (const [index, segment] of segments.entries()) {
    const command = leadingWords(segment.words).command;
    const offset = segment.words.length - command.length;
    // A quoted literal such as '@10db/*' is text; only a word the shell fills in keeps its markers.
    const written = command.map((word, i) =>
      segment.dynamicWords[offset + i] === true
        ? EXPANDING.test(word) || word.startsWith('~')
          ? word
          : `${word}$`
        : word.replaceAll(EXPANDING_ALL, '_'),
    );
    // The parser keeps no mark of a quoted word, so every reading of the redirections is checked.
    for (const view of redirectionViews(written)) {
      const found = readingAsk(view, known, false);
      if (found !== null) return found;
      for (const tail of executableTails(view)) {
        const wrapped = readingAsk(tail, known, true);
        if (wrapped !== null) return wrapped;
      }
    }
    const words = withoutRedirections(written);
    const [head = ''] = words;
    // eval runs its words as shell text: read them again as a command, from the words as written.
    const evalAt = command.findIndex((word) => baseName(word) === 'eval');
    if (evalAt >= 0 && depth < MAX_DEPTH) {
      const body = command.slice(evalAt + 1).join(' ');
      const found = body === '' ? null : unreadableIn(body, known, depth + 1);
      if (found !== null) return found;
    }
    const program = programOf(words);
    if (head === '') continue;
    // A segment the parser is unsure of, around a program with hazard forms, cannot be read.
    if (
      (!segment.wordsCertain || !segment.bracesCertain) &&
      words.some((word) => hazardPrograms.has(baseName(word)))
    ) {
      return 'The parser is unsure where this command around a hazard program begins and ends.';
    }
    if (SHELLS.has(baseName(program)) && segments[index - 1]?.separator === '|') {
      return `"${program}" reads the script piped into it, which 10db cannot read.`;
    }
    if (depth < MAX_DEPTH) {
      const documents = SHELLS.has(baseName(program)) ? segment.hereDocuments : [];
      const inner = [
        ...segment.nested,
        ...documents,
        ...shellScripts(withoutRedirections(command)),
      ];
      for (const body of inner) {
        // `$((expr))` over numbers reaches here as the subshell `(expr)`; it runs no command.
        if (isNumericArithmetic(body, segment.words, known.numeric)) continue;
        const found = unreadableIn(body, known, depth + 1);
        if (found !== null) return found;
      }
    }
  }
  return null;
}

/** The programs the hazards' commands start with (`pnpm`, `drizzle-kit`), by base name. */
export function hazardPrograms(hazards: readonly HazardDef[]): Set<string> {
  return new Set(
    hazards.flatMap((hazard) => hazard.commands.map((c) => baseName(c.split(' ')[0] ?? ''))),
  );
}
