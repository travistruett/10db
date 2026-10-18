import { abbreviates } from './git-rules';
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
 * Whether an argument is the option. Long options match by unambiguous prefix (`--out=x`),
 * single letters match anywhere in a short bundle (`-ro`), other single-dash options match exactly.
 */
function usesOption(arg: string, option: string): boolean {
  if (option.startsWith('--')) return abbreviates(arg, option);
  if (option.length === 2) return new RegExp(`^-[^-]*${option.slice(1)}`).test(arg);
  return arg === option;
}

const REFUSAL =
  'This step is read-only: the shell accepts only plain words, simple quoting and read-only commands (read-only git, cat, grep, ls, find and similar), with no redirection other than 2>&1, >/dev/null and 2>/dev/null. Describe the change in mcp__10db__complete_step.';

/** Why a read-only step may not run this command, or null when every segment only reads. */
export function readOnlyShellRefusal(command: string): string | null {
  const segments = plainCommandWords(command);
  if (segments === null) return REFUSAL;
  for (const [cmd = '', ...args] of segments) {
    // Only a bare command: no assignment, wrapper or path (those run something else).
    if (cmd.includes('/')) return REFUSAL;
    if (cmd === 'git') {
      if (!READ_GIT.has(args[0] ?? '')) return REFUSAL;
      continue;
    }
    if (!READ_COMMANDS.has(cmd)) return REFUSAL;
    const writing = WRITING_OPTIONS[cmd] ?? [];
    if (args.some((a) => writing.some((o) => usesOption(a, o)))) return REFUSAL;
  }
  return null;
}
