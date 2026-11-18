import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ClaimKind, DEFAULT_HAZARDS, JudgeKind } from '@10db/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { judgePreToolUse, protectedPaths, type FileAccessJudge } from './index';
import { laneReadOnlyWords, readOnlyShellRefusal } from './read-only';

const TASKS = '/private/tmp/10db-abc123/claude-501/-Users-x-worktrees-lane/9f2e/tasks';
const GREP = `grep -rnE 'pattern|other' apps/daemon/src --include=*.ts | grep -v '\\.test\\.' | head -150`;

const GROUPED = String.raw`find apps/desktop/node_modules/.pnpm/ node_modules/.pnpm -maxdepth 1 \( -name "@tanstack+router-core*" -o -name "@tanstack+history*" \)`;
const NOT_GROUPED = String.raw`find . -maxdepth 2 ! -name '*.ts' -a \( -not -name x -or -name y -and -type f \)`;

describe('find with grouped tests', () => {
  it('reads grouped tests as read only, for a lane and a read-only step', () => {
    const rows: [string, string][] = [
      ['escaped parentheses', GROUPED],
      ['quoted parentheses', `find . -maxdepth 1 '(' -name "a*" -o -name b ')'`],
      ['!, -a, -not, -or and -and', NOT_GROUPED],
    ];
    for (const [name, command] of rows) {
      expect.soft(laneReadOnlyWords(command), `lane: ${name}`).not.toBeNull();
      expect.soft(readOnlyShellRefusal(command), `read-only step: ${name}`).toBeNull();
    }
  });

  it('refuses a grouped find that runs a program or writes a file', () => {
    const rows: [string, string][] = [
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
    ];
    for (const [name, command] of rows) {
      expect.soft(laneReadOnlyWords(command), `lane: ${name}`).toBeNull();
      expect.soft(readOnlyShellRefusal(command), `read-only step: ${name}`).not.toBeNull();
    }
  });
});

