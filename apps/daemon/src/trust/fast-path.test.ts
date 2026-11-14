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
  symlinkSync('.env', join(checkout, 'notes.txt'));
  // The sandbox's own list: each `.env*` file, and each `.env*` link with its target.
  ctx = { checkout, tmpDir, secretFiles: [join(checkout, '.env')] };
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
    ['Glob for TypeScript', 'Glob', { pattern: '**/*.ts' }, true],
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
    ['a test run', 'Bash', bash('pnpm test'), false],
    ['a deploy', 'Bash', bash('vercel deploy --prod'), false],
    ['a subagent', 'Task', { prompt: 'look around' }, true],
    ["10db's tool", 'mcp__10db__complete_step', {}, true],
    ['a repo MCP tool', 'mcp__repo__run', {}, false],
    ['WebFetch', 'WebFetch', { url: 'https://example.com', prompt: 'read it' }, false],
    ['AskUserQuestion', 'AskUserQuestion', { questions: [] }, false],
    ['an input that is a string', 'Bash', 'ls', false],
  ])('%s: %s is fast: %s', (_name, toolName, input, fast, hunk) => {
    // The temp dir is made per run, so a row names it by a placeholder.
    const placed = JSON.parse(JSON.stringify(input).replace('<tmpDir>', ctx.tmpDir)) as unknown;
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
