import { z } from 'zod';

/** The most command prefixes one project may allow. */
export const MAX_ALLOWED_COMMANDS = 32;

/**
 * A word is letters, digits and a few punctuation marks. A flag, quote, glob, variable or operator is
 * not: a flag can carry a command of its own, so a prefix never names one.
 */
const PLAIN_WORD = /^[A-Za-z0-9@][A-Za-z0-9._/@:+-]*$/;
/** Programs that run the commands they are given, so a prefix naming one allows whatever follows it. */
const RUNNER_PROGRAMS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'env',
  'xargs',
  'sudo',
  'eval',
  'exec',
  'command',
  'nohup',
  'time',
  'timeout',
  'nice',
]);
/** Package managers run any script or package they are named with, so one word alone allows them all. */
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** Tools that fetch and run a package by name; alone, they allow every package. */
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(['npx', 'bunx', 'pnpx', 'dlx']);
/** Subcommands that run the program named after them: `pnpm exec prettier` names one, `pnpm exec` names none. */
const PROGRAM_RUNNERS: ReadonlySet<string> = new Set(['exec', 'dlx', 'x']);

/**
 * Why a command prefix can't be allowed, or null when it can. A prefix is one to a few plain words, and
 * its program is a name on PATH, because the guard reads a path-qualified program by its last part.
 */
export function allowedCommandProblem(command: string): string | null {
  if (command.trim() === '') return 'Enter a command prefix such as pnpm test';
  const words = command.split(' ');
  if (!words.every((word) => PLAIN_WORD.test(word)))
    return 'Use plain words separated by single spaces: no flags, quotes, globs, variables or shell operators';
  if (words.some((word) => word.split('/').includes('..')))
    return 'A path in a prefix may not climb out with ..';
  const [program = '', subcommand = ''] = words;
  if (program.includes('/'))
    return `${program} is a path; name the program by its name on PATH, such as make`;
  if (RUNNER_PROGRAMS.has(program))
    return `${program} runs the commands it is given, so it can't be allowed as a prefix`;
  if (words.length === 1 && (PACKAGE_MANAGERS.has(program) || PACKAGE_RUNNERS.has(program)))
    return `${program} alone allows every script or package; name what it runs, such as ${program} test`;
  if (words.length === 2 && PACKAGE_MANAGERS.has(program) && PROGRAM_RUNNERS.has(subcommand))
    return `${program} ${subcommand} runs any program it is given; name the program, such as ${program} ${subcommand} prettier`;
  return null;
}

/** One command prefix a project allows without a permission card, such as `pnpm test`. */
export const AllowedCommand = z.string().superRefine((command, ctx) => {
  const problem = allowedCommandProblem(command);
  if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
});
export type AllowedCommand = z.infer<typeof AllowedCommand>;

export const AllowedCommands = z
  .array(AllowedCommand)
  .max(MAX_ALLOWED_COMMANDS, `Allow at most ${String(MAX_ALLOWED_COMMANDS)} commands`)
  .superRefine((commands, ctx) => {
    if (new Set(commands).size !== commands.length)
      ctx.addIssue({ code: 'custom', message: 'List each command once' });
  });
export type AllowedCommands = z.infer<typeof AllowedCommands>;
