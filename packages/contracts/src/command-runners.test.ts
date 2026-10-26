import { describe, expect, it } from 'vitest';
import {
  isCommandRunner,
  isPackageTool,
  packageToolForwards,
  packageToolProgramIndex,
} from './command-runners';

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

describe('packageToolForwards', () => {
  it.each<[string, string[], boolean]>([
    ['yarn workspace, which runs a command in a workspace', ['yarn', 'workspace'], true],
    ['yarn workspace with a command after it', ['yarn', 'workspace', 'web', 'exec', 'bash'], true],
    ['yarn workspaces, which runs a command in each workspace', ['yarn', 'workspaces'], true],
    ['yarn workspaces foreach', ['yarn', 'workspaces', 'foreach', 'run'], true],
    ['pnpm recursive exec', ['pnpm', 'recursive', 'exec', 'bash'], true],
    ['yarn node, which runs node with the rest of the line', ['yarn', 'node', '-e', 'x'], true],
    ['npm init with a package', ['npm', 'init', 'foo'], true],
    ['npm init alone, which runs any package given to it', ['npm', 'init'], true],
    ['npm create with a package', ['npm', 'create', 'vite'], true],
    ['pnpm create with a package', ['pnpm', 'create', 'vite'], true],
    ['yarn create with a package', ['yarn', 'create', 'vite'], true],
    ['capitalised tool and subcommand', ['PNPM', 'RECURSIVE', 'exec'], true],
    ['yarn init, which fetches no package', ['yarn', 'init'], false],
    ['pnpm init, which fetches no package', ['pnpm', 'init'], false],
    ['a package manager running a script', ['npm', 'run', 'build'], false],
    ['yarn running a script', ['yarn', 'test'], false],
    ['a workspace subcommand of another tool', ['make', 'workspace', 'web'], false],
    ['a recursive subcommand of npm', ['npm', 'recursive'], false],
    ['no words', [], false],
  ])('%s: %j -> %j', (_name, words, forwards) => {
    expect(packageToolForwards(words)).toBe(forwards);
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
