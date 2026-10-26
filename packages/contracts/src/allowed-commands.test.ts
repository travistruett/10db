import { describe, expect, it } from 'vitest';
import { AllowedCommand, AllowedCommands, allowedCommandProblem } from './allowed-commands';

describe('AllowedCommand', () => {
  it.each([
    ['a program and its subcommand', 'pnpm test'],
    ['a program run through pnpm exec', 'pnpm exec prettier'],
    ['a script name with a colon', 'pnpm build:docs'],
    ['a single program', 'make'],
    ['a path inside the program argument', 'pnpm exec scripts/check.sh'],
    ['a scoped package name', 'pnpm exec @10db/tool'],
    ['a package named after npx', 'npx prettier'],
    ['a package named after pnpm dlx', 'pnpm dlx create-vite'],
    ['a package named after npm x', 'npm x prettier'],
    ['a bin inside node_modules', 'pnpm exec node_modules/.bin/tsc'],
    ['a bun subcommand', 'bun test'],
    ['a yarn script', 'yarn test'],
    ['an npm script', 'npm run build'],
  ])('accepts %s (%s)', (_name, command) => {
    expect(AllowedCommand.safeParse(command).success).toBe(true);
  });

  it.each([
    ['an empty command', ''],
    ['a blank command', '   '],
    ['leading whitespace', ' pnpm test'],
    ['trailing whitespace', 'pnpm test '],
    ['a doubled space', 'pnpm  test'],
    ['a tab', 'pnpm\ttest'],
    ['a newline', 'pnpm\ntest'],
    ['a flag', 'pnpm --filter web test'],
    ['a flag after the prefix', 'pnpm test -- --run'],
    ['a single-character flag', 'node -e'],
    ['a quoted word', "pnpm 'test'"],
    ['a glob', 'pnpm test*'],
    ['a variable', 'pnpm test $SUITE'],
    ['a command substitution', 'pnpm $(echo test)'],
    ['a chained command', 'pnpm test&&rm'],
    ['a pipe', 'pnpm test|sh'],
    ['a redirection', 'pnpm test>out'],
    ['an assignment', 'FOO=bar pnpm test'],
    ['a path that climbs out', 'scripts/../../bin/tool'],
    ['a word starting with a dot', '.hidden'],
    ['a word starting with a dash', '-x'],
    ['a program given by path', 'scripts/check.sh'],
    ['a program given by absolute path', '/usr/bin/make'],
    ['a shell as the program', 'sh'],
    ['a shell with its own flag', 'bash -c'],
    ['a wrapper that runs its arguments', 'env'],
    ['a sudo prefix', 'sudo make'],
    ['a runner as the whole prefix', 'npx'],
    ['a package runner with no package', 'pnpm exec'],
    ['a dlx with no package', 'pnpm dlx'],
    ['an x runner with no package', 'npm x'],
    ['a package manager alone', 'pnpm'],
    ['a bare npx', 'npx'],
    ['a shell run by pnpm exec', 'pnpm exec bash'],
    ['a shell run by pnpm dlx', 'pnpm dlx sh'],
    ['a shell run by npm x', 'npm x zsh'],
    ['a shell run by npx', 'npx bash'],
    ['a shell given by a relative path through pnpm exec', 'pnpm exec bin/sh'],
    ['a shell given by an absolute path', 'pnpm exec /bin/sh'],
    ['a shell in capitals', 'pnpm exec BASH'],
    ['a package manager run by pnpm exec', 'pnpm exec pnpm'],
    ['a package runner run by npx', 'npx npx'],
    ['a wrapper run by pnpm exec', 'pnpm exec env'],
    ['an interpreter', 'node'],
    ['an interpreter in capitals', 'NODE'],
    ['a python', 'python3'],
    ['a python with a minor version', 'python3.12'],
    ['a perl', 'perl'],
    ['a ruby', 'ruby'],
    ['a deno', 'deno'],
    ['an interpreter run by pnpm exec', 'pnpm exec node'],
    ['an interpreter run by npx', 'npx python3'],
    ['an applescript runner', 'osascript'],
    ['yarn workspace, which forwards what follows', 'yarn workspace'],
    ['yarn workspace with a name', 'yarn workspace web'],
    ['yarn workspace running a shell', 'yarn workspace web exec bash'],
    ['yarn workspace running a test script', 'yarn workspace web test'],
    ['yarn workspaces, which forwards what follows', 'yarn workspaces'],
    ['yarn workspaces foreach', 'yarn workspaces foreach'],
    ['pnpm recursive, which forwards what follows', 'pnpm recursive'],
    ['pnpm recursive exec', 'pnpm recursive exec'],
    ['yarn node, which runs node with what follows', 'yarn node'],
    ['npm init alone, which runs any package it is given', 'npm init'],
    ['npm init with a package', 'npm init create-app'],
    ['npm create alone, which runs any package it is given', 'npm create'],
    ['npm create with a package', 'npm create vite'],
    ['pnpm create alone', 'pnpm create'],
    ['pnpm create with a package', 'pnpm create vite'],
    ['yarn create alone', 'yarn create'],
    ['yarn create with a package', 'yarn create vite'],
    ['pnpm multi, an alias of pnpm recursive', 'pnpm multi'],
    ['pnpm multi running a shell', 'pnpm multi exec bash'],
    ['pnpm m, a short alias of pnpm recursive', 'pnpm m'],
    ['pnpm m running a shell', 'pnpm m exec bash'],
    ['npm innit alone, an alias of npm init', 'npm innit'],
    ['npm innit with a package', 'npm innit create-app'],
    ['bun create alone', 'bun create'],
    ['bun create with a template', 'bun create vite'],
    ['bun c, a short alias of bun create', 'bun c'],
    ['bun c with a template', 'bun c vite'],
    ['a forwarding form in capitals', 'PNPM RECURSIVE'],
  ])('rejects %s (%s)', (_name, command) => {
    expect(AllowedCommand.safeParse(command).success).toBe(false);
  });

  it('names the problem in its message', () => {
    const result = AllowedCommand.safeParse('pnpm exec');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('exec');
  });

  it('gives no problem for a plain prefix', () => {
    expect(allowedCommandProblem('pnpm test')).toBeNull();
  });
});

describe('AllowedCommands', () => {
  it('accepts a list of distinct prefixes, including none', () => {
    expect(AllowedCommands.parse([])).toEqual([]);
    expect(AllowedCommands.parse(['pnpm test', 'pnpm exec prettier'])).toEqual([
      'pnpm test',
      'pnpm exec prettier',
    ]);
  });

  it('rejects the same prefix twice', () => {
    expect(AllowedCommands.safeParse(['pnpm test', 'pnpm test']).success).toBe(false);
  });

  it('rejects a list longer than the cap', () => {
    const many = Array.from({ length: 33 }, (_, i) => `tool${String(i)}`);
    expect(AllowedCommands.safeParse(many).success).toBe(false);
    expect(AllowedCommands.safeParse(many.slice(0, 32)).success).toBe(true);
  });

  it('rejects a list with one invalid prefix', () => {
    expect(AllowedCommands.safeParse(['pnpm test', 'pnpm --run']).success).toBe(false);
  });
});
