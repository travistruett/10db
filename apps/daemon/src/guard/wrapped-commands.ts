import { commandName } from './shell-words';

/** Programs whose arguments come from their input, so the program behind them has its words unread. */
export const FEEDERS: ReadonlySet<string> = new Set(['xargs', 'parallel']);

/** Programs that take their arguments as data and never run one as a command. */
const DATA_ARGUMENTS: ReadonlySet<string> = new Set([
  'echo',
  'printf',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'cat',
  'ls',
  'head',
  'tail',
  'wc',
  'sed',
  'awk',
  'diff',
  'less',
  'more',
  'man',
  'which',
  'whereis',
  'tee',
  'touch',
  'mkdir',
  'cp',
  'mv',
  'rm',
  'stat',
  'file',
  'basename',
  'dirname',
  'sort',
  'uniq',
  'cut',
  'tr',
  'test',
  '[',
  '[[',
  'cd',
  'pwd',
  'read',
  'export',
  'true',
  'false',
  'git',
  'gh',
]);

/** Whether a program takes its arguments as data, so a hazard program named among them is only text. */
export function takesDataArguments(program: string): boolean {
  return DATA_ARGUMENTS.has(commandName(program));
}

/** How far into a command line every word is tried as a wrapped program. */
const MAX_TAILS = 16;
/** Past that, a word is tried when it names a program the guard or a hazard has rules for. */
const RULED_PROGRAMS: ReadonlySet<string> = new Set([
  'pnpm',
  'npm',
  'yarn',
  'bun',
  'npx',
  'cargo',
  'git',
  'gh',
  'drizzle-kit',
  'make',
  'vercel',
  'netlify',
  'fly',
  'kubectl',
  'terraform',
]);

/** `pnpm@9` names pnpm; a scoped package (`@10db/x`) and a plain word are left as they are. */
function withoutVersion(word: string): string {
  const at = word.indexOf('@', 1);
  return at > 0 && !word.includes('/') ? word.slice(0, at) : word;
}

/**
 * The command lines that start at a later word of a command: a wrapper the guard has no table for
 * (`xcrun pnpm add x`, `npm x -- pnpm add x`, `npx pnpm@9 add x`) runs what follows it. A program
 * that takes its arguments as data has none. A match of a hazard or a refusal against any of them
 * counts, so an unknown wrapper never hides the command it runs.
 */
export function executableTails(words: readonly string[]): string[][] {
  const [head = ''] = words;
  if (takesDataArguments(head)) return [];
  const tails: string[][] = [];
  for (let i = 1; i < words.length; i += 1) {
    const first = words[i] ?? '';
    if (first.startsWith('-')) continue;
    const program = withoutVersion(first);
    if (i >= MAX_TAILS && !RULED_PROGRAMS.has(commandName(program))) continue;
    tails.push([program, ...words.slice(i + 1)]);
  }
  return tails;
}
