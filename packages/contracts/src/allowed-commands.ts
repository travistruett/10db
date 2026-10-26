import { z } from 'zod';
import {
  isCommandRunner,
  isPackageTool,
  packageToolForwards,
  packageToolProgramIndex,
} from './command-runners';

/** The most command prefixes one project may allow. */
export const MAX_ALLOWED_COMMANDS = 32;

/**
 * A word is letters, digits and a few punctuation marks. A flag, quote, glob, variable or operator is
 * not: a flag can carry a command of its own, so a prefix never names one.
 */
const PLAIN_WORD = /^[A-Za-z0-9@][A-Za-z0-9._/@:+-]*$/;

/**
 * Whether a program a prefix names runs whatever it is given, so allowing the prefix allows anything: a
 * runner, or a package tool that runs another package. The guard reads a path-qualified program by its
 * last part, so this reads one the same way.
 */
function runsAnything(program: string): boolean {
  const name = program.slice(program.lastIndexOf('/') + 1);
  return isCommandRunner(name) || isPackageTool(name);
}

/**
 * Why a command prefix can't be allowed, or null when it can. A prefix is one to a few plain words, and
 * its program is a name on PATH, because the guard reads a path-qualified program by its last part. A
 * prefix may not name a program that runs what it is given: one alone, or one that a package tool runs
 * through `exec`, `dlx` or `x`, or through `npx`, `bunx` or `pnpx`. Nor may it name a package tool's
 * forwarding subcommand or package creator (`yarn workspace`, `pnpm recursive`, `yarn node`, `npm init`,
 * `npm create`), which runs whatever follows it.
 */
export function allowedCommandProblem(command: string): string | null {
  if (command.trim() === '') return 'Enter a command prefix such as pnpm test';
  const words = command.split(' ');
  if (!words.every((word) => PLAIN_WORD.test(word)))
    return 'Use plain words separated by single spaces: no flags, quotes, globs, variables or shell operators';
  if (words.some((word) => word.split('/').includes('..')))
    return 'A path in a prefix may not climb out with ..';
  const [program = ''] = words;
  if (program.includes('/'))
    return `${program} is a path; name the program by its name on PATH, such as make`;
  const name = program.toLowerCase();
  if (isCommandRunner(name))
    return `${program} runs the commands or code it is given, so it can't be allowed as a prefix`;
  if (words.length === 1 && isPackageTool(name))
    return `${program} alone allows every script or package; name what it runs, such as ${program} test`;
  if (packageToolForwards(words))
    return `${words.slice(0, 2).join(' ')} runs a command or package it is given, so it can't be allowed as a prefix`;
  const at = packageToolProgramIndex(words);
  if (at === null) return null;
  const through = words.slice(0, at).join(' ');
  const named = words[at];
  if (named === undefined)
    return `${through} runs any program it is given; name the program, such as ${through} prettier`;
  if (runsAnything(named))
    return `${named} runs the commands or code it is given, so ${through} ${named} can't be allowed`;
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
