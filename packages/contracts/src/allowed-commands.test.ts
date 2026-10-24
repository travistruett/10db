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
