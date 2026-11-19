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
] as const;

describe('shellQuote', () => {
  it('round-trips every shell character through /bin/sh unchanged', () => {
    for (const [name, value] of NASTY) {
      const out = execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin' },
      });
      expect.soft(out, name).toBe(value);
    }
  });
});

const configCard = (key: string, file: string) =>
  trustCard(new GitTrustError('/repo', { kind: 'config', keys: [{ key, file }] }));

describe('the config card', () => {
  it('suggests a quoted command for an ordinary key and file, and none to paste for a key or file with a shell character, showing it only escaped', () => {
    expect(configCard('core.sshcommand', '/repo/.git/config').body).toContain(
      "git config --file '/repo/.git/config' --unset-all 'core.sshcommand'",
    );
    const rows = NASTY.flatMap(([name, value]) => [
      { name: `a key with ${name}`, key: `alias.${value}`, file: '/repo/.git/config' },
      { name: `a file with ${name}`, key: 'core.sshcommand', file: `/repo/${value}` },
    ]);
    for (const { name, key, file } of rows) {
      const { body } = configCard(key, file);
      expect.soft(body, name).not.toContain('git config --file');
      expect.soft(body, name).not.toContain('\n- `alias.first\nsecond');
      for (const line of body.split('\n'))
        if (line.startsWith('- ')) expect.soft(line, name).toMatch(/^- `.*` in `.*`$/);
    }
  });
});

describe('the writable and unpinned cards', () => {
  const unpinned = (repo: string) => trustCard(new GitTrustError(repo, { kind: 'unpinned' }));

  it('folds only cards about the same git dir or worktree path', () => {
    const writable = (gitDir: string) =>
      trustCard(new GitTrustError('/repo', { kind: 'writable', gitDir })).foldKey;
    expect(writable('/repo/vendor/git')).toBe(writable('/repo/vendor/git'));
    expect(writable('/repo/vendor/git')).not.toBe(writable('/tmp/lane/git'));
    expect(unpinned('/root/a').foldKey).toBe(unpinned('/root/a').foldKey);
    expect(unpinned('/root/a').foldKey).not.toBe(unpinned('/root/b').foldKey);
  });

  it('offers no Trust for an unpinned worktree and says how to remove it, with no command to paste for a path with a shell character', () => {
    const { body, candidate } = unpinned('/root/ab/bat_1');
    expect(candidate).toBeNull();
    expect(body).toContain(
      "git -C '/root/ab/bat_1' worktree remove --force --force '/root/ab/bat_1'",
    );
    for (const [name, path] of [
      ['a backtick', '/root/a`touch x`'],
      ['a newline', '/root/a\nb'],
      ['a space', '/root/a b'],
    ] as const) {
      const card = unpinned(path).body;
      expect.soft(card, name).not.toContain("git -C '");
      expect.soft(card, name).toContain('git worktree remove --force --force run in ');
    }
  });
});

describe('worktreeRemovalCommand', () => {
  it('gives a command that runs from anywhere only when both paths are plain, else typed words with each path a code span', () => {
    const ROWS = [
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
    ];
    for (const { name, checkout, path, shown } of ROWS)
      expect.soft(worktreeRemovalCommand(checkout, path), name).toBe(shown);
  });
});
