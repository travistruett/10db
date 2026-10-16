import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_HAZARDS, type ClaimKind } from '@10db/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import {
  classifyPath,
  judgeToolUse,
  resolveInRepo,
  splitCommand,
  stringField,
  stripCommandPrefixes,
} from './index';

const repo = tempDir('guard-repo');
const outside = tempDir('guard-outside');
beforeAll(() => {
  mkdirSync(join(repo.path, 'src/api'), { recursive: true });
  symlinkSync(outside.path, join(repo.path, 'link'));
  writeFileSync(join(repo.path, 'src/api/package.json'), '{}');
  mkdirSync(join(repo.path, 'packages/db/drizzle'), { recursive: true });
  symlinkSync(join(outside.path, 'new.txt'), join(repo.path, 'src/api/dangling.ts'));
  symlinkSync('../../../outside-relative/new.txt', join(repo.path, 'src/api/dangling-rel.ts'));
});
afterAll(() => {
  repo.cleanup();
  outside.cleanup();
});

type Claims = { kind: ClaimKind; name: string }[];

const AREAS = [
  { name: 'api', globs: ['src/api/**'] },
  { name: 'ui', globs: ['src/ui/**'] },
  { name: 'db', globs: ['packages/db/**'] },
];
const API_AND_DB: Claims = [
  { kind: 'area', name: 'api' },
  { kind: 'area', name: 'db' },
];

function judge(
  toolName: string,
  toolInput: unknown,
  claims: Claims = [{ kind: 'area', name: 'api' }],
) {
  return judgeToolUse({
    toolName,
    toolInput,
    repoPath: repo.path,
    areas: AREAS,
    hazards: DEFAULT_HAZARDS,
    claims,
  });
}
const bash = (command: string, claims?: Claims) => judge('Bash', { command }, claims);

