import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fastPathAllows, namesSecret, type FastPathContext, type PatchHunk } from './fast-path';

let root: string;
let checkout: string;
let ctx: FastPathContext;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fast-path-')));
  checkout = join(root, 'repo');
  const tmpDir = join(root, 'tmp');
  mkdirSync(join(checkout, 'src'), { recursive: true });
  mkdirSync(join(checkout, 'data'));
  mkdirSync(tmpDir);
  writeFileSync(join(checkout, '.env'), 'KEY=1\n');
  writeFileSync(join(checkout, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(checkout, 'src', 'a.json'), '{}\n');
  writeFileSync(join(checkout, 'data', 'seed.db'), 'rows\n');
  writeFileSync(join(checkout, 'notes.md'), 'kept\n');
  symlinkSync('.env', join(checkout, 'notes.txt'));
  // A folder whose name reads as an option, a link two levels down, and a file outside the checkout.
  mkdirSync(join(checkout, '-d'));
  mkdirSync(join(checkout, 'a', 'b'), { recursive: true });
  symlinkSync(join('a', 'b'), join(checkout, 'lnk'));
  writeFileSync(join(root, 'outside.txt'), 'private\n');
  // A folder holding a link to a folder inside the checkout, and one holding a link out in node_modules.
  mkdirSync(join(checkout, 'tree'));
  symlinkSync(join('..', 'a'), join(checkout, 'tree', 'to-dir'));
  mkdirSync(join(checkout, 'deps', 'node_modules'), { recursive: true });
  writeFileSync(join(checkout, 'deps', 'x.ts'), 'x\n');
  symlinkSync(root, join(checkout, 'deps', 'node_modules', 'escape'));
  // A link inside the checkout that leads out of it.
  symlinkSync(root, join(checkout, 'out'));
  // The sandbox's own list: each `.env*` file, and each `.env*` link with its target.
  // `data/` is ignored and `notes.md` untracked, and both were there before the session.
  ctx = {
    checkout,
    tmpDir,
    secretFiles: [join(checkout, '.env')],
    preExisting: ['data/', 'notes.md'],
  };
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

type Row = [name: string, toolName: string, input: unknown, fast: boolean, hunk?: PatchHunk];

const bash = (command: string): { command: string } => ({ command });

describe('fastPathAllows', () => {
  it.each<Row>([
    ['a read in the checkout', 'Read', { file_path: 'src/a.ts' }, true],
    ['a read of .env', 'Read', { file_path: '.env' }, false],
    ['a read of .ENV', 'Read', { file_path: '.ENV' }, false],
    ['a read of .env-production', 'Read', { file_path: '.env-production' }, false],
    ['a read through a link to .env', 'Read', { file_path: 'notes.txt' }, false],
    ['a read of secrets.yml', 'Read', { file_path: 'secrets.yml' }, false],
    ['a read of prod.tfvars', 'Read', { file_path: 'prod.tfvars' }, false],
    ['a read outside the checkout', 'Read', { file_path: '<root>/outside.txt' }, false],
    ['a read through a link out of the checkout', 'Read', { file_path: 'out/outside.txt' }, false],
    ['a read of a home path', 'Read', { file_path: '~/.config/gh/hosts.yml' }, false],
    ['a read of ~', 'Read', { file_path: '~' }, false],
    ['a read with a leading space', 'Read', { file_path: ' <root>/outside.txt' }, false],
    ['a read with a trailing space', 'Read', { file_path: 'src/a.ts ' }, false],
    ['a read with a leading space on a relative path', 'Read', { file_path: ' src/a.ts' }, false],
    ['LS of ~', 'LS', { path: '~' }, false],
    ['LS of a home path', 'LS', { path: '~/.ssh' }, false],
    ['LS with a trailing space', 'LS', { path: 'src ' }, false],
    ['Glob in a home path', 'Glob', { pattern: '*.ts', path: '~/.ssh' }, false],
    ['Glob with a leading space on its path', 'Glob', { pattern: '*.ts', path: ' src' }, false],
    ['Grep in a home path', 'Grep', { pattern: 'x', path: '~/.aws/config' }, false],
    ['Grep with a leading space on its path', 'Grep', { pattern: 'x', path: ' src/a.ts' }, false],
    ['LS outside the checkout', 'LS', { path: '<root>' }, false],
    ['LS in the checkout', 'LS', { path: 'src' }, true],
    ['Glob outside the checkout', 'Glob', { pattern: '*.txt', path: '<root>' }, false],
    ['Glob with an absolute pattern', 'Glob', { pattern: '<root>/*.txt' }, false],
    ['Glob with a parent segment', 'Glob', { pattern: '../*.txt' }, false],
    ['Glob through a link out of the checkout', 'Glob', { pattern: '*.txt', path: 'out' }, false],
    // rg never follows a link inside the tree, so a link out of the checkout or in node_modules is not reached.
    ['Glob with a literal prefix through a link out', 'Glob', { pattern: 'out/*.txt' }, false],
    ['Glob over a root holding a link out', 'Glob', { pattern: '**/*.ts' }, true],
    [
      'Glob for TypeScript in a pnpm-style root',
      'Glob',
      { pattern: '**/*.ts', path: 'deps' },
      true,
    ],
    [
      'Glob over a folder holding a link to a folder',
      'Glob',
      { pattern: '**/*.ts', path: 'tree' },
      true,
    ],
    ['Glob one level down past node_modules', 'Glob', { pattern: '*/*.ts', path: 'deps' }, true],
    [
      'an edit through a home path',
      'Edit',
      { file_path: '~/x', old_string: 'a', new_string: 'b' },
      false,
    ],
    ['Glob with a leading space', 'Glob', { pattern: ' *.ts' }, false],
    ['Glob with a trailing space', 'Glob', { pattern: '*.ts ' }, false],
    ['Glob with a home pattern', 'Glob', { pattern: '~/*.ts' }, false],
    ['Glob with a padded segment', 'Glob', { pattern: 'src/ ../*.ts' }, false],
    ['Glob with a control character', 'Glob', { pattern: 'src/\u0001*.ts' }, false],
    ['Glob with a literal link prefix', 'Glob', { pattern: 'lnk/*.ts' }, true],
    ['Glob with a brace holding ..', 'Glob', { pattern: '{..,x}/*.txt' }, false],
    ['Glob with an extglob holding ..', 'Glob', { pattern: '@(..)/*.txt' }, false],
    ['Glob with a plus extglob', 'Glob', { pattern: '+(..)/*.txt' }, false],
    ['Glob with a negated extglob', 'Glob', { pattern: '!(x)/*.txt' }, false],
    ['Glob with a star extglob', 'Glob', { pattern: '*(..)/*.txt' }, false],
    ['Glob with a question extglob', 'Glob', { pattern: '?(..)/*.txt' }, false],
    ['Glob with an escape', 'Glob', { pattern: '\\..\\/x' }, false],
    ['Glob for env files', 'Glob', { pattern: '**/.env*' }, false],
    ['Grep in one file', 'Grep', { pattern: 'TODO', path: 'src/a.ts' }, true],
    ['Grep over the checkout', 'Grep', { pattern: 'TODO' }, false],
    ['Grep with a glob for .e*', 'Grep', { pattern: '=', glob: '.e*' }, false],
    [
      'an edit in the checkout',
      'Edit',
      { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' },
      true,
    ],
    ['a write in the temp dir', 'Write', { file_path: '<tmpDir>/out.json', content: '{}' }, true],
    ['an edit outside both', 'Write', { file_path: '/tmp/x', content: 'x' }, false],
    ['an edit of .env', 'Edit', { file_path: '.env', old_string: 'K', new_string: 'L' }, false],
    ['a Codex delete', 'Edit', { file_path: 'src/a.ts' }, false, 'delete'],
    ['a Codex move', 'Edit', { file_path: 'src/a.ts' }, false, 'move'],
    ['a Codex update', 'Edit', { file_path: 'src/a.ts' }, true, 'update'],
    ['a write over a pre-existing ignored file', 'Write', { file_path: 'data/seed.db' }, false],
    ['an edit of a pre-existing ignored file', 'Edit', { file_path: 'data/seed.db' }, false],
    ['a Codex add over a pre-existing file', 'Edit', { file_path: 'data/seed.db' }, false, 'add'],
    ['an edit of a pre-existing untracked file', 'Edit', { file_path: 'notes.md' }, false],
    ['a new file in a pre-existing ignored folder', 'Write', { file_path: 'data/new.db' }, true],
    [
      'a write that is new as the kernel reads it and pre-existing with .. collapsed',
      'Write',
      { file_path: 'lnk/../data/seed.db' },
      false,
    ],
    ['ls', 'Bash', bash('ls -la src'), true],
    ['git log', 'Bash', bash('git log -5 --oneline'), true],
    ['cat .env', 'Bash', bash('cat .env'), false],
    ['cat .ENV', 'Bash', bash('cat .ENV'), false],
    ['cat a link to .env', 'Bash', bash('cat notes.txt'), false],
    ['cat a glob', 'Bash', bash('cat config/*'), false],
    ['grep -r', 'Bash', bash('grep -r KEY .'), false],
    ['grep -rn', 'Bash', bash('grep -rn KEY .'), false],
    ['grep -nr', 'Bash', bash('grep -nr KEY src'), false],
    ['grep -Rl', 'Bash', bash('grep -Rl KEY .'), false],
    ['grep --dereference-recursive', 'Bash', bash('grep --dereference-recursive KEY .'), false],
    ['grep -d recurse', 'Bash', bash('grep -d recurse KEY .'), false],
    ['grep in one file', 'Bash', bash('grep KEY src/a.ts'), true],
    ['rg with no target', 'Bash', bash('rg KEY'), false],
    ['rg --hidden on one file', 'Bash', bash('rg --hidden KEY src/a.ts'), true],
    ['git grep', 'Bash', bash('git grep KEY'), false],
    ['git show a blob', 'Bash', bash('git show HEAD:.env'), false],
    ['git show a commit', 'Bash', bash('git show HEAD'), false],
    ['git log -p', 'Bash', bash('git log -p'), false],
    ['git diff', 'Bash', bash('git diff'), false],
    ['diff -r', 'Bash', bash('diff -r src data'), false],
    ['jq -n env', 'Bash', bash('jq -n env'), false],
    ['jq $ENV', 'Bash', bash("jq '$ENV' src/a.json"), false],
    ['rg -e with a folder', 'Bash', bash('rg -e KEY src'), false],
    ['rg -e on one file', 'Bash', bash('rg -e KEY src/a.ts'), true],
    ['grep -e on one file', 'Bash', bash('grep -n -e KEY src/a.ts'), true],
    ['grep -r with a folder after --', 'Bash', bash('grep -r KEY src/a.ts -- -d'), false],
    ['grep -R with a folder after --', 'Bash', bash('grep -R KEY src/a.ts -- -d'), false],
    [
      'grep -d recurse with a folder after --',
      'Bash',
      bash('grep -d recurse KEY src/a.ts -- -d'),
      false,
    ],
    ['grep -f a file outside', 'Bash', bash('grep -o -f <root>/outside.txt src/a.ts'), false],
    ['cat a file outside the checkout', 'Bash', bash('cat <root>/outside.txt'), false],
    [
      'diff with a file outside the checkout',
      'Bash',
      bash('diff <root>/outside.txt src/a.ts'),
      false,
    ],
    ['sort --files0-from', 'Bash', bash('sort --files0-from=src/a.ts'), false],
    ['wc --files0-from', 'Bash', bash('wc --files0-from src/a.ts'), false],
    ['jq env.HOME', 'Bash', bash('jq env.HOME src/a.json'), false],
    ['jq $__loc__', 'Bash', bash("jq '$__loc__' src/a.json"), false],
    ['jq input_filename', 'Bash', bash('jq input_filename src/a.json'), false],
    ['jq on one file', 'Bash', bash('jq . src/a.json'), false],
    ['git log --patch', 'Bash', bash('git log --patch'), false],
    ['git log -U3', 'Bash', bash('git log -U3'), false],
    ['git log --word-diff', 'Bash', bash('git log --word-diff'), false],
    ['git log -c', 'Bash', bash('git log -c'), false],
    ['git log --binary', 'Bash', bash('git log --binary'), false],
    ['git log --remerge-diff', 'Bash', bash('git log --remerge-diff'), false],
    ['git log a blob', 'Bash', bash('git log HEAD:.env'), false],
    ['git log with a format and a count', 'Bash', bash('git log -n 5 --format=%h:%s'), true],
    ['git log --stat', 'Bash', bash('git log --stat -3 main'), true],
    ['git log --format that checks signatures', 'Bash', bash('git log --format=%G?'), false],
    ['git status', 'Bash', bash('git status --short'), true],
    ['head of one file', 'Bash', bash('head -n 5 src/a.ts'), true],
    ['a listing piped to wc', 'Bash', bash('ls | wc -l'), true],
    ['find in the checkout', 'Bash', bash('find src -name a.ts -type f'), true],
    ['find -L', 'Bash', bash('find -L src -name a.ts'), false],
    ['ls -RL over a checkout holding a link out', 'Bash', bash('ls -RL .'), false],
    ['ls -L over a checkout holding a link out', 'Bash', bash('ls -L .'), false],
    ['ls -R over a checkout holding a link out', 'Bash', bash('ls -R .'), true],
    ['stat -L on a file', 'Bash', bash('stat -L src/a.ts'), false],
    ['stat in the checkout', 'Bash', bash('stat src/a.ts'), true],
    ['ls outside the checkout', 'Bash', bash('ls <root>'), false],
    ['a test run', 'Bash', bash('pnpm test'), false],
    ['a deploy', 'Bash', bash('vercel deploy --prod'), false],
    ['a subagent', 'Task', { prompt: 'look around' }, true],
    ["10db's tool", 'mcp__10db__complete_step', {}, true],
    ["10db's push_branch, which sends work out", 'mcp__10db__push_branch', {}, false],
    ["10db's open_pull_request, which sends work out", 'mcp__10db__open_pull_request', {}, false],
    ["10db's merge_pull_request, which writes live", 'mcp__10db__merge_pull_request', {}, false],
    ['a repo MCP tool', 'mcp__repo__run', {}, false],
    ['WebFetch', 'WebFetch', { url: 'https://example.com', prompt: 'read it' }, false],
    ['AskUserQuestion', 'AskUserQuestion', { questions: [] }, false],
    ['an input that is a string', 'Bash', 'ls', false],
  ])('%s: %s is fast: %s', (_name, toolName, input, fast, hunk) => {
    // The temp dir is made per run, so a row names it by a placeholder.
    const placed = JSON.parse(
      JSON.stringify(input).replaceAll('<tmpDir>', ctx.tmpDir).replaceAll('<root>', root),
    ) as unknown;
    expect(
      fastPathAllows({ toolName, input: placed, cwd: checkout, hunk: hunk ?? null }, ctx),
    ).toBe(fast);
  });
});

describe('namesSecret', () => {
  it.each([
    ['.env', true],
    ['.Env', true],
    ['.env.production', true],
    ['.envrc', true],
    ['server.pem', true],
    ['id_ed25519', true],
    ['.npmrc', true],
    ['credentials.json', true],
    ['secret.yaml', true],
    ['env.ts', false],
    ['environment.md', false],
    ['keys.ts', false],
    ['secretary.md', false],
  ])('%s is %s', (name, secret) => {
    expect(namesSecret(join(checkout, 'src', name), [])).toBe(secret);
  });
});
