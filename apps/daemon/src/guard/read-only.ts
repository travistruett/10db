import { splitCommand, stripCommandPrefixes } from './shell-words';

/** Commands a read-only step may run: they read or print, and change nothing. */
export const READ_COMMANDS: ReadonlySet<string> = new Set([
  'basename',
  'cat',
  'diff',
  'dirname',
  'echo',
  'file',
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
  sort: ['-o', '--output'],
  tree: ['-o'],
  rg: ['--pre', '--pre-glob'],
};

/** `--output=x` and `-ox` are the option too, not only `--output x`. */
function usesOption(arg: string, option: string): boolean {
  if (arg === option || arg.startsWith(`${option}=`)) return true;
  return !option.startsWith('--') && option.length === 2 && arg.startsWith(option);
}

/** Redirections that only discard or merge output. */
const HARMLESS_REDIRECTS = /(?:\d?>\s*\/dev\/null|2>&1)/g;

const REFUSAL =
  'This step is read-only: the shell may only read (read-only git, cat, grep, ls, find and similar, no redirection). Describe the change in mcp__10db__complete_step.';

/** Why a read-only step may not run this command, or null when every segment only reads. */
export function readOnlyShellRefusal(command: string): string | null {
  for (const segment of splitCommand(command)) {
    const words = stripCommandPrefixes(segment.words);
    const [cmd = '', ...args] = words;
    if (cmd === '') continue;
    if (segment.raw.replace(HARMLESS_REDIRECTS, '').includes('>')) return REFUSAL;
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