describe('laneReadOnlyWords', () => {
  it('reads plain reads, filters and read-only git as read only', () => {
    const rows: [string, string][] = [
      ['a listing and a process count', `ls -la ${TASKS}; ps aux | grep -c "[v]itest"`],
      ['a recursive search with an include glob, piped through filters', GREP],
      ['commands joined by && and ||', 'ls apps && cat a.ts || echo none'],
      ['read-only git', 'git log --oneline -5 | head -3'],
      ['output merged or discarded', 'grep -rn x apps 2>/dev/null | wc -l'],
    ];
    for (const [name, command] of rows)
      expect.soft(laneReadOnlyWords(command), name).not.toBeNull();
  });

  it('does not read a write, an expansion, a job or an unknown program as read only', () => {
    const rows: [string, string][] = [
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
    ];
    for (const [name, command] of rows) expect.soft(laneReadOnlyWords(command), name).toBeNull();
  });

  it('reads git options that only look like an output or program option, for both', () => {
    const rows: [string, string][] = [
      ['git log -S with a value starting with O', 'git log -SOption -- a.ts'],
      ['git log -G with a value starting with O', 'git log -GOAuth'],
      ['git diff --text', 'git diff --text'],
      ['git grep --text', 'git grep --text x'],
      ['git diff -a', 'git diff -a'],
    ];
    for (const [name, command] of rows) {
      expect.soft(laneReadOnlyWords(command), `lane: ${name}`).not.toBeNull();
      expect.soft(readOnlyShellRefusal(command), `read-only step: ${name}`).toBeNull();
    }
  });

  it('refuses a git option that writes or runs a program, for both, saying why', () => {
    const rows: [string, string][] = [
      ['git grep -O', 'git grep -O less x'],
      ['git grep -n1Osh', 'git grep -n1Osh x'],
      ['git grep --open-files-in-pager', 'git grep --open-files-in-pager=less x'],
      ['git diff --output', 'git diff --output=x'],
      ['git log --out', 'git log --out=x'],
      ['git diff --ext-diff', 'git diff --ext-diff'],
      ['git diff --textconv', 'git diff --textconv'],
      ['git grep --textconv', 'git grep --textconv x'],
    ];
    for (const [name, command] of rows) {
      expect.soft(laneReadOnlyWords(command), `lane: ${name}`).toBeNull();
      expect.soft(readOnlyShellRefusal(command), `read-only step: ${name}`).not.toBeNull();
    }
    const mentions: [string, string][] = [
      ['git grep -eOption', '-e O'],
      ['git grep -O less x', 'git grep -O'],
      ['git diff --output=x', '--output'],
      ['git log --out=x', '--output'],
      ['git diff --ext-diff', '--ext-diff'],
      ['git diff --ext', '--ext-diff'],
      ['git diff --textconv', '--textconv'],
      ['git grep --textconv x', '--textconv'],
    ];
    for (const [command, mention] of mentions) {
      expect.soft(readOnlyShellRefusal(command), command).toContain(mention);
    }
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

function pre(
  command: string,
  fileAccess: FileAccessJudge | null = access(),
  tool = 'Bash',
  cwd?: string,
) {
  return judgePreToolUse({
    judge: JudgeKind.Rules,
    coveredByAllowRule: false,
    toolName: tool,
    toolInput: { command },
    repoPath: repo.path,
    ...(cwd === undefined ? {} : { cwd }),
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
  it('is settled by the hook, so no card follows; anything else is judged as before', () => {
    for (const command of [`ls -la ${TASKS}; ps aux | grep -c "[v]itest"`, GREP, GROUPED]) {
      expect
        .soft(pre(command), command)
        .toEqual({ decision: 'allow', settled: expect.any(String) as string });
    }
    const rows: [string, 'allow' | 'ask' | 'deny'][] = [
      ['grep x a | head -5 > out.txt', 'allow'],
      ['find . -delete', 'allow'],
      [String.raw`find . \( -name a -o -name b \) -exec rm '{}' ';'`, 'allow'],
      ['ls $(rm -rf x)', 'allow'],
      ['cat a; rm b', 'allow'],
      ['rm -rf /', 'deny'],
      ['git push origin main', 'deny'],
    ];
    for (const [command, decision] of rows) {
      const verdict = pre(command);
      expect.soft(verdict.decision, command).toBe(decision);
      expect.soft('settled' in verdict, `settled: ${command}`).toBe(false);
    }
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

  it('is not settled for ps showing the environment, and still is for ps that prints none', () => {
    for (const command of ['ps -Eww', 'ps Eww', 'ps eww', 'ps -x eww', 'ps -E', 'ps aux -wwE']) {
      expect.soft(laneReadOnlyWords(command), command).toBeNull();
      expect.soft('settled' in pre(command), `settled: ${command}`).toBe(false);
    }
    for (const command of ['ps aux', 'ps -ef', 'ps -p 123 -o pid=,comm=', 'ps -axo pid,ppid']) {
      expect
        .soft(pre(command), command)
        .toEqual({ decision: 'allow', settled: expect.any(String) as string });
    }
  });

  it('is not settled when it reads a device with no end', () => {
    for (const command of [
      'cat /dev/zero | wc -c',
      'sort /dev/urandom',
      'head /dev//random',
      'grep -f/dev/zero x a',
      'grep --file=/dev/urandom x a',
      'wc -c /dev/./zero',
    ]) {
      expect.soft('settled' in pre(command), command).toBe(false);
    }
  });

  describe('a device with no end, however the path is spelled', () => {
    const UP = '../'.repeat(40);

    it('is not settled through .., a link or a directory that holds one, and settles the rest', () => {
      symlinkSync('/dev/zero', join(repo.path, 'zero-link'));
      symlinkSync('/dev', join(repo.path, 'dev-link'));
      symlinkSync('zero-link', join(repo.path, 'chain-link'));
      mkdirSync(join(repo.path, 'a'), { recursive: true });
      try {
        for (const command of [
          `cat ${UP}dev/zero | wc -c`,
          `head -c 5 ${UP}dev/urandom`,
          `grep -f${UP}dev/zero x a`,
          `grep --file=${UP}dev/urandom x a`,
          'cat a/../../../../../../../../../../../../../../dev/zero',
          'cat zero-link | wc -c',
          'cat ./zero-link | wc -c',
          'cat dev-link/zero | wc -c',
          'cat chain-link | wc -c',
          'grep -r x /dev',
          'grep -r x /dev/',
          'grep -r x dev-link',
          `grep -r x ${UP}dev`,
          'find /dev -name x',
        ]) {
          expect.soft('settled' in pre(command), command).toBe(false);
        }
      } finally {
        for (const name of ['zero-link', 'dev-link', 'chain-link']) {
          rmSync(join(repo.path, name), { force: true });
        }
      }
      for (const command of ['cat notes.txt', 'grep -r x apps ../sibling', 'ls /dev/null']) {
        expect
          .soft(pre(command), command)
          .toEqual({ decision: 'allow', settled: expect.any(String) as string });
      }
    });

    it('is not settled for a path with no single real path (`..` past a missing part)', () => {
      expect('settled' in pre('cat missing/../../dev/zero')).toBe(false);
    });
  });

  describe('after an earlier Bash call changed directory', () => {
    // Claude Code carries a `cd` into the next call, and the hook's `cwd` is where the call runs.
    const sub = () => join(repo.path, 'apps');

    function withLinks(run: () => void): void {
      mkdirSync(sub(), { recursive: true });
      symlinkSync('/dev/zero', join(sub(), 'zero-link'));
      symlinkSync('/dev', join(sub(), 'dev-link'));
      try {
        run();
      } finally {
        for (const name of ['zero-link', 'dev-link']) rmSync(join(sub(), name), { force: true });
      }
    }

    it('is not settled when a relative path names a link there to a device', () => {
      withLinks(() => {
        for (const command of [
          'cat zero-link | wc -c',
          'cat ./zero-link',
          'cat dev-link/zero',
          'grep -r x dev-link',
          'grep -fzero-link x a',
          'grep --file=zero-link x a',
        ]) {
          expect.soft('settled' in pre(command, access(), 'Bash', sub()), command).toBe(false);
        }
      });
    });

    it('was settled when the link is read from the copy root, where it does not exist', () => {
      withLinks(() => {
        expect(pre('cat zero-link')).toEqual({
          decision: 'allow',
          settled: expect.any(String) as string,
        });
      });
    });

    it('still settles an ordinary relative path there', () => {
      withLinks(() => {
        expect(pre('cat notes.txt', access(), 'Bash', sub())).toEqual({
          decision: 'allow',
          settled: expect.any(String) as string,
        });
      });
    });

    it('judges a relative path from that directory for the file-access judge too', () => {
      const seen: string[] = [];
      const judge: FileAccessJudge = {
        ...access(),
        read: (_tool, input) => {
          seen.push(JSON.stringify(input));
          return 'ok';
        },
      };
      pre('cat notes.txt', judge, 'Bash', sub());
      expect(seen).toEqual([JSON.stringify({ path: join(sub(), 'notes.txt') })]);
    });

    it('is not settled when the directory is not an absolute path', () => {
      expect('settled' in pre('cat notes.txt', access(), 'Bash', 'apps')).toBe(false);
      expect('settled' in pre('cat notes.txt', access(), 'Bash', '')).toBe(false);
    });
  });

  it('is not settled when a short option carries a path it may never read', () => {
    for (const command of [
      'grep -f/protected/path x a',
      'grep -nf/protected/path x a',
      'grep -ef=/protected/path x a',
      'rg -f/protected/path x',
      'head -n1 -f/protected/path',
    ]) {
      expect.soft('settled' in pre(command, access(['/protected/path'])), command).toBe(false);
    }
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
      judge: JudgeKind.Rules,
      coveredByAllowRule: false,
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
