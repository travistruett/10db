import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runWithFakeGh, type GhReply } from './fake-gh';
import { readWorkflow, stepsOf } from './workflows';
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
    [
      'desktop UI and other daemon code',
      [
        'apps/desktop/src/main.tsx',
        'apps/desktop/src/screens/x.tsx',
        'apps/desktop/AGENTS.md',
        'apps/desktop/e2e/a.spec.ts',
        'apps/daemon/src/delivery/ship.ts',
        'apps/daemon/src/git/git.ts',
        'apps/daemon/test/acceptance.test.ts',
        'packages/contracts/src/index.ts',
        'packages/db/drizzle/0000_init.sql',
        'tsconfig.base.json',
        'some-new-top-level-file.txt',
      ],
    ],
  ])('skips the desktop job for %s only', (_name, names) => {
    const result = decide(pullRequest, files(...names));
    expect(result.output).toBe('desktop=false\n');
    expect(result.status).toBe(0);
  });

  it.each([
    'apps/desktop/src-tauri/Cargo.toml',
    'apps/desktop/src-tauri/src/main.rs',
    'apps/desktop/src-tauri/tauri.conf.json',
    'apps/desktop/package.json',
    'apps/desktop/vite.config.ts',
    'apps/daemon/src/sandbox/seatbelt.ts',
    'apps/daemon/src/guard/judge.ts',
    'apps/daemon/src/keep-awake/index.ts',
    'apps/daemon/src/git/lane-writable.ts',
    'apps/daemon/src/sessions/open-in-root.ts',
    'apps/daemon/test/gate-sandbox.seatbelt.test.ts',
    'apps/daemon/test/your-mcp.seatbelt.test.ts',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'package.json',
    'rust-toolchain.toml',
    'mise.toml',
    'mise.lock',
    'Makefile',
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
  ])('runs the desktop job when %s changes', (name) => {
    // Mixed with paths that alone would skip it.
    const result = decide(pullRequest, files('docs/a.md', name, 'apps/desktop/src/main.tsx'));
    expect(result.output).toBe('desktop=true\n');
  });

  it('covers every path the macOS job’s test steps name', () => {
    const steps = stepsOf(readWorkflow('.github/workflows/ci.yml').jobs['desktop']);
    const daemonPrefix = 'pnpm --filter @10db/daemon exec vitest run ';
    const daemonRun = steps.find((step) => step.run?.startsWith(daemonPrefix))?.run;
    const repoRun = steps.find((step) => step.run?.includes('vitest run --project repo '))?.run;
    if (daemonRun === undefined || repoRun === undefined) {
      throw new Error('the desktop job has no daemon or repo vitest step');
    }
    // A directory argument stands for every file under it.
    const daemonPaths = daemonRun
      .slice(daemonPrefix.length)
      .trim()
      .split(/\s+/)
      .map((arg) => `apps/daemon/${arg.endsWith('.ts') ? arg : `${arg}/probe.ts`}`);
    const repoPaths = repoRun.split(/\s+/).filter((arg) => arg.startsWith('tests/'));
    const paths = [...daemonPaths, ...repoPaths];
    expect(repoPaths).toHaveLength(1);
    const missed = paths.filter(
      (path) => decide(pullRequest, files(path)).output !== 'desktop=true\n',
    );
    expect(missed).toEqual([]);
  });

  it('runs the desktop job for a file renamed out of a desktop path', () => {
    // The files API lists the old name of a rename as previous_filename; the script asks for it.
    const result = decide(pullRequest, files('docs/moved.md', 'apps/desktop/src-tauri/old.rs'));
    expect(result.output).toBe('desktop=true\n');
    expect(result.calls[0]?.args).toContain('previous_filename');
  });

  it('does not match a look-alike of a desktop path', () => {
    const result = decide(
      pullRequest,
      files('apps/desktop/src-tauri-x/a.rs', 'apps/daemon/src/sandboxes/a.ts'),
    );
    expect(result.output).toBe('desktop=false\n');
  });

  it.each(['merge_group', 'workflow_dispatch', ''])(
    'always runs the desktop job on a %s event, without asking GitHub',
    (event) => {
      const result = decide({ ...pullRequest, EVENT_NAME: event }, files('docs/a.md'));
      expect(result.output).toBe('desktop=true\n');
      expect(result.calls).toEqual([]);
    },
  );

  describe('on a push', () => {
    const before = 'a'.repeat(40);
    const after = 'b'.repeat(40);
    const push = { EVENT_NAME: 'push', REPOSITORY: 'owner/repo', BEFORE: before, AFTER: after };
    const compareCall = `api --paginate repos/owner/repo/compare/${before}...${after}`;
    const compare = (status: string, ...names: string[]): GhReply[] => [
      {
        args: compareCall,
        stdout: [`status:${status}`, ...names.map((n) => `file:${n}`)].join('\n'),
      },
    ];

    it('decides by the files of the pushed commits', () => {
      expect(decide(push, compare('ahead', 'docs/a.md', 'apps/desktop/src/x.tsx')).output).toBe(
        'desktop=false\n',
      );
      expect(
        decide(push, compare('ahead', 'docs/a.md', 'apps/desktop/src-tauri/a.rs')).output,
      ).toBe('desktop=true\n');
      // A file named like the status line is still a file.
      expect(decide(push, compare('ahead', 'ahead')).output).toBe('desktop=false\n');
    });

    it.each([
      ['a force push', compare('diverged', 'docs/a.md')],
      ['a rewind', compare('behind', 'docs/a.md')],
      ['a failing lookup', [{ args: compareCall, status: 1, stderr: 'HTTP 404' }]],
      ['no files listed', compare('ahead')],
      [
        'a list as long as the compare API may cut it',
        compare('ahead', ...Array.from({ length: 300 }, (_, i) => `docs/${String(i)}.md`)),
      ],
    ] satisfies [string, GhReply[]][])('runs the desktop job after %s', (_name, replies) => {
      expect(decide(push, replies).output).toBe('desktop=true\n');
    });

    it.each([
      ['a first push', { BEFORE: '0'.repeat(40) }],
      ['no earlier commit', { BEFORE: '' }],
      ['a malformed later commit', { AFTER: 'main' }],
    ])('runs the desktop job on %s, without asking GitHub', (_name, override) => {
      const result = decide({ ...push, ...override }, compare('ahead', 'docs/a.md'));
      expect(result.output).toBe('desktop=true\n');
      expect(result.calls).toEqual([]);
    });
  });

  it('decides by the files alone, so a title edit gets the decision of the last push', () => {
    // The script does not read the event action, which is what a skipped job on `edited` would
    // have to decide by.
    for (const action of ['opened', 'synchronize', 'edited']) {
      const skipped = decide({ ...pullRequest, EVENT_ACTION: action }, files('docs/a.md'));
      const kept = decide(
        { ...pullRequest, EVENT_ACTION: action },
        files('apps/desktop/src-tauri/a.rs'),
      );
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
