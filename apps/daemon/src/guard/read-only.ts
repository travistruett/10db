import { abbreviates, gitVerdict } from './git-rules';
import { plainCommandWords } from './plain-command';

/** Commands a read-only step may run: they read or print, and change nothing. */
export const READ_COMMANDS: ReadonlySet<string> = new Set([
  'basename',
  'cat',
  'cd',
  'diff',
  'dirname',
  'echo',
  'find',
  'grep',
  'head',
  'jq',
  'ls',
  'pwd',
  'realpath',
  'rg',
  'sort',
  'stat',
  'tail',
  'test',
  'tree',
  'true',
  'wc',
  'which',
]);

const READ_GIT: ReadonlySet<string> = new Set([
  'blame',
  'describe',
  'diff',
  'grep',
  'log',
  'ls-files',
  'rev-parse',
  'shortlog',
  'show',
  'status',
]);

/** Options that make an otherwise reading command delete, write a file or run a program. */
const WRITING_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  find: [
    '-delete',
    '-exec',
    '-execdir',
    '-ok',
    '-okdir',
    '-fprint',
    '-fprint0',
    '-fprintf',
    '-fls',
  ],
  sort: ['-o', '--output', '--compress-program'],
  tree: ['-o', '-R'],
  rg: ['--pre', '--pre-glob', '--hostname-bin'],
};

/**
 * Whether a read-only git call writes a file or runs a program. `--output` and `git grep -O` are
 * gitVerdict's to judge (it knows `-O` only means a pager for grep, so `git log -SOption` passes).
 * `--ext-diff` and `--textconv` are checked here; `--text` is a different option (treat as text) and
 * passes, while any other abbreviation of `--textconv` is refused.
 */
function gitRunsOrWrites(args: readonly string[]): boolean {
  if (gitVerdict(['git', ...args]) !== null) return true;
  return args.some(
    (a) =>
      abbreviates(a, '--ext-diff') ||
      (a.split('=')[0] !== '--text' && abbreviates(a, '--textconv')),
  );
}

/**
 * Whether an argument is the option. Long options match by unambiguous prefix (`--out=x`),
 * single letters match anywhere in a short bundle (`-ro`), other single-dash options match exactly.
 */
function usesOption(arg: string, option: string): boolean {
  if (option.startsWith('--')) return abbreviates(arg, option);
  if (option.length === 2) return new RegExp(`^-[^-]*${option.slice(1)}`).test(arg);
  return arg === option;
}

/**
 * Whether `ps` may print the environment of the processes it lists: `-E` in a dash bundle, or the
 * BSD form with no dash (`eww`, `Eww`, `aux e`), which ps takes as options. Any dashless word holding
 * an `e` or `E` counts, even one that is an option's value (`-o pid,etime`): reading the grammar
 * to tell them apart would be a guess, and the call then keeps today's judgement. Claude Code's own
 * process runs outside the sandbox, so what the sandbox returns for another process's environment
 * is not what the lane's Bash sees.
 */
function psShowsEnvironment(args: readonly string[]): boolean {
  return args.some((a) => (a.startsWith('-') ? /^-[^-]*E/.test(a) : /[eE]/.test(a)));
}

const REFUSAL =
  'This step is read-only: the shell accepts only plain words, simple quoting and read-only commands (read-only git, cat, grep, ls, find and similar), with no redirection other than 2>&1, >/dev/null and 2>/dev/null. Describe the change in mcp__10db__complete_step.';

/** What a lane may run besides `READ_COMMANDS` without a card: `ps` prints the process table. */
const LANE_EXTRA_COMMANDS: ReadonlySet<string> = new Set(['ps']);

/** The segments' words when every one is a read-only command, else null. */
function readOnlySegments(
  command: string,
  commands: ReadonlySet<string>,
  optionGlobs: boolean,
): string[][] | null {
  const segments = plainCommandWords(command, { optionGlobs });
  if (segments === null) return null;
  for (const [cmd = '', ...args] of segments) {
    // Only a bare command: no assignment, wrapper or path (those run something else).
    if (cmd.includes('/')) return null;
    if (cmd === 'git') {
      if (!READ_GIT.has(args[0] ?? '') || gitRunsOrWrites(args)) return null;
    } else if (!commands.has(cmd)) {
      return null;
    }
    if (cmd === 'ps' && psShowsEnvironment(args)) return null;
    const writing = WRITING_OPTIONS[cmd] ?? [];
    if (args.some((a) => writing.some((o) => usesOption(a, o)))) return null;
  }
  return segments;
}

/** Why a read-only step may not run this command, or null when every segment only reads. */
export function readOnlyShellRefusal(command: string): string | null {
  return readOnlySegments(command, READ_COMMANDS, false) === null ? REFUSAL : null;
}

/**
 * The words of each segment of a lane's command line when every part (across `;`, `&&`, `||` and
 * pipes) is a read-only command, judged as a read-only step's is, with `ps` added and a glob allowed
 * in an option's value (`--include=*.ts`). Null when anything else is in it: a redirection to a
 * file, a substitution, a variable, a background job, a writing option, another program.
 */
export function laneReadOnlyWords(command: string): string[][] | null {
  return readOnlySegments(command, new Set([...READ_COMMANDS, ...LANE_EXTRA_COMMANDS]), true);
}
