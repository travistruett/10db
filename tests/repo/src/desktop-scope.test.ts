import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runWithFakeGh, type GhReply } from './fake-gh';
import { repoRoot } from './workspace';

const script = join(repoRoot, 'scripts/desktop-scope.mjs');
const filesCall = 'api --paginate repos/owner/repo/pulls/7/files';

const pullRequest = {
  EVENT_NAME: 'pull_request',
  REPOSITORY: 'owner/repo',
  PR_NUMBER: '7',
};

/** Runs the script and returns what the desktop job would read: the `desktop` step output. */
function decide(env: Record<string, string>, replies: readonly GhReply[]) {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-scope-'));
  try {
    const output = join(dir, 'output');
    const result = runWithFakeGh(script, replies, { ...env, GITHUB_OUTPUT: output });
    let written = '';
    try {
      written = readFileSync(output, 'utf8');
    } catch {
      // The script wrote nothing.
    }
    return { ...result, output: written };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const files = (...names: string[]): GhReply[] => [
  { args: filesCall, stdout: `${names.join('\n')}\n` },
];

describe('scripts/desktop-scope.mjs', () => {
  it.each([
    [
      '.github, scripts, tests/repo and docs',
      [
        '.github/rulesets/main-protection.json',
        '.github/workflows/release.yml',
        'scripts/check-changed.mjs',
        'scripts/gate.sh',
        'tests/repo/src/ci.test.ts',
        'docs/architecture/decisions/2026-11-04-x.md',
        'README.md',
        'AGENTS.md',
      ],
    ],
    ['agent configuration', ['.claude/rules/testing.md', '.codex/rules/default.rules']],
    ['a single doc', ['docs/superpowers/specs/spec.md']],
  ])('skips the desktop job for %s only', (_name, names) => {
    const result = decide(pullRequest, files(...names));
    expect(result.output).toBe('desktop=false\n');
    expect(result.status).toBe(0);
  });

  it.each([
    'apps/desktop/src/main.tsx',
    'apps/desktop/src-tauri/Cargo.toml',
    'apps/desktop/AGENTS.md',
    'apps/daemon/src/sandbox/seatbelt.ts',
    'apps/daemon/test/gate-sandbox.seatbelt.test.ts',
    'packages/contracts/src/index.ts',
    'packages/db/drizzle/0000_init.sql',
    'packages/harness/package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'package.json',
    'rust-toolchain.toml',
    'mise.toml',
    'mise.lock',
    'Makefile',
    'tsconfig.base.json',
    'vitest.config.ts',
    '.github/workflows/ci.yml',
    'scripts/desktop-scope.mjs',
    'scripts/release/install-app.sh',
    'scripts/release/installed-app.sh',
    'tests/repo/src/self-update-real-processes.test.ts',
    'tests/repo/src/installed-app-sandbox.ts',
    'tests/repo/src/workspace.ts',
    'tests/repo/vitest.config.ts',
    'tests/git-isolation.setup.ts',
    'some-new-top-level-file.txt',
  ])('runs the desktop job when %s changes', (name) => {
    // Mixed with paths that alone would skip it.
    const result = decide(pullRequest, files('docs/a.md', name, 'scripts/gate.sh'));
    expect(result.output).toBe('desktop=true\n');
  });

  it('runs the desktop job for a file renamed out of a desktop path', () => {
    // The files API lists the old name of a rename as previous_filename; the script asks for it.
    const result = decide(pullRequest, files('docs/moved.md', 'apps/desktop/old.md'));
    expect(result.output).toBe('desktop=true\n');
    expect(result.calls[0]?.args).toContain('previous_filename');
  });

  it('does not match a look-alike of a skipped path', () => {
    const result = decide(pullRequest, files('docsx/a.md', 'scripts-extra/a.sh'));
    expect(result.output).toBe('desktop=true\n');
  });

  it.each(['push', 'merge_group', 'workflow_dispatch', ''])(
    'always runs the desktop job on a %s event, without asking GitHub',
    (event) => {
      const result = decide({ ...pullRequest, EVENT_NAME: event }, files('docs/a.md'));
      expect(result.output).toBe('desktop=true\n');
      expect(result.calls).toEqual([]);
    },
  );

  it('decides by the files alone, so a title edit gets the decision of the last push', () => {
    // The script does not read the event action, which is what a skipped job on `edited` would
    // have to decide by.
    for (const action of ['opened', 'synchronize', 'edited']) {
      const skipped = decide({ ...pullRequest, EVENT_ACTION: action }, files('docs/a.md'));
      const kept = decide({ ...pullRequest, EVENT_ACTION: action }, files('apps/desktop/a.ts'));
      expect([skipped.output, kept.output]).toEqual(['desktop=false\n', 'desktop=true\n']);
    }
  });

  it.each([
    ['GitHub fails', [{ args: filesCall, status: 1, stderr: 'HTTP 502' }]],
    ['GitHub lists no file', [{ args: filesCall, stdout: '' }]],
    [
      'GitHub lists the most files it ever does',
      files(...Array.from({ length: 3000 }, (_, i) => `docs/${String(i)}.md`)),
    ],
  ] satisfies [string, GhReply[]][])('runs the desktop job when %s', (_name, replies) => {
    const result = decide(pullRequest, replies);
    expect(result.output).toBe('desktop=true\n');
    expect(result.status).toBe(0);
  });

  it.each([
    ['no repository', { REPOSITORY: '' }],
    ['a malformed repository', { REPOSITORY: 'owner/repo/../x' }],
    ['no pull request number', { PR_NUMBER: '' }],
    ['a malformed pull request number', { PR_NUMBER: '7/files' }],
  ])('runs the desktop job with %s, without asking GitHub', (_name, override) => {
    const result = decide({ ...pullRequest, ...override }, files('docs/a.md'));
    expect(result.output).toBe('desktop=true\n');
    expect(result.calls).toEqual([]);
  });

  it('asks for every page of the pull request files', () => {
    const result = decide(pullRequest, files('docs/a.md'));
    expect(result.calls.map((call) => call.args)).toEqual([
      expect.stringContaining(`${filesCall}?per_page=100`),
    ]);
  });

  it('prints the decision when it has no output file', () => {
    const result = runWithFakeGh(script, files('docs/a.md'), pullRequest);
    expect(result.stdout).toContain('desktop=false');
  });
});