describe('file edits', () => {
  it.each<{
    name: string;
    tool: string;
    path: string;
    decision: 'allow' | 'deny';
    reason?: string;
  }>([
    { name: 'claimed area', tool: 'Edit', path: 'src/api/a.ts', decision: 'allow' },
    {
      name: 'multi-edit in a claimed area',
      tool: 'MultiEdit',
      path: 'src/api/a.ts',
      decision: 'allow',
    },
    {
      name: 'absolute path inside a claimed area',
      tool: 'Write',
      path: '<repo>/src/api/b.ts',
      decision: 'allow',
    },
    {
      name: 'new file under a not-yet-created directory of a claimed area',
      tool: 'Write',
      path: 'src/api/deep/new/c.ts',
      decision: 'allow',
    },
    {
      name: 'unclaimed area',
      tool: 'Edit',
      path: 'src/ui/a.ts',
      decision: 'deny',
      reason: 'request_claim',
    },
    {
      name: 'file in no area',
      tool: 'Write',
      path: 'scratch.txt',
      decision: 'deny',
      reason: 'request_claim',
    },
    {
      name: 'escapes with ..',
      tool: 'Edit',
      path: '../other/x.ts',
      decision: 'deny',
      reason: 'outside the repository',
    },
    {
      name: 'escapes with .. after a claimed prefix',
      tool: 'Edit',
      path: 'src/api/../../../x.ts',
      decision: 'deny',
      reason: 'outside the repository',
    },
    {
      name: 'absolute path elsewhere',
      tool: 'Write',
      path: '/etc/hosts',
      decision: 'deny',
      reason: 'outside the repository',
    },
    {
      name: 'through a symlink that leaves the repo',
      tool: 'Write',
      path: 'link/x.ts',
      decision: 'deny',
      reason: 'outside the repository',
    },
    {
      name: 'through a symlink to an existing file outside',
      tool: 'Edit',
      path: 'link',
      decision: 'deny',
      reason: 'outside the repository',
    },
    {
      name: 'the repository root itself',
      tool: 'Write',
      path: '.',
      decision: 'deny',
      reason: 'outside the repository',
    },
    {
      name: 'hazard file without the hazard claim',
      tool: 'Edit',
      path: 'package.json',
      decision: 'deny',
      reason: 'hazard',
    },
    {
      name: 'nested hazard file without the hazard claim',
      tool: 'Edit',
      path: 'src/api/package.json',
      decision: 'deny',
      reason: 'hazard',
    },
    {
      name: 'dangling symlink to a new file outside the repo',
      tool: 'Write',
      path: 'src/api/dangling.ts',
      decision: 'deny',
      reason: 'outside the repository',
    },
    {
      name: 'dangling relative symlink that leaves the repo',
      tool: 'Write',
      path: 'src/api/dangling-rel.ts',
      decision: 'deny',
      reason: 'outside the repository',
    },
  ])('$name', ({ tool, path, decision, reason }) => {
    const filePath = path.replace('<repo>', repo.path);
    const verdict = judge(tool, {
      file_path: filePath,
      content: 'x',
      old_string: 'a',
      new_string: 'b',
    });
    expect(verdict.decision).toBe(decision);
    if (reason && verdict.decision === 'deny') expect(verdict.reason).toContain(reason);
  });

  it.each<{ name: string; input: unknown; decision: 'allow' | 'deny' }>([
    {
      name: 'a notebook outside the repo is denied',
      input: { notebook_path: '/etc/x.ipynb' },
      decision: 'deny',
    },
    {
      name: 'a notebook in a claimed area is allowed',
      input: { notebook_path: 'src/api/n.ipynb' },
      decision: 'allow',
    },
    { name: 'an edit with no path is left to the CLI', input: {}, decision: 'allow' },
    {
      name: 'an edit with a non-string path is left to the CLI',
      input: { file_path: 7 },
      decision: 'allow',
    },
    { name: 'a non-object input is left to the CLI', input: 'oops', decision: 'allow' },
  ])('NotebookEdit input: $name', ({ input, decision }) => {
    expect(judge('NotebookEdit', input).decision).toBe(decision);
  });

  it('allows a hazard file when the hazard is claimed', () => {
    expect(
      judge('Edit', { file_path: 'package.json' }, [{ kind: 'hazard', name: 'deps' }]).decision,
    ).toBe('allow');
  });

  it('denies a hazard file when only an area of the same name is claimed', () => {
    expect(
      judge('Edit', { file_path: 'package.json' }, [{ kind: 'area', name: 'deps' }]).decision,
    ).toBe('deny');
  });

  it.skipIf(process.platform !== 'darwin')('case-insensitive file systems', () => {
    const rows: { name: string; path: string; reason: string }[] = [
      {
        name: 'existing hazard file in another case',
        path: 'src/api/PACKAGE.JSON',
        reason: 'hazard',
      },
      {
        name: 'existing hazard directory in another case',
        path: 'packages/db/DRIZZLE/0003.sql',
        reason: 'hazard',
      },
      {
        name: 'new hazard file in a new directory in another case',
        path: 'src/api/NEW/PACKAGE.JSON',
        reason: 'hazard',
      },
    ];
    for (const row of rows) {
      const verdict = judge('Write', { file_path: row.path }, API_AND_DB);
      expect(verdict.decision, row.name).toBe('deny');
      if (verdict.decision === 'deny') expect(verdict.reason, row.name).toContain(row.reason);
    }
  });

  it('leaves reads alone', () => {
    expect(judge('Read', { file_path: '/etc/hosts' }).decision).toBe('allow');
  });
});

