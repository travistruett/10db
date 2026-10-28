import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { shellQuote, trustCard, worktreeRemovalCommand } from './trust-card';
import { GitTrustError } from './trust-error';

const NASTY = [
  ['a quote', "it's"],
  ['a command substitution', '$(touch /tmp/10db-pwned)'],
  ['a backtick substitution', '`touch /tmp/10db-pwned`'],
  ['a newline', 'first\nsecond'],
  ['a semicolon and spaces', 'a; rm -rf ~'],
];

describe('shellQuote', () => {
  it.each(NASTY)('round-trips %s through /bin/sh unchanged', (_name, value) => {
    const out = execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });
    expect(out).toBe(value);
  });
});

const configCard = (key: string, file: string) =>
  trustCard(new GitTrustError('/repo', { kind: 'config', keys: [{ key, file }] }));

describe('the config card', () => {
  it('suggests a command, quoted, for an ordinary key and file', () => {
    const { body } = configCard('core.sshcommand', '/repo/.git/config');
    expect(body).toContain("git config --file '/repo/.git/config' --unset-all 'core.sshcommand'");
  });

  it.each(
    NASTY.flatMap(([name, value]) => [
      {
        name: `a key with ${String(name)}`,
        key: `alias.${String(value)}`,
        file: '/repo/.git/config',
      },
      {
        name: `a file with ${String(name)}`,
        key: 'core.sshcommand',
        file: `/repo/${String(value)}`,
      },
    ]),
  )('suggests no command to paste for $name, and shows it only escaped', ({ key, file }) => {
    const { body } = configCard(key, file);
    expect(body).not.toContain('git config --file');
    expect(body).not.toContain('\n- `alias.first\nsecond');
    for (const line of body.split('\n'))
      if (line.startsWith('- ')) expect(line).toMatch(/^- `.*` in `.*`$/);
  });
});

describe('the writable card', () => {
  it('folds only cards about the same git dir', () => {
    const card = (gitDir: string) =>
      trustCard(new GitTrustError('/repo', { kind: 'writable', gitDir })).foldKey;
    expect(card('/repo/vendor/git')).toBe(card('/repo/vendor/git'));
    expect(card('/repo/vendor/git')).not.toBe(card('/tmp/lane/git'));
  });
});

describe('the unpinned card', () => {
  const card = (repo: string) => trustCard(new GitTrustError(repo, { kind: 'unpinned' }));

  it('offers no Trust and says how to remove the worktree', () => {
    const { body, candidate } = card('/root/ab/bat_1');
    expect(candidate).toBeNull();
    expect(body).toContain(
      "git -C '/root/ab/bat_1' worktree remove --force --force '/root/ab/bat_1'",
    );
  });

  it.each([
    ['a backtick', '/root/a`touch x`'],
    ['a newline', '/root/a\nb'],
    ['a space', '/root/a b'],
  ])('puts no command to paste in the card for a path with %s', (_name, path) => {
    const { body } = card(path);
    expect(body).not.toContain("git -C '");
    expect(body).toContain('git worktree remove --force --force run in ');
  });

  it('folds one card per path', () => {
    expect(card('/root/a').foldKey).toBe(card('/root/a').foldKey);
    expect(card('/root/a').foldKey).not.toBe(card('/root/b').foldKey);
  });
});

describe('worktreeRemovalCommand', () => {
  it.each([
    {
      name: 'both paths plain: a command that runs from anywhere',
      checkout: '/repo',
      path: '/root/ab/bat_1',
      shown: "git -C '/repo' worktree remove --force --force '/root/ab/bat_1'",
    },
    {
      name: 'a checkout with a space: typed, each path a code span',
      checkout: '/my repo',
      path: '/root/ab/bat_1',
      shown: 'git worktree remove --force --force run in `/my repo`, naming `/root/ab/bat_1`',
    },
    {
      name: 'a path with a backtick: typed, each path a code span',
      checkout: '/repo',
      path: '/root/a`x`',
      shown: 'git worktree remove --force --force run in `/repo`, naming `` /root/a`x` ``',
    },
  ])('$name', ({ checkout, path, shown }) => {
    expect(worktreeRemovalCommand(checkout, path)).toBe(shown);
  });
});
