import { describe, expect, it } from 'vitest';
import { isCommandRunner, isPackageTool, packageToolProgramIndex } from './command-runners';

describe('isCommandRunner', () => {
  it.each([
    ['a POSIX shell', 'sh'],
    ['bash', 'bash'],
    ['zsh', 'zsh'],
    ['a shell in capitals', 'BASH'],
    ['node', 'node'],
    ['nodejs', 'nodejs'],
    ['deno', 'deno'],
    ['ruby', 'ruby'],
    ['perl', 'perl'],
    ['php', 'php'],
    ['awk', 'awk'],
    ['python', 'python'],
    ['python3', 'python3'],
    ['a python with a minor version', 'python3.12'],
    ['pypy with its version', 'pypy3'],
    ['env, which runs its arguments', 'env'],
    ['sudo', 'sudo'],
    ['eval', 'eval'],
  ])('names %s (%s) as a runner', (_name, program) => {
    expect(isCommandRunner(program)).toBe(true);
  });

  it.each([
    ['a package manager', 'pnpm'],
    ['a package runner', 'npx'],
    ['a build tool', 'make'],
    ['a version control tool', 'git'],
    ['a file lister', 'ls'],
    ['a tool whose name starts with a runner', 'nodemon'],
    ['a name that starts like python', 'pythonic'],
  ])('does not name %s (%s) as a runner', (_name, program) => {
    expect(isCommandRunner(program)).toBe(false);
  });
});

describe('isPackageTool', () => {
  it.each([
    ['a package manager', 'pnpm'],
    ['a package manager in capitals', 'NPM'],
    ['bun, a package manager and a file runner', 'bun'],
    ['a package runner', 'npx'],
    ['a package runner for bun', 'bunx'],
    ['a package runner for pnpm', 'pnpx'],
    ['dlx, which fetches and runs a package by name', 'dlx'],
  ])('names %s (%s) as a package tool', (_name, program) => {
    expect(isPackageTool(program)).toBe(true);
  });

  it.each([
    ['a shell', 'sh'],
    ['a build tool', 'make'],
    ['a version control tool', 'git'],
    ['a tool whose name starts with a package manager', 'pnpmx'],
    ['a tool whose name starts with a package runner', 'npxx'],
  ])('does not name %s (%s) as a package tool', (_name, program) => {
    expect(isPackageTool(program)).toBe(false);
  });
});

describe('packageToolProgramIndex', () => {
  it.each<[string, string[], number | null]>([
    ['pnpm exec names its program third', ['pnpm', 'exec', 'bash'], 2],
    ['pnpm dlx names its program third', ['pnpm', 'dlx', 'sh'], 2],
    ['npm x names its program third', ['npm', 'x', 'zsh'], 2],
    ['yarn exec names its program third', ['yarn', 'exec', 'bash'], 2],
    ['yarn dlx names its program third', ['yarn', 'dlx', 'sh'], 2],
    ['bun x names its program third', ['bun', 'x', 'zsh'], 2],
    ['capitalised package manager and subcommand', ['PNPM', 'DLX', 'sh'], 2],
    ['npx names its program second', ['npx', 'prettier'], 1],
    ['dlx names its program second', ['dlx', 'sh'], 1],
    ['bunx names its program second', ['bunx', 'zsh'], 1],
    ['pnpx names its program second', ['pnpx', 'sh'], 1],
    ['a package manager running a script', ['pnpm', 'test'], null],
    ['a package manager with no subcommand', ['pnpm'], null],
    ['a program that is not a package tool', ['make', 'exec', 'x'], null],
    ['no words', [], null],
    ['a package runner with no program after it', ['npx'], 1],
    ['a package manager subcommand with no program after it', ['pnpm', 'exec'], 2],
  ])('%s: %j -> %j', (_name, words, index) => {
    expect(packageToolProgramIndex(words)).toBe(index);
  });
});
