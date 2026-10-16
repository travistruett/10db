import { mkdirSync, symlinkSync } from 'node:fs';
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
});
afterAll(() => {
  repo.cleanup();
  outside.cleanup();
});

const AREAS = [
  { name: 'api', globs: ['src/api/**'] },
  { name: 'ui', globs: ['src/ui/**'] },
];

type Claims = { kind: ClaimKind; name: string }[];

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
