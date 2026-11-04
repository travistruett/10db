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
 * Why a read-only git call is refused because it writes a file or runs a program, or null when it
 * does neither. `--output` and `git grep -O` are gitVerdict's to judge (it knows `-O` only means a
 * pager for grep, so `git log -SOption` passes). Only the `-O` message says how to rephrase; the
 * `--output` message says only what the option does. `--ext-diff` and `--textconv` are checked
 * here and their messages likewise say only what the option does; `--text` is a different option
 * (treat as text) and passes, while any other abbreviation of `--textconv` is refused.
 */
function gitRunsOrWritesReason(args: readonly string[]): string | null {
  const verdict = gitVerdict(['git', ...args]);
  if (verdict !== null) return verdict.deny;
  if (args.some((a) => abbreviates(a, '--ext-diff'))) {
    return 'git --ext-diff runs an external diff program and is not allowed.';
  }
  if (args.some((a) => a.split('=')[0] !== '--text' && abbreviates(a, '--textconv'))) {
    return 'git --textconv runs an external conversion program and is not allowed.';
  }
  return null;
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

/**
 * The segments' words when every one is a read-only command, else why not: `reason` is a specific
 * message when a read-only git call has an option that writes or runs a program, otherwise null
 * (the generic refusal applies).
 */
function readOnlyJudgement(
  command: string,
  commands: ReadonlySet<string>,
  optionGlobs: boolean,
): { readonly segments: string[][] } | { readonly reason: string | null } {
  const segments = plainCommandWords(command, { optionGlobs });
  if (segments === null) return { reason: null };
  for (const [cmd = '', ...args] of segments) {
    // Only a bare command: no assignment, wrapper or path (those run something else).
    if (cmd.includes('/')) return { reason: null };
    if (cmd === 'git') {
      if (!READ_GIT.has(args[0] ?? '')) return { reason: null };
      const reason = gitRunsOrWritesReason(args);
      if (reason !== null) return { reason };
    } else if (!commands.has(cmd)) {
      return { reason: null };
    }
    if (cmd === 'ps' && psShowsEnvironment(args)) return { reason: null };
    const writing = WRITING_OPTIONS[cmd] ?? [];
    if (args.some((a) => writing.some((o) => usesOption(a, o)))) return { reason: null };
  }
  return { segments };
}

/**
 * Why a read-only step may not run this command, or null when every segment only reads. A read-only
 * git call refused for an option says which option and what it does (`git grep -O` also says how to
 * rephrase; `--output`, `--ext-diff` and `--textconv` do not); any other refusal is the generic one.
 */
export function readOnlyShellRefusal(command: string): string | null {
  const judgement = readOnlyJudgement(command, READ_COMMANDS, false);
  if ('segments' in judgement) return null;
  return judgement.reason === null ? REFUSAL : `This step is read-only: ${judgement.reason}`;
}

/**
 * The words of each segment of a lane's command line when every part (across `;`, `&&`, `||` and
 * pipes) is a read-only command, judged as a read-only step's is, with `ps` added and a glob allowed
 * in an option's value (`--include=*.ts`). Null when anything else is in it: a redirection to a
 * file, a substitution, a variable, a background job, a writing option, another program.
 */
export function laneReadOnlyWords(command: string): string[][] | null {
  const judgement = readOnlyJudgement(
    command,
    new Set([...READ_COMMANDS, ...LANE_EXTRA_COMMANDS]),
    true,
  );
  return 'segments' in judgement ? judgement.segments : null;
}
