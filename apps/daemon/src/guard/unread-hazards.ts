import type { HazardDef } from '@10db/contracts';
import { redirectionViews, shellScripts, SHELLS, withoutRedirections } from './judge';
import {
  hazardPatterns,
  mayStartWith,
  plainWordReadings,
  pnpmFlagKind,
  runCommandStarts,
  UNREAD_WORD,
} from './command-forms';
import { isNumericArithmetic, numericNames } from './numeric-names';
import { leadingWords, parseShell, stripCommandPrefixes } from './shell-words';
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
  /** The commands, and the commands run through a runner, as `hazardPatterns` gives them. */
  readonly patterns: readonly (readonly string[])[];
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
/**
 * The words a pnpm command line names in plain text before its arguments, when the program or
 * script it runs is fixed: `pnpm exec prettier`, `pnpm --filter @x/y test`, `pnpm exec node
 * script.mjs`. Null when a filled-in word could pick the program or pnpm's subcommand, the program
 * is not one that takes its arguments as data, a flag is in neither of pnpm's flag lists (it
 * might take the next word, so the subcommand could be a different word), or a value flag is
 * followed by a word starting with `-` (pnpm may read that word as a flag, not as the value).
 */
export function fixedPnpmCommand(line: readonly string[]): string[] | null {
  let at = 1;
  while (at < line.length && (line[at] ?? '').startsWith('-')) {
    const flag = line[at] ?? '';
    if (!LITERAL.test(flag)) return null;
    // `--filter=x` carries its value in the same word.
    const equals = flag.indexOf('=');
    const kind = pnpmFlagKind(equals < 0 ? flag : flag.slice(0, equals));
    if (kind === 'unknown') return null;
    if (kind === 'value' && equals < 0) {
      // nopt may not take a `-` word as the value, and then the next word is a flag of its own.
      const value = line[at + 1] ?? '';
      if (!LITERAL.test(value) || value.startsWith('-')) return null;
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

/** Programs that read their arguments as shell text again, so a word in front of them is a script. */
const REPARSERS: ReadonlySet<string> = new Set([
  ...SHELLS,
  ...FEEDERS,
  'eval',
  'watch',
  'ssh',
  'su',
  'sudo',
  'doas',
  'flock',
]);
/** Package managers whose subcommand words `packageManagerVariants` rewrites. */
const JS_MANAGERS: ReadonlySet<string> = new Set(['pnpm', 'npm', 'yarn', 'bun', 'npx', 'corepack']);
/** Programs that run the script or code named by their first operand. */
const INTERPRETERS: ReadonlySet<string> = new Set([
  'node',
  'tsx',
  'ts-node',
  'deno',
  'bun',
  'python',
  'python3',
  'ruby',
  'perl',
  'php',
]);

/**
 * Whether a word runs the words after it as a command or a script: a shell or `eval`, a wrapper the
 * guard looks through (`env`, `nice`, `timeout`), or an interpreter whose script is not written out
 * before the expansion.
 */
function runsWhatFollows(word: string, rest: readonly string[]): boolean {
  if (word.startsWith('-') || word.includes('=')) return false;
  const name = baseName(word);
  if (REPARSERS.has(name)) return true;
  if (stripCommandPrefixes([word, 'x'], { lookThroughRunners: true })[0] !== name) return true;
  return INTERPRETERS.has(name) && !rest.some((w) => !w.startsWith('-'));
}

/**
 * Whether the words the shell expands after a hazard program at `at` can only be arguments to a
 * command that is no hazard: the literal words before the first expansion, from the hazard program
 * or from the line's start, can begin no hazard command in any plain reading (runners unwrapped, as
 * `firstUnread` compares them), no word before it reads its arguments as shell text again, and the
 * command a runner chain ends in does not run what follows it (`uv run env $x`, `uv run node $F`).
 */
function expandsOnlyArguments(line: readonly string[], at: number, known: Known): boolean {
  const first = line.findIndex((word, i) => i > at && EXPANDING.test(word));
  if (first < 0) return true;
  if (line.slice(0, at).some((word) => REPARSERS.has(baseName(word)))) return false;
  const literal = line.slice(at, first);
  // A JS package manager rewrites its words (`pnpm run x` is `pnpm x`); `argumentsOnly` reads it.
  if (line.slice(0, first).some((word) => JS_MANAGERS.has(baseName(word)))) return false;
  const starts = runCommandStarts(literal);
  for (const start of starts.length === 0 ? [1] : starts) {
    for (let i = Math.max(start, 1); i < literal.length; i += 1) {
      if (runsWhatFollows(literal[i] ?? '', literal.slice(i + 1))) return false;
    }
  }
  // An expansion may be several words, or a flag's value with more words after it.
  const unread = [UNREAD_WORD, UNREAD_WORD];
  const fromStart = line.slice(
    0,
    line.findIndex((word) => EXPANDING.test(word)),
  );
  return [
    [...literal, ...unread],
    [...fromStart, ...unread],
  ].every((words) =>
    plainWordReadings(words).every((reading) => {
      const bare = reading.map((plain, i) => (i === 0 ? baseName(plain.word) : plain.word));
      return !known.patterns.some((pattern) => mayStartWith(bare, pattern));
    }),
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
    !argumentsOnly(line.slice(at), known.commands) &&
    !expandsOnlyArguments(line, at, known)
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
  const commands = hazards.flatMap((hazard) => hazard.commands.map((c) => c.split(' ')));
  return unreadableIn(
    command,
    {
      programs: hazardPrograms(hazards),
      commands,
      patterns: hazardPatterns(commands.map((c) => c.filter((word) => word !== ''))),
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
function hazardPrograms(hazards: readonly HazardDef[]): Set<string> {
  return new Set(
    hazards.flatMap((hazard) => hazard.commands.map((c) => baseName(c.split(' ')[0] ?? ''))),
  );
}
