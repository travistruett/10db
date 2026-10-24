import { describe, expect, it } from 'vitest';
import { isCommandRunner } from './command-runners';

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
