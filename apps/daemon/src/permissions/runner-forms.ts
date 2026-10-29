import {
  isCommandRunner,
  isPackageTool,
  packageToolForwards,
  packageToolProgramIndex,
} from '@10db/contracts';
import { plainWordReadings, stripCommandPrefixes } from '../guard';

/** Bun runs the file it names as well as a package, so every bun command keeps its whole words. */
const FILE_RUNNERS: ReadonlySet<string> = new Set(['bun']);

/**
 * Whether the words run another program, so "always allow" keeps them whole. The package-tool forms come
 * from @10db/contracts, the same list allowed-commands reads: a program a package tool runs, and a
 * forwarding subcommand or package creator that runs what follows it. Names are compared without case:
 * a case-insensitive file system runs `PNPM` as `pnpm`. A program named by its path is judged by its
 * last part, so `/usr/local/bin/pnpm exec` is still a runner.
 */
export function runsOtherCommands(raw: readonly string[]): boolean {
  const words = stripCommandPrefixes(raw);
  const [first = ''] = words;
  const name = first.toLowerCase();
  return (
    isCommandRunner(name) ||
    FILE_RUNNERS.has(name) ||
    packageToolProgramIndex(words) !== null ||
    packageToolForwards(words)
  );
}

/** Whether a bare program runs the command or code it is given, or is a package tool. */
function runsAnything(program: string): boolean {
  return isCommandRunner(program) || isPackageTool(program);
}

/**
 * Whether the words run a program, or fetch a package, that they do not name: a bare runner or package
 * tool, one followed only by flags, a program subcommand (`exec`, `dlx`, `x`) with no program after it, or
 * a forwarding subcommand or package creator with nothing after it. A rule stored for such words would
 * cover every program the call could name, so they can only be allowed once. Flags are skipped the way the
 * guard skips them, so `pnpm -r exec` reads as `pnpm exec`. A program the words do name is judged the same
 * way when it is a runner or package tool: `pnpm exec bash` still needs the code that bash runs.
 */
export function runsUnnamedProgram(raw: readonly string[]): boolean {
  return runsUnnamed(raw, { budget: READING_BUDGET, memo: new Map() });
}

/** The most commands one call explores across every reading and every nested runner. */
const READING_BUDGET = 256;

interface Search {
  /** Commands left to explore; when it runs out the answer is "unnamed", so no rule is stored. */
  budget: number;
  /** The answer for each command already explored, by its words. */
  readonly memo: Map<string, boolean>;
}

function runsUnnamed(raw: readonly string[], search: Search): boolean {
  const words = stripCommandPrefixes(raw);
  const key = words.join('\0');
  const known = search.memo.get(key);
  if (known !== undefined) return known;
  search.budget -= 1;
  // Out of budget: fail closed.
  if (search.budget < 0) return true;
  // A flag the guard cannot place may or may not take the next word, so any reading may be unnamed.
  const answer = plainWordReadings(words).some((plain) => runsUnnamedIn(words, plain, search));
  search.memo.set(key, answer);
  return answer;
}

function runsUnnamedIn(
  words: readonly string[],
  plain: ReturnType<typeof plainWordReadings>[number],
  search: Search,
): boolean {
  const bare = plain.map((p) => p.word);
  const [head] = bare;
  if (head === undefined) return true;
  if (bare.length === 1) return runsAnything(head);
  const second = (bare[1] ?? '').toLowerCase();
  const third = (bare[2] ?? '').toLowerCase();
  if (packageToolForwards(bare)) {
    // `yarn workspace <name>` and `yarn workspaces foreach` put one more word before the command they forward.
    const lead = second === 'workspace' || (second === 'workspaces' && third === 'foreach') ? 3 : 2;
    const forwarded = plain[lead];
    return forwarded === undefined || runsUnnamed([head, ...words.slice(forwarded.at)], search);
  }
  // The position of the program these words run: a runner's first word, or the one a package tool names.
  const named =
    packageToolProgramIndex(bare) ??
    (isCommandRunner(head) || FILE_RUNNERS.has(head.toLowerCase()) ? 1 : null);
  if (named === null) return false;
  const program = plain[named];
  return program === undefined || runsUnnamed(words.slice(program.at), search);
}
