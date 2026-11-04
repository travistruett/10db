import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ClaimKind, DEFAULT_HAZARDS } from '@10db/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { judgePreToolUse, protectedPaths, type FileAccessJudge } from './index';
import { laneReadOnlyWords, readOnlyShellRefusal } from './read-only';

const TASKS = '/private/tmp/10db-abc123/claude-501/-Users-x-worktrees-lane/9f2e/tasks';
const GREP = `grep -rnE 'pattern|other' apps/daemon/src --include=*.ts | grep -v '\\.test\\.' | head -150`;

const GROUPED = String.raw`find apps/desktop/node_modules/.pnpm/ node_modules/.pnpm -maxdepth 1 \( -name "@tanstack+router-core*" -o -name "@tanstack+history*" \)`;
const NOT_GROUPED = String.raw`find . -maxdepth 2 ! -name '*.ts' -a \( -not -name x -or -name y -and -type f \)`;

describe('find with grouped tests', () => {
  it.each<[string, string]>([
    ['escaped parentheses', GROUPED],
    ['quoted parentheses', `find . -maxdepth 1 '(' -name "a*" -o -name b ')'`],
    ['!, -a, -not, -or and -and', NOT_GROUPED],
  ])('%s read only, for a lane and a read-only step', (_name, command) => {
    expect(laneReadOnlyWords(command)).not.toBeNull();
    expect(readOnlyShellRefusal(command)).toBeNull();
  });

  it.each<[string, string]>([
    ['-exec', String.raw`find . \( -name a -o -name b \) -exec rm '{}' ';'`],
    ['-execdir', String.raw`find . \( -name a \) -execdir rm '{}' ';'`],
    ['-ok', String.raw`find . \( -name a \) -ok rm '{}' ';'`],
    ['-okdir', String.raw`find . \( -name a \) -okdir rm '{}' ';'`],
    ['-delete', String.raw`find . \( -name a -o -name b \) -delete`],
    ['-fprint', String.raw`find . \( -name a \) -fprint out.txt`],
    ['-fprint0', String.raw`find . \( -name a \) -fprint0 out.txt`],
    ['-fprintf', String.raw`find . \( -name a \) -fprintf out.txt x`],
    ['-fls', String.raw`find . \( -name a \) -fls out.txt`],
    ['-exec after !', String.raw`find . ! -name a -exec rm '{}' ';'`],
  ])('with %s does not', (_name, command) => {
    expect(laneReadOnlyWords(command)).toBeNull();
    expect(readOnlyShellRefusal(command)).not.toBeNull();
  });
});

describe('laneReadOnlyWords', () => {
  it.each<[string, string]>([
    ['a listing and a process count', `ls -la ${TASKS}; ps aux | grep -c "[v]itest"`],
    ['a recursive search with an include glob, piped through filters', GREP],
    ['commands joined by && and ||', 'ls apps && cat a.ts || echo none'],
    ['read-only git', 'git log --oneline -5 | head -3'],
    ['output merged or discarded', 'grep -rn x apps 2>/dev/null | wc -l'],
  ])('%s reads only', (_name, command) => {
    expect(laneReadOnlyWords(command)).not.toBeNull();
  });

  it.each<[string, string]>([
    ['an output redirection to a file', 'grep x a | head -5 > out.txt'],
    ['an append', 'echo x >> out.txt'],
    ['find -delete', 'find . -delete'],
    ['find -exec', 'find . -name x -exec rm {} ;'],
    ['a command substitution', 'ls $(rm -rf x)'],
    ['a backtick substitution', 'ls `rm -rf x`'],
    ['a write after a read', 'cat a; rm b'],
    ['a write in a pipe', 'cat a | tee b'],
    ['sort -o', 'sort -o out.txt in.txt'],
    ['git diff --output', 'git diff --output=out.patch'],
    ['git diff with an external program', 'git diff --ext-diff'],
    ['git grep opening a pager program', 'git grep -O less x'],
    ['a write git subcommand', 'git checkout -- a.ts'],
    ['a variable', 'ls $HOME'],
    ['a background job', 'ls &'],
    ['a glob in a path word, which the shell fills in', 'cat .e*'],
    ['a command named by a path', '/bin/ls'],
    ['a program that is not read-only', 'pnpm exec eslint a.ts'],
    ['a newline', 'ls\nrm b'],
    ['a subshell', '(rm b)'],
  ])('%s does not', (_name, command) => {
    expect(laneReadOnlyWords(command)).toBeNull();
  });

  it.each<[string, string]>([
    ['git log -S with a value starting with O', 'git log -SOption -- a.ts'],
    ['git log -G with a value starting with O', 'git log -GOAuth'],
    ['git diff --text', 'git diff --text'],
    ['git grep --text', 'git grep --text x'],
    ['git diff -a', 'git diff -a'],
  ])('%s reads only, for a lane and a read-only step', (_name, command) => {
    expect(laneReadOnlyWords(command)).not.toBeNull();
    expect(readOnlyShellRefusal(command)).toBeNull();
  });

  it.each<[string, string]>([
    ['git grep -O', 'git grep -O less x'],
    ['git grep -n1Osh', 'git grep -n1Osh x'],
    ['git grep --open-files-in-pager', 'git grep --open-files-in-pager=less x'],
    ['git diff --output', 'git diff --output=x'],
    ['git log --out', 'git log --out=x'],
    ['git diff --ext-diff', 'git diff --ext-diff'],
    ['git diff --textconv', 'git diff --textconv'],
    ['git grep --textconv', 'git grep --textconv x'],
  ])('%s is refused for a lane and a read-only step', (_name, command) => {
    expect(laneReadOnlyWords(command)).toBeNull();
    expect(readOnlyShellRefusal(command)).not.toBeNull();
  });

  it.each<[string, string, string]>([
    ['git grep -eOption', 'git grep -eOption', '-e O'],
    ['git grep -O', 'git grep -O less x', 'git grep -O'],
    ['git diff --output', 'git diff --output=x', '--output'],
    ['git log --out (abbreviated)', 'git log --out=x', '--output'],
    ['git diff --ext-diff', 'git diff --ext-diff', '--ext-diff'],
    ['git diff --ext (abbreviated)', 'git diff --ext', '--ext-diff'],
    ['git diff --textconv', 'git diff --textconv', '--textconv'],
    ['git grep --textconv', 'git grep --textconv x', '--textconv'],
  ])('%s is refused with a message that says why', (_name, command, mention) => {
    expect(readOnlyShellRefusal(command)).toContain(mention);
  });

  it('keeps the generic message for a command that is not read-only git', () => {
    expect(readOnlyShellRefusal('git checkout -- a.ts')).toContain(
      'shell accepts only plain words',
    );
    expect(readOnlyShellRefusal('rm a')).toContain('shell accepts only plain words');
  });

  it('adds ps for lanes without widening the read-only steps', () => {
    expect(laneReadOnlyWords('ps aux')).not.toBeNull();
    expect(readOnlyShellRefusal('ps aux')).not.toBeNull();
  });

  it('keeps the read-only steps at the plain grammar', () => {
    expect(readOnlyShellRefusal(GREP)).not.toBeNull();
  });
});

