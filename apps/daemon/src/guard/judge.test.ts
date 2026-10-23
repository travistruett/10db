import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_HAZARDS, type ClaimKind, type Delivery } from '@10db/contracts';
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
  writeFileSync(join(repo.path, 'src/api/a.ts'), '');
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
  readOnly = false,
) {
  return judgeToolUse({
    toolName,
    toolInput,
    repoPath: repo.path,
    areas: AREAS,
    hazards: DEFAULT_HAZARDS,
    claims,
    readOnly,
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

  it.each<{ name: string; path: string; skip?: boolean }>([
    { name: 'a path below a regular file (ENOTDIR)', path: 'src/api/a.ts/x' },
    {
      name: 'a path in an unreadable directory (EACCES)',
      path: '/private/var/root/x',
      skip: process.platform !== 'darwin' || process.getuid?.() === 0,
    },
  ])('denies instead of throwing for $name', ({ path, skip }) => {
    if (skip) return;
    const verdict = judge('Write', { file_path: path }, API_AND_DB);
    expect(verdict.decision).toBe('deny');
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
    { name: 'push to heads/main', command: 'git push origin heads/main', decision: 'deny' },
    { name: 'push feat:heads/main', command: 'git push origin feat:heads/main', decision: 'deny' },
    {
      name: 'push feat:refs/heads/main',
      command: 'git push origin feat:refs/heads/main',
      decision: 'deny',
    },
    {
      name: 'push refs/heads/master',
      command: 'git push origin refs/heads/master',
      decision: 'deny',
    },
    { name: 'npx -y vercel --prod', command: 'npx -y vercel --prod', decision: 'deny' },
    {
      name: 'pnpm --filter x dlx vercel --prod',
      command: 'pnpm --filter x dlx vercel --prod',
      decision: 'deny',
    },
    { name: 'git diff --output=file', command: 'git diff --output=out.txt', decision: 'deny' },
    { name: 'git diff --output file', command: 'git diff --output out.txt', decision: 'deny' },
    { name: 'git log --output=file', command: 'git log --output=out.txt', decision: 'deny' },
    { name: 'git show --output=file', command: 'git show HEAD --output=out.txt', decision: 'deny' },
    { name: 'git grep -O<cmd>', command: 'git grep -Osh foo', decision: 'deny' },
    {
      name: 'git grep --open-files-in-pager=cmd',
      command: 'git grep --open-files-in-pager=sh foo',
      decision: 'deny',
    },
    {
      name: 'git grep --open-files-in-pager',
      command: 'git grep --open-files-in-pager foo',
      decision: 'deny',
    },
    {
      name: 'git grep --open=sh (abbreviation)',
      command: "git grep --open='touch X;true' foo",
      decision: 'deny',
    },
    {
      name: 'git grep --open-files-in-p=sh',
      command: 'git grep --open-files-in-p=sh foo',
      decision: 'deny',
    },
    { name: 'git grep --o=sh', command: 'git grep --o=sh foo', decision: 'deny' },
    { name: 'git grep -nO bundled', command: "git grep -nO'touch X;true' foo", decision: 'deny' },
    { name: 'git grep -iO with separate value', command: 'git grep -iO sh foo', decision: 'deny' },
    {
      name: 'git grep -1O context digit before O',
      command: "git grep -1O'touch X;true' foo",
      decision: 'deny',
    },
    {
      name: 'git grep -n1O letter and digit before O',
      command: "git grep -n1O'touch X;true' foo",
      decision: 'deny',
    },
    { name: 'git grep -12O two digits before O', command: 'git grep -12Osh foo', decision: 'deny' },
    { name: 'git grep -eO bundled pattern', command: 'git grep -eO foo', decision: 'deny' },
    {
      name: 'git diff --out=file (abbreviation)',
      command: 'git diff --out=x.txt',
      decision: 'deny',
    },
    { name: 'git grep -n foo', command: 'git grep -n foo', decision: 'allow' },
    { name: 'git grep -i foo', command: 'git grep -i foo', decision: 'allow' },
    { name: 'git grep -e with an O pattern', command: 'git grep -e Opattern', decision: 'allow' },
    { name: 'git grep -w -i -n foo', command: 'git grep -w -i -n foo', decision: 'allow' },
    { name: 'git grep -c foo', command: 'git grep -c foo', decision: 'allow' },
    { name: 'git grep -E foo', command: 'git grep -E foo', decision: 'allow' },
    { name: 'git grep -e O as separate words', command: 'git grep -e O foo', decision: 'allow' },
    {
      name: 'git grep --only-matching foo',
      command: 'git grep --only-matching foo',
      decision: 'allow',
    },
    { name: 'plain git diff', command: 'git diff', decision: 'allow' },
    {
      name: 'git diff --output-indicator-new',
      command: 'git diff --output-indicator-new=+',
      decision: 'allow',
    },
    { name: 'plain git log', command: 'git log', decision: 'allow' },
    { name: 'git grep foo', command: 'git grep foo', decision: 'allow' },
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

  it('tells the agent how to pass a pattern starting with O to git grep', () => {
    const verdict = bash('git grep -eO foo');
    expect(verdict.decision === 'deny' && verdict.reason).toContain('-e O');
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

describe('implement steps and tools outside the read-only list', () => {
  it('allows a repo MCP tool in implement mode', () => {
    expect(judge('mcp__fs__write_file', { path: 'src/api/a.ts' }).decision).toBe('allow');
  });
});

describe('read-only steps', () => {
  const ro = (tool: string, input: object) =>
    judge(tool, input, [{ kind: 'area', name: 'api' }], true);
  it.each([
    { tool: 'Write', input: { file_path: 'src/api/a.ts' }, decision: 'deny' },
    { tool: 'Edit', input: { file_path: 'src/api/a.ts' }, decision: 'deny' },
    { tool: 'MultiEdit', input: { file_path: 'src/api/a.ts' }, decision: 'deny' },
    { tool: 'NotebookEdit', input: { notebook_path: 'src/api/n.ipynb' }, decision: 'deny' },
    { tool: 'Read', input: { file_path: 'src/api/a.ts' }, decision: 'allow' },
    { tool: 'Grep', input: { pattern: 'x' }, decision: 'allow' },
    { tool: 'Skill', input: { skill: 'review-checklist' }, decision: 'allow' },
    { tool: 'BashOutput', input: { bash_id: '1' }, decision: 'allow' },
    { tool: 'mcp__10db__complete_step', input: {}, decision: 'allow' },
    { tool: 'mcp__fs__write_file', input: { path: 'src/api/a.ts' }, decision: 'deny' },
    { tool: 'Agent', input: { prompt: 'edit it' }, decision: 'deny' },
  ])('$decision $tool inside the claims', ({ tool, input, decision }) => {
    expect(ro(tool, input).decision).toBe(decision);
  });

  it.each([
    { name: 'read-only git', command: 'git diff HEAD -- src/api', decision: 'allow' },
    { name: 'git log piped to head', command: 'git log --oneline | head -5', decision: 'allow' },
    {
      name: 'a grep with stderr discarded',
      command: 'grep -rn TODO src 2>/dev/null',
      decision: 'allow',
    },
    { name: 'find that only lists', command: "find src -name '*.ts'", decision: 'allow' },
    { name: 'a redirect into a file', command: 'echo x > src/api/a.ts', decision: 'deny' },
    { name: 'an append', command: 'cat a >> b', decision: 'deny' },
    { name: 'sed in place', command: "sed -i 's/a/b/' src/api/a.ts", decision: 'deny' },
    { name: 'a formatter', command: 'pnpm format', decision: 'deny' },
    { name: 'the gate', command: 'make gate', decision: 'deny' },
    { name: 'find -delete', command: 'find . -name x -delete', decision: 'deny' },
    { name: 'find -exec', command: 'find . -exec rm {} ;', decision: 'deny' },
    { name: 'tee', command: 'git diff | tee out.txt', decision: 'deny' },
    { name: 'git push', command: 'git push origin HEAD', decision: 'deny' },
    { name: 'git with a leading option', command: 'git -C /tmp status', decision: 'deny' },
    {
      name: 'sort writing a file',
      command: 'sort -o src/api/a.ts src/api/a.ts',
      decision: 'deny',
    },
    {
      name: 'sort writing a file, long form',
      command: 'sort --output=out.txt a.txt',
      decision: 'deny',
    },
    {
      name: 'uniq, which writes its second operand',
      command: 'uniq a.txt b.txt',
      decision: 'deny',
    },
    { name: 'tree writing a file', command: 'tree -o out.txt src', decision: 'deny' },
    {
      name: 'rg running a preprocessor',
      command: 'rg --pre ./scripts/x.sh TODO',
      decision: 'deny',
    },
    { name: 'cd then a read', command: 'cd src && git diff', decision: 'allow' },
    { name: 'cd to home', command: 'cd ~', decision: 'deny' },
    { name: 'a plain sort', command: 'sort a.txt', decision: 'allow' },
    { name: 'a plain rg', command: 'rg -n TODO src', decision: 'allow' },
    {
      name: 'a read hiding a write in a substitution',
      command: 'echo $(touch x)',
      decision: 'deny',
    },
    { name: 'sort bundled flags', command: 'sort -ro src/api/a.ts other.txt', decision: 'deny' },
    { name: 'sort -uo', command: 'sort -uo src/api/a.ts b.txt', decision: 'deny' },
    { name: 'sort --out abbreviation', command: 'sort --out=src/api/a.ts b.txt', decision: 'deny' },
    {
      name: 'sort --outp abbreviation',
      command: 'sort --outp=src/api/a.ts b.txt',
      decision: 'deny',
    },
    {
      name: 'find with a backslash in -delete',
      command: 'find . -name x -de\\lete',
      decision: 'deny',
    },
    {
      name: 'find with a backslash in -exec',
      command: 'find . -exe\\c rm {} \\;',
      decision: 'deny',
    },
    {
      name: 'rg abbreviated --pre with a backslash',
      command: 'rg --pr\\e=./x.sh TODO',
      decision: 'deny',
    },
    {
      name: 'rg --hostname-bin',
      command: 'rg --hostname-bin=./any-exe --hyperlink-format=default TODO',
      decision: 'deny',
    },
    { name: 'file -C', command: 'file -C -m src/api/a.ts', decision: 'deny' },
    { name: 'tree bundled -o', command: 'tree -ao out.txt src', decision: 'deny' },
    { name: 'tree -R', command: 'tree -R -L 1 -H . src', decision: 'deny' },
    {
      name: 'sort --compress-program',
      command: 'sort --compress-program=./x.sh -S 1k big',
      decision: 'deny',
    },
    { name: 'an assignment with a redirect', command: 'X=1>src/api/a.ts', decision: 'deny' },
    { name: 'an assignment with an append', command: 'A=b>>out.txt', decision: 'deny' },
    { name: 'env -S', command: "env -S 'touch pwned' true", decision: 'deny' },
    { name: 'env -P', command: 'env -P cat /usr/bin/touch pwned', decision: 'deny' },
    { name: 'xargs -J', command: 'echo p | xargs -J cat touch cat', decision: 'deny' },
    {
      name: 'GIT_EXTERNAL_DIFF assignment',
      command: "GIT_EXTERNAL_DIFF='touch pwned;true' git diff",
      decision: 'deny',
    },
    {
      name: 'git config env assignments',
      command:
        'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=./x git status',
      decision: 'deny',
    },
    { name: 'a command run by path', command: './tools/cat x', decision: 'deny' },
    { name: 'a wrapper such as time', command: 'time cat a', decision: 'deny' },
    { name: 'a plain sort of a file', command: 'sort file', decision: 'allow' },
    { name: 'sort -r', command: 'sort -r file', decision: 'allow' },
    { name: 'rg with a path', command: 'rg TODO src', decision: 'allow' },
    { name: 'git diff alone', command: 'git diff', decision: 'allow' },
    { name: 'git log --oneline', command: 'git log --oneline', decision: 'allow' },
    { name: 'find -name', command: "find . -name '*.ts'", decision: 'allow' },
    { name: 'recursive grep', command: 'grep -rn x src', decision: 'allow' },
    {
      name: 'a command substitution naming -o',
      command: "sort $(echo -o) src/api/a.ts <<< 'payload'",
      decision: 'deny',
    },
    {
      name: 'find with a substituted -exec',
      command: "find . -maxdepth 0 $(echo -exec) sh -c 'touch pwned' ';'",
      decision: 'deny',
    },
    { name: 'a backtick substitution naming -o', command: 'sort `echo -o` x b', decision: 'deny' },
    { name: 'ANSI-C quoting of -o', command: "sort $'-o' x b", decision: 'deny' },
    { name: 'locale quoting of -o', command: 'sort $"-o" x b', decision: 'deny' },
    { name: 'a default expansion yielding -o', command: 'sort ${NOPE:--o} x b', decision: 'deny' },
    { name: 'brace expansion yielding -o', command: 'sort {-o,x} b', decision: 'deny' },
    {
      name: 'brace expansion yielding -exec',
      command: "find . -maxdepth 0 {-exec,sh,-c,'touch pwned2',';'}",
      decision: 'deny',
    },
    {
      name: 'brace expansion yielding -delete',
      command: 'find . -name x {-delete,}',
      decision: 'deny',
    },
    { name: 'brace expansion yielding --pre', command: 'rg {--pre=./x.sh,TODO}', decision: 'deny' },
    {
      name: 'a substituted git --output',
      command: 'git diff $(echo --output=x)',
      decision: 'deny',
    },
    { name: 'a redirect to a file that starts with 1', command: 'cat x 2>&1foo', decision: 'deny' },
    {
      name: 'a redirect to a file that starts with null',
      command: 'echo x >/dev/nullfoo',
      decision: 'deny',
    },
    { name: 'stderr merged into stdout', command: 'cat x 2>&1', decision: 'allow' },
    { name: 'stdout discarded', command: 'grep -r x src >/dev/null', decision: 'allow' },
    { name: 'a glob', command: 'sort *', decision: 'deny' },
    { name: 'a home expansion', command: 'ls ~', decision: 'deny' },
    { name: 'an =cmd expansion', command: 'cat =ls', decision: 'deny' },
    { name: 'an =cmd expansion after empty quotes', command: 'cat ""=ls', decision: 'deny' },
    { name: 'an =cmd expansion after an option', command: 'ls --color==ls', decision: 'deny' },
    { name: 'an =cmd expansion after a colon', command: 'cat a=:=ls', decision: 'deny' },
    { name: 'a comment', command: 'echo x # comment', decision: 'deny' },
    { name: 'a newline', command: 'cat a\nb', decision: 'deny' },
    { name: 'a variable in double quotes', command: 'cat "a$b"', decision: 'deny' },
    { name: 'an escape in double quotes', command: 'cat "a\\"b"', decision: 'deny' },
    { name: 'a history bang', command: 'ls !x', decision: 'deny' },
    { name: 'an input redirect', command: 'cat <file', decision: 'deny' },
    { name: 'a numbered redirect', command: 'cat a 3>x', decision: 'deny' },
    { name: 'an &> redirect', command: 'cat a &>x', decision: 'deny' },
    { name: 'a clobber redirect', command: 'cat a >|x', decision: 'deny' },
    { name: 'a read-write redirect', command: 'cat a<>x', decision: 'deny' },
    { name: 'backgrounding', command: 'cat a&', decision: 'deny' },
    { name: 'a |& pipe', command: 'cat a |& cat', decision: 'deny' },
    { name: 'an empty-quoted option prefix', command: "sort ''-o x y", decision: 'deny' },
    { name: 'a quoted dash before o', command: 'sort "-"o x y', decision: 'deny' },
    { name: 'a fullwidth hyphen option', command: 'sort －o x y', decision: 'deny' },
    { name: 'a trailing separator', command: 'ls ;', decision: 'deny' },
    { name: 'a leading separator', command: '; ls', decision: 'deny' },
    { name: 'an unterminated quote', command: "cat 'a", decision: 'deny' },
    { name: 'parsed: git diff', command: 'git diff', decision: 'allow' },
    { name: 'parsed: git log with a count', command: 'git log --oneline -5', decision: 'allow' },
    { name: 'parsed: rg', command: 'rg TODO src', decision: 'allow' },
    {
      name: 'parsed: grep with a paren in quotes',
      command: "grep -rn 'foo(bar' src",
      decision: 'allow',
    },
    { name: 'parsed: find with a quoted glob', command: "find . -name '*.ts'", decision: 'allow' },
    { name: 'parsed: sort into head', command: 'sort file | head -3', decision: 'allow' },
    { name: 'parsed: stderr merged', command: 'cat a.ts 2>&1', decision: 'allow' },
    { name: 'parsed: stdout discarded', command: 'ls src >/dev/null', decision: 'allow' },
    {
      name: 'parsed: wc then git status',
      command: 'wc -l src/a.ts && git status',
      decision: 'allow',
    },
    { name: 'parsed: a command split by quotes', command: "s'o'rt file", decision: 'allow' },
    {
      name: 'parsed: a double-quoted pattern',
      command: 'grep -rn "foo bar" src',
      decision: 'allow',
    },
  ])('$decision $name', ({ command, decision }) => {
    expect(ro('Bash', { command }).decision).toBe(decision);
  });
});

describe('delivery and gh', () => {
  const run = (command: string, delivery: Delivery) =>
    judgeToolUse({
      toolName: 'Bash',
      toolInput: { command },
      repoPath: repo.path,
      areas: AREAS,
      hazards: DEFAULT_HAZARDS,
      claims: [{ kind: 'area', name: 'api' }],
      readOnly: false,
      delivery,
    }).decision;

  it.each<{
    name: string;
    command: string;
    local: 'allow' | 'deny';
    pullRequest: 'allow' | 'deny';
  }>([
    {
      name: 'push a feature branch',
      command: 'git push origin feat/x',
      local: 'allow',
      pullRequest: 'deny',
    },
    {
      name: 'push -u HEAD',
      command: 'git push -u origin HEAD',
      local: 'allow',
      pullRequest: 'deny',
    },
    {
      name: 'push behind git -C',
      command: 'git -C . push origin feat/x',
      local: 'allow',
      pullRequest: 'deny',
    },
    {
      name: 'push inside sh -c',
      command: "sh -c 'git push origin feat/x'",
      local: 'allow',
      pullRequest: 'deny',
    },
    {
      name: 'read-only git',
      command: 'git log --oneline -3',
      local: 'allow',
      pullRequest: 'allow',
    },
    { name: 'pr view', command: 'gh pr view 12', local: 'allow', pullRequest: 'allow' },
    { name: 'pr list', command: 'gh pr list --state open', local: 'allow', pullRequest: 'allow' },
    { name: 'pr checks', command: 'gh pr checks 12', local: 'allow', pullRequest: 'allow' },
    { name: 'pr diff', command: 'gh pr diff 12', local: 'allow', pullRequest: 'allow' },
    { name: 'pr status', command: 'gh pr status', local: 'allow', pullRequest: 'allow' },
    {
      name: 'pr create',
      command: 'gh pr create --title x --body y',
      local: 'deny',
      pullRequest: 'deny',
    },
    { name: 'pr merge', command: 'gh pr merge 12 --squash', local: 'deny', pullRequest: 'deny' },
    { name: 'pr close', command: 'gh pr close 12', local: 'deny', pullRequest: 'deny' },
    { name: 'pr edit', command: 'gh pr edit 12 --title x', local: 'deny', pullRequest: 'deny' },
    { name: 'pr ready', command: 'gh pr ready 12', local: 'deny', pullRequest: 'deny' },
    {
      name: 'pr checkout, which switches the branch',
      command: 'gh pr checkout 12',
      local: 'deny',
      pullRequest: 'deny',
    },
    { name: 'pr review', command: 'gh pr review 12 --approve', local: 'deny', pullRequest: 'deny' },
    {
      name: 'pr create with -R first',
      command: 'gh -R acme/widgets pr create',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'pr merge behind env',
      command: 'env GH_TOKEN=x gh pr merge 12',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'pr merge by full path',
      command: '/opt/homebrew/bin/gh pr merge 12',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'pr merge after cd',
      command: 'cd src && gh pr merge 3',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'pr merge in sh -c',
      command: "sh -c 'gh pr merge 3'",
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'api GET',
      command: 'gh api repos/acme/widgets/pulls',
      local: 'allow',
      pullRequest: 'allow',
    },
    {
      name: 'api explicit GET with fields',
      command: 'gh api -X GET search/issues -f q=bug',
      local: 'allow',
      pullRequest: 'allow',
    },
    {
      name: 'api -X POST',
      command: 'gh api -X POST repos/acme/widgets/pulls',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'api --method=PATCH',
      command: 'gh api --method=PATCH repos/acme/widgets',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'api -XDELETE',
      command: 'gh api -XDELETE repos/acme/widgets/git/refs/heads/x',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'api with a field (an implicit POST)',
      command: 'gh api repos/acme/widgets/issues -f title=x',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'api with a bundled field',
      command: 'gh api repos/acme/widgets/issues -ftitle=x',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'api with --input',
      command: 'gh api repos/acme/widgets/pulls --input body.json',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'api graphql',
      command: "gh api graphql -f query='mutation { x }'",
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'repo view',
      command: 'gh repo view --json nameWithOwner',
      local: 'allow',
      pullRequest: 'allow',
    },
    { name: 'repo list', command: 'gh repo list acme', local: 'allow', pullRequest: 'allow' },
    {
      name: 'repo edit',
      command: 'gh repo edit --visibility public',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'repo delete',
      command: 'gh repo delete acme/widgets --yes',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'repo create',
      command: 'gh repo create acme/other',
      local: 'deny',
      pullRequest: 'deny',
    },
    { name: 'repo sync', command: 'gh repo sync', local: 'deny', pullRequest: 'deny' },
    {
      name: 'repo set-default',
      command: 'gh repo set-default acme/widgets',
      local: 'deny',
      pullRequest: 'deny',
    },
    { name: 'issue list', command: 'gh issue list', local: 'allow', pullRequest: 'allow' },
    { name: 'gh with no command', command: 'gh', local: 'allow', pullRequest: 'allow' },
    { name: 'gh --version', command: 'gh --version', local: 'allow', pullRequest: 'allow' },
    { name: 'help', command: 'gh help pr', local: 'allow', pullRequest: 'allow' },
    { name: 'status', command: 'gh status', local: 'allow', pullRequest: 'allow' },
    { name: 'auth status', command: 'gh auth status', local: 'allow', pullRequest: 'allow' },
    {
      name: 'auth status for one active host',
      command: 'gh auth status --active --hostname github.com',
      local: 'allow',
      pullRequest: 'allow',
    },
    {
      name: 'auth status --show-token, which prints the token',
      command: 'gh auth status --show-token',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'auth status --show-token with a value',
      command: 'gh auth status --show-token=true',
      local: 'deny',
      pullRequest: 'deny',
    },
    { name: 'auth status -t', command: 'gh auth status -t', local: 'deny', pullRequest: 'deny' },
    {
      name: 'auth status with -t in a cluster of short flags',
      command: 'gh auth status -at',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'auth status with -t after another flag',
      command: 'gh auth status --hostname github.com -t',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'auth status with -t before the subcommand',
      command: 'gh auth -t status',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'auth status with --show-token before the group',
      command: 'gh --show-token auth status',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'auth status with -t first in a cluster',
      command: 'gh auth status -ta',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      // gh reads this as --hostname t; refused anyway, since a cluster can't be told apart safely.
      name: 'auth status with -t clustered after -h',
      command: 'gh auth status -ht',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'auth status with -t after several flags',
      command: 'gh auth status -a -h github.com -t',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'auth status as JSON with the token',
      command: 'gh auth status --json hosts --show-token',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'auth status -t by full path',
      command: '/opt/homebrew/bin/gh auth status -t',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'auth status -t behind env',
      command: 'env GH_HOST=github.com gh auth status -t',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'auth status --show-token inside sh -c',
      command: "sh -c 'gh auth status --show-token'",
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'auth status as JSON without the token',
      command: 'gh auth status --json hosts',
      local: 'allow',
      pullRequest: 'allow',
    },
    { name: 'issue view', command: 'gh issue view 3', local: 'allow', pullRequest: 'allow' },
    { name: 'search', command: 'gh search prs --author @me', local: 'allow', pullRequest: 'allow' },
    { name: 'run list', command: 'gh run list --limit 5', local: 'allow', pullRequest: 'allow' },
    { name: 'run view', command: 'gh run view 1', local: 'allow', pullRequest: 'allow' },
    { name: 'workflow list', command: 'gh workflow list', local: 'allow', pullRequest: 'allow' },
    {
      name: 'workflow view',
      command: 'gh workflow view ci.yml',
      local: 'allow',
      pullRequest: 'allow',
    },
    {
      name: 'issue create',
      command: 'gh issue create --title x --body y',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'an alias definition',
      command: "gh alias set m 'pr merge'",
      local: 'deny',
      pullRequest: 'deny',
    },
    { name: 'an alias call', command: 'gh m 12', local: 'deny', pullRequest: 'deny' },
    {
      name: 'an extension install',
      command: 'gh extension install owner/gh-x',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'the ext shorthand',
      command: 'gh ext install owner/gh-x',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'auth token, which prints the token',
      command: 'gh auth token',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'config set',
      command: 'gh config set git_protocol ssh',
      local: 'deny',
      pullRequest: 'deny',
    },
    {
      name: 'workflow run',
      command: 'gh workflow run deploy.yml',
      local: 'deny',
      pullRequest: 'deny',
    },
    { name: 'run rerun', command: 'gh run rerun 1', local: 'deny', pullRequest: 'deny' },
    { name: 'run cancel', command: 'gh run cancel 1', local: 'deny', pullRequest: 'deny' },
  ])('$name: $local in local, $pullRequest in pull_request', ({ command, local, pullRequest }) => {
    expect(run(command, 'local')).toBe(local);
    expect(run(command, 'pull_request')).toBe(pullRequest);
  });

  it('tells an agent in a pull-request project that 10db pushes', () => {
    const verdict = judgeToolUse({
      toolName: 'Bash',
      toolInput: { command: 'git push origin feat/x' },
      repoPath: repo.path,
      areas: AREAS,
      hazards: DEFAULT_HAZARDS,
      claims: [],
      readOnly: false,
      delivery: 'pull_request',
    });
    expect(verdict).toEqual({
      decision: 'deny',
      reason: '10db pushes when the batch ships; agents do not push in pull-request projects.',
    });
  });

  it('treats a missing delivery as local', () => {
    expect(bash('git push origin feat/x').decision).toBe('allow');
  });
});