describe('shell commands', () => {
  it.each<{ name: string; command: string; decision: 'allow' | 'deny' }>([
    { name: 'read-only git status', command: 'git status --short', decision: 'allow' },
    { name: 'read-only git diff', command: 'git diff HEAD~1 -- src', decision: 'allow' },
    { name: 'read-only git log', command: 'git log --oneline -5', decision: 'allow' },
    { name: 'listing branches', command: 'git branch', decision: 'allow' },
    { name: 'push a feature branch', command: 'git push origin feat/x', decision: 'allow' },
    { name: 'test runner', command: 'pnpm vitest run', decision: 'allow' },
    { name: 'rm -rf inside the repo', command: 'rm -rf build', decision: 'allow' },
    { name: 'direct commit', command: "git commit -m 'x'", decision: 'deny' },
    { name: 'git add dot', command: 'git add .', decision: 'deny' },
    { name: 'git add a path', command: 'git add src/api/a.ts', decision: 'deny' },
    { name: 'checkout', command: 'git checkout main', decision: 'deny' },
    { name: 'switch', command: 'git switch -c x', decision: 'deny' },
    { name: 'stash', command: 'git stash', decision: 'deny' },
    { name: 'hard reset', command: 'git reset --hard', decision: 'deny' },
    { name: 'branch delete', command: 'git branch -D old', decision: 'deny' },
    { name: 'pull', command: 'git pull', decision: 'deny' },
    { name: 'force push', command: 'git push --force origin feat/x', decision: 'deny' },
    { name: 'push to main', command: 'git push origin main', decision: 'deny' },
    { name: 'push HEAD to master', command: 'git push origin HEAD:master', decision: 'deny' },
    {
      name: 'commit in another directory',
      command: 'git -C ../other commit -m x',
      decision: 'deny',
    },
    { name: 'commit after cd', command: "cd src && git commit -m 'x'", decision: 'deny' },
    { name: 'reset inside bash -c', command: 'bash -c "git reset --hard"', decision: 'deny' },
    { name: 'checkout in a $() substitution', command: 'echo $(git checkout .)', decision: 'deny' },
    { name: 'stash in a backtick substitution', command: 'echo `git stash`', decision: 'deny' },
    {
      name: 'checkout behind env and an assignment',
      command: 'FOO=1 env git checkout .',
      decision: 'deny',
    },
    { name: 'rm -rf in /tmp', command: 'rm -rf /tmp/x', decision: 'deny' },
    { name: 'rm -rf in home', command: 'rm -rf ~/projects', decision: 'deny' },
    { name: 'rm -rf the repo', command: 'rm -rf .', decision: 'deny' },
    { name: 'rm -rf a sibling', command: 'rm -rf ../sibling', decision: 'deny' },
    { name: 'vercel prod deploy', command: 'vercel deploy --prod', decision: 'deny' },
    { name: 'pnpm publish', command: 'pnpm publish', decision: 'deny' },
    { name: 'terraform apply', command: 'terraform apply', decision: 'deny' },
    { name: 'sudo', command: 'sudo ls', decision: 'deny' },
    { name: 'pnpm add', command: 'pnpm add zod', decision: 'deny' },
    { name: 'pnpm add with -w', command: 'pnpm -w add zod', decision: 'deny' },
    {
      name: 'pnpm add with --filter value',
      command: 'pnpm --filter @10db/db add zod',
      decision: 'deny',
    },
    {
      name: 'pnpm remove with --filter=value',
      command: 'pnpm --filter=@10db/db remove zod',
      decision: 'deny',
    },
    { name: 'pnpm i', command: 'pnpm i', decision: 'deny' },
    {
      name: 'pnpm install with a flag',
      command: 'pnpm install --frozen-lockfile',
      decision: 'deny',
    },
    { name: 'npm i', command: 'npm i left-pad', decision: 'deny' },
    {
      name: 'drizzle-kit through pnpm exec',
      command: 'pnpm exec drizzle-kit generate',
      decision: 'deny',
    },
    {
      name: 'db:migrate with a filter',
      command: 'pnpm --filter @10db/db db:migrate',
      decision: 'deny',
    },
    { name: 'filtered test run', command: 'pnpm --filter @10db/db test', decision: 'allow' },
    { name: 'single & as a separator', command: 'true & git commit -m x', decision: 'deny' },
    { name: 'subshell', command: '(git commit -m x)', decision: 'deny' },
    { name: 'brace group', command: '{ git commit -m x; }', decision: 'deny' },
    { name: 'absolute path to git', command: '/usr/bin/git commit -m x', decision: 'deny' },
    { name: 'backslash-escaped git', command: '\\git commit -m x', decision: 'deny' },
    { name: 'absolute path to rm', command: '/bin/rm -rf /tmp/x', decision: 'deny' },
    { name: 'bash with combined -lc', command: 'bash -lc "git reset --hard"', decision: 'deny' },
    { name: 'env with a flag', command: 'env -i git commit -m x', decision: 'deny' },
    { name: 'env with a valued flag', command: 'env -u FOO git commit -m x', decision: 'deny' },
    { name: 'time with a flag', command: 'time -p git commit -m x', decision: 'deny' },
    { name: 'xargs wrapper', command: 'xargs git commit -m x', decision: 'deny' },
    { name: 'xargs with a valued flag', command: 'xargs -n 1 git commit -m x', decision: 'deny' },
    { name: 'pipe into sh', command: 'echo "git reset --hard" | sh', decision: 'deny' },
    { name: 'pipe into bash with flags', command: 'cat x | bash -e', decision: 'deny' },
    { name: 'stderr redirect is not a separator', command: 'git status 2>&1', decision: 'allow' },
    {
      name: 'parameter expansion braces are not a group',
      command: 'echo ${HOME}',
      decision: 'allow',
    },
    { name: 'git with --git-dir', command: 'git --git-dir .git commit -m x', decision: 'deny' },
    { name: 'git with --git-dir=', command: 'git --git-dir=.git status', decision: 'deny' },
    { name: 'git with --work-tree', command: 'git --work-tree . commit -m x', decision: 'deny' },
    { name: 'git with --namespace', command: 'git --namespace x status', decision: 'deny' },
    { name: 'git with -c config', command: 'git -c alias.s=!sh status', decision: 'deny' },
    { name: 'git alias verb', command: 'git c -m x', decision: 'deny' },
    {
      name: 'git symbolic-ref',
      command: 'git symbolic-ref HEAD refs/heads/other',
      decision: 'deny',
    },
    { name: 'git config', command: 'git config alias.c commit', decision: 'deny' },
    { name: 'git fetch', command: 'git fetch origin', decision: 'deny' },
    { name: 'git tag create', command: 'git tag v1', decision: 'deny' },
    { name: 'git -C with a read-only verb', command: 'git -C ../other status', decision: 'allow' },
    { name: 'git show', command: 'git show HEAD', decision: 'allow' },
    { name: 'git branch --list', command: 'git branch --list', decision: 'allow' },
    { name: 'push -d', command: 'git push -d origin feat', decision: 'deny' },
    { name: 'push colon refspec delete', command: 'git push origin :feat', decision: 'deny' },
    { name: 'push -fu', command: 'git push -fu origin feat', decision: 'deny' },
    { name: 'push --mirror', command: 'git push --mirror', decision: 'deny' },
    { name: 'push --all', command: 'git push --all origin', decision: 'deny' },
    { name: 'push --delete', command: 'git push --delete origin feat', decision: 'deny' },
    { name: 'push +refspec', command: 'git push origin +feat', decision: 'deny' },
    { name: 'push -u', command: 'git push -u origin feat', decision: 'allow' },
    { name: 'pnpm -r publish', command: 'pnpm -r publish', decision: 'deny' },
    { name: 'pnpm --filter publish', command: 'pnpm --filter x publish', decision: 'deny' },
    { name: 'npx vercel deploy --prod', command: 'npx vercel deploy --prod', decision: 'deny' },
    { name: 'pnpm dlx vercel --prod', command: 'pnpm dlx vercel --prod', decision: 'deny' },
    { name: 'rm -rf with $HOME', command: 'rm -rf $HOME/projects', decision: 'deny' },
    { name: 'rm -rf with quoted $HOME', command: 'rm -rf "$HOME"', decision: 'deny' },
    { name: 'rm -rf .git', command: 'rm -rf .git', decision: 'deny' },
    { name: 'rm -rf nested .git', command: 'rm -rf sub/.git/hooks', decision: 'deny' },
    { name: 'rm -r after cd', command: 'cd .. && rm -rf sibling', decision: 'deny' },
    { name: 'rm -r --recursive form', command: 'rm --recursive ../x', decision: 'deny' },
    {
      name: 'rm --force of a file is not recursive',
      command: 'rm --force build/a.txt',
      decision: 'allow',
    },
    {
      name: 'rm -r of a dotfile that merely starts with .git',
      command: 'rm -rf .github/tmp',
      decision: 'allow',
    },
    { name: 'a subcommand that only starts like add', command: 'pnpm addons', decision: 'allow' },
  ])('$name: $command -> $decision', ({ command, decision }) => {
    expect(bash(command).decision).toBe(decision);
  });

  it('allows a hazard command when the hazard is claimed', () => {
    expect(bash('pnpm add zod', [{ kind: 'hazard', name: 'deps' }]).decision).toBe('allow');
  });

  it('points direct commits at the commit tool', () => {
    const verdict = bash("git commit -m 'x'");
    expect(verdict.decision === 'deny' && verdict.reason).toContain('commit tool');
  });

  it('allows when the Bash input has no command (the CLI rejects it anyway)', () => {
    expect(judge('Bash', {}).decision).toBe('allow');
  });
});