const repo = tempDir('lane-read-only-repo');
afterAll(() => {
  repo.cleanup();
});

const AREA = [{ kind: ClaimKind.Area, name: 'all' }] as const;

function access(refuse: readonly string[] = []): FileAccessJudge {
  return {
    read: (_tool, input) => {
      const path = JSON.stringify(input);
      const hit = refuse.find((r) => path.includes(r));
      return hit === undefined ? 'ok' : { refuse: `${hit} is protected` };
    },
    write: () => 'ok',
    readAsk: (_tool, input) => (JSON.stringify(input).includes('/outside') ? 'outside' : null),
    writeAsk: () => null,
  };
}

function pre(command: string, fileAccess: FileAccessJudge | null = access(), tool = 'Bash') {
  return judgePreToolUse({
    toolName: tool,
    toolInput: { command },
    repoPath: repo.path,
    areas: [{ name: 'all', globs: ['**'] }],
    hazards: DEFAULT_HAZARDS,
    claims: AREA,
    readOnly: false,
    delivery: 'pull_request',
    protectedPaths: protectedPaths({
      dataDir: '/tmp/10db-data',
      home: homedir(),
      loginConfigDir: '/tmp/login',
    }),
    ...(fileAccess ? { fileAccess } : {}),
  });
}

describe('a lane Bash call made only of read-only commands', () => {
  it.each<[string]>([[`ls -la ${TASKS}; ps aux | grep -c "[v]itest"`], [GREP], [GROUPED]])(
    'is settled by the hook, so no card follows: %s',
    (command) => {
      expect(pre(command)).toEqual({ decision: 'allow', settled: expect.any(String) as string });
    },
  );

  it.each<[string, 'allow' | 'ask' | 'deny']>([
    ['grep x a | head -5 > out.txt', 'allow'],
    ['find . -delete', 'allow'],
    [String.raw`find . \( -name a -o -name b \) -exec rm '{}' ';'`, 'allow'],
    ['ls $(rm -rf x)', 'allow'],
    ['cat a; rm b', 'allow'],
    ['rm -rf /', 'deny'],
    ['git push origin main', 'deny'],
  ])('%s is judged as before: %s, not settled', (command, decision) => {
    const verdict = pre(command);
    expect(verdict.decision).toBe(decision);
    expect('settled' in verdict).toBe(false);
  });

  it('is not settled for a session without a sandbox', () => {
    expect(pre('ls', null)).toEqual({ decision: 'allow' });
  });

  it('is not settled for Monitor, which runs beside the lane', () => {
    expect('settled' in pre('ls', access(), 'Monitor')).toBe(false);
  });

  it('is not settled when it names a path a lane may never read', () => {
    expect('settled' in pre('cat secrets/.env', access(['secrets/.env']))).toBe(false);
    expect('settled' in pre('grep -r x --exclude-dir=a /data/10db', access(['/data/10db']))).toBe(
      false,
    );
    expect('settled' in pre('grep -r x --file=/data/10db/f', access(['/data/10db']))).toBe(false);
  });

  it.each<[string]>([
    ['ps -Eww'],
    ['ps Eww'],
    ['ps eww'],
    ['ps -x eww'],
    ['ps -E'],
    ['ps aux -wwE'],
  ])('is not settled for ps showing the environment: %s', (command) => {
    expect(laneReadOnlyWords(command)).toBeNull();
    expect('settled' in pre(command)).toBe(false);
  });

  it.each<[string]>([['ps aux'], ['ps -ef'], ['ps -p 123 -o pid=,comm='], ['ps -axo pid,ppid']])(
    'is still settled for ps that prints no environment: %s',
    (command) => {
      expect(pre(command)).toEqual({ decision: 'allow', settled: expect.any(String) as string });
    },
  );

  it.each<[string]>([
    ['cat /dev/zero | wc -c'],
    ['sort /dev/urandom'],
    ['head /dev//random'],
    ['grep -f/dev/zero x a'],
    ['grep --file=/dev/urandom x a'],
    ['wc -c /dev/./zero'],
  ])('is not settled when it reads a device with no end: %s', (command) => {
    expect('settled' in pre(command)).toBe(false);
  });

  describe('a device with no end, however the path is spelled', () => {
    const UP = '../'.repeat(40);

    it.each<[string]>([
      [`cat ${UP}dev/zero | wc -c`],
      [`head -c 5 ${UP}dev/urandom`],
      [`grep -f${UP}dev/zero x a`],
      [`grep --file=${UP}dev/urandom x a`],
      ['cat a/../../../../../../../../../../../../../../dev/zero'],
      ['cat zero-link | wc -c'],
      ['cat ./zero-link | wc -c'],
      ['cat dev-link/zero | wc -c'],
      ['cat chain-link | wc -c'],
      ['grep -r x /dev'],
      ['grep -r x /dev/'],
      ['grep -r x dev-link'],
      [`grep -r x ${UP}dev`],
      ['find /dev -name x'],
    ])('is not settled: %s', (command) => {
      symlinkSync('/dev/zero', join(repo.path, 'zero-link'));
      symlinkSync('/dev', join(repo.path, 'dev-link'));
      symlinkSync('zero-link', join(repo.path, 'chain-link'));
      mkdirSync(join(repo.path, 'a'), { recursive: true });
      try {
        expect('settled' in pre(command)).toBe(false);
      } finally {
        for (const name of ['zero-link', 'dev-link', 'chain-link']) {
          rmSync(join(repo.path, name), { force: true });
        }
      }
    });

    it.each<[string]>([['cat notes.txt'], ['grep -r x apps ../sibling'], ['ls /dev/null']])(
      'still settles a path that is neither: %s',
      (command) => {
        expect(pre(command)).toEqual({ decision: 'allow', settled: expect.any(String) as string });
      },
    );

    it('is not settled for a path with no single real path (`..` past a missing part)', () => {
      expect('settled' in pre('cat missing/../../dev/zero')).toBe(false);
    });
  });

  it.each<[string]>([
    ['grep -f/protected/path x a'],
    ['grep -nf/protected/path x a'],
    ['grep -ef=/protected/path x a'],
    ['rg -f/protected/path x'],
    ['head -n1 -f/protected/path'],
  ])('is not settled when a short option carries a path it may never read: %s', (command) => {
    expect('settled' in pre(command, access(['/protected/path']))).toBe(false);
  });

  it('still settles short options and bundles that carry no protected path', () => {
    expect(pre('grep -rnE -A3 -f/some/list x a | head -n 5')).toEqual({
      decision: 'allow',
      settled: expect.any(String) as string,
    });
  });

  it('is not settled for a single-dash word over 256 characters, which is not split into paths', () => {
    // Short path parts and a last part that is a name, so no tail of the word fails on its own: a part
    // over 255 characters has no real path, and a tail of just `/` holds /dev.
    const word = (length: number): string => `-${'a/'.repeat(127)}${'a'.repeat(length - 255)}`;
    expect(word(256)).toHaveLength(256);
    expect('settled' in pre(`grep ${word(256)} x a`)).toBe(true);
    expect('settled' in pre(`grep ${word(257)} x a`)).toBe(false);
  });

  it('is not settled for ps with a value holding an e, as `-o pid,etime` does', () => {
    expect(laneReadOnlyWords('ps -o pid,etime')).toBeNull();
    expect('settled' in pre('ps -o pid,etime')).toBe(false);
  });

  it('is not settled after a cd, which moves what a relative path means', () => {
    expect('settled' in pre('cd secrets && cat .env')).toBe(false);
  });

  it('still refuses allowed_domains', () => {
    const verdict = judgePreToolUse({
      toolName: 'Bash',
      toolInput: { command: 'ls', allowed_domains: ['example.org'] },
      repoPath: repo.path,
      areas: [{ name: 'all', globs: ['**'] }],
      hazards: DEFAULT_HAZARDS,
      claims: AREA,
      readOnly: false,
      protectedPaths: [],
      fileAccess: access(),
    });
    expect(verdict.decision).toBe('deny');
  });
});