describe('splitCommand', () => {
  it('splits on operators outside quotes and extracts substitutions', () => {
    expect(splitCommand(`a 'b && c' && d "$(e f)" | g`).map((s) => s.words)).toEqual([
      ['a', 'b && c'],
      ['d', '$(e f)'],
      ['g'],
      ['e', 'f'],
    ]);
  });

  it('records the operator that ended each segment', () => {
    expect(splitCommand('a && b; c').map((s) => s.separator)).toEqual(['&&', ';', '']);
  });
});

describe('stripCommandPrefixes', () => {
  it.each<{ name: string; words: string[]; expected: string[] }>([
    {
      name: 'assignment and env',
      words: ['FOO=1', 'env', 'git', 'status'],
      expected: ['git', 'status'],
    },
    { name: 'nohup and time', words: ['nohup', 'time', 'ls'], expected: ['ls'] },
    { name: 'a plain command', words: ['ls', 'FOO=1'], expected: ['ls', 'FOO=1'] },
  ])('$name', ({ words, expected }) => {
    expect(stripCommandPrefixes(words)).toEqual(expected);
  });
});

describe('resolveInRepo', () => {
  it('returns the repo-relative path for a file inside', () => {
    expect(resolveInRepo(repo.path, 'src/api/a.ts')).toEqual({
      inside: true,
      rel: join('src', 'api', 'a.ts'),
    });
  });

  it('reports a symlinked parent that leaves the repo as outside', () => {
    expect(resolveInRepo(repo.path, 'link/deep/x.ts')).toEqual({ inside: false });
  });
});

describe('classifyPath', () => {
  it('lists the areas and hazards a path falls in', () => {
    expect(classifyPath('src/api/package.json', AREAS, DEFAULT_HAZARDS)).toEqual({
      areas: ['api'],
      hazards: ['deps'],
    });
  });
});

describe('stringField', () => {
  it.each<{ name: string; input: unknown; expected: string | null }>([
    { name: 'a string field', input: { command: 'ls' }, expected: 'ls' },
    { name: 'a non-string field', input: { command: 1 }, expected: null },
    { name: 'a missing field', input: {}, expected: null },
    { name: 'a non-object input', input: null, expected: null },
  ])('$name', ({ input, expected }) => {
    expect(stringField(input, 'command')).toBe(expected);
  });
});
