import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createThrowawayRepo, envWithoutGitVariables } from './fixtures';
import { readRepoFile, repoRoot } from './workspace';

interface Plan {
  readonly full: boolean;
  readonly reason: string | null;
  readonly changed?: readonly string[];
  readonly affected?: readonly string[];
  readonly outside?: readonly string[];
  readonly typecheck?: readonly string[];
  readonly drift?: readonly string[];
  readonly format?: readonly string[];
  readonly rust?: boolean;
  readonly precheck?: boolean;
  readonly knip?: boolean;
  readonly repoTests?: readonly string[];
}

/** What `scripts/check-changed.mjs --plan` says it would run for these changed files. */
function planFor(...files: string[]): Plan {
  return planWith([], files);
}

/** …and with `--precheck`. */
function precheckPlanFor(...files: string[]): Plan {
  return planWith(['--precheck'], files);
}

function planWith(flags: string[], files: string[]): Plan {
  const result = spawnSync(
    'node',
    ['scripts/check-changed.mjs', '--plan', ...flags, '--', ...files],
    { cwd: repoRoot, encoding: 'utf8', env: envWithoutGitVariables() },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Plan;
}

describe('scripts/check-changed.mjs', () => {
  it('checks only the desktop for a desktop change: nothing depends on it', () => {
    const plan = planFor('apps/desktop/src/views/settings/general-values.ts');
    expect(plan).toMatchObject({
      full: false,
      changed: ['apps/desktop'],
      affected: ['apps/desktop'],
      typecheck: ['@10db/desktop'],
      drift: [],
      rust: false,
    });
  });

  it('widens typecheck and tests to every dependent of a changed package', () => {
    const plan = planFor('packages/db/src/schema.ts');
    expect(plan.changed).toEqual(['packages/db']);
    expect(plan.affected).toEqual(['apps/daemon', 'apps/desktop', 'packages/db']);
    expect(plan.drift).toEqual(['@10db/db']);
  });

  it('follows dependents through a package that depends on another', () => {
    const plan = planFor('packages/contracts/src/entities.ts');
    expect(plan.affected).toEqual(
      expect.arrayContaining(['packages/contracts', 'packages/db', 'apps/daemon', 'apps/desktop']),
    );
    expect(plan.drift).toEqual(['@10db/contracts']);
  });

  it('runs the Rust checks for a change in the Tauri shell', () => {
    expect(planFor('apps/desktop/src-tauri/src/main.rs').rust).toBe(true);
  });

  it('adds the repo rule tests for a docs or script change, and no package', () => {
    const plan = planFor('docs/architecture/decisions/README.md', 'scripts/check.sh');
    expect(plan).toMatchObject({
      full: false,
      changed: [],
      outside: ['docs/architecture/decisions/README.md', 'scripts/check.sh'],
      affected: ['tests/repo'],
    });
  });

  it.each([
    ['an agent file', 'apps/daemon/AGENTS.md', 'apps/daemon'],
    ['a package README', 'packages/db/README.md', 'packages/db'],
    ['a package manifest', 'apps/desktop/package.json', 'apps/desktop'],
    ['the Tauri config', 'apps/desktop/src-tauri/tauri.conf.json', 'apps/desktop'],
    ['the Cargo lockfile', 'apps/desktop/src-tauri/Cargo.lock', 'apps/desktop'],
    ['the e2e config', 'apps/desktop/e2e/playwright.config.ts', 'apps/desktop'],
    ['a package script', 'apps/daemon/scripts/live-acceptance.ts', 'apps/daemon'],
    ['a vitest config', 'packages/db/vitest.config.ts', 'packages/db'],
    ['the daemon env example', 'apps/daemon/.env.example', 'apps/daemon'],
    ['a daemon git test', 'apps/daemon/src/git/git.ts', 'apps/daemon'],
    ['the daemon test fixtures', 'apps/daemon/test/fixtures.ts', 'apps/daemon'],
  ])('adds the repo rule tests for %s, which they read', (_name, file, owner) => {
    const plan = planFor(file);
    expect(plan.full).toBe(false);
    expect(plan.changed).toEqual([owner]);
    expect(plan.affected).toContain('tests/repo');
  });

  it('leaves the repo rule tests out for a package source change they do not read', () => {
    expect(planFor('apps/daemon/src/runner/runner.ts').affected).not.toContain('tests/repo');
  });

  it.each([
    ['the lockfile', 'pnpm-lock.yaml'],
    ['the root manifest', 'package.json'],
    ['the lint config', 'eslint.config.js'],
    ['the gate script', 'scripts/gate.sh'],
    ['a CI workflow', '.github/workflows/ci.yml'],
    ['the Makefile', 'Makefile'],
    ['a shared test setup file', 'tests/git-isolation.setup.ts'],
  ])('falls back to the full gate for %s', (_name, file) => {
    const plan = planFor('apps/desktop/src/app.tsx', file);
    expect(plan.full).toBe(true);
    expect(plan.reason).toContain(file);
  });

  it('plans nothing for no changed file', () => {
    expect(planFor()).toMatchObject({ full: false, changed: [], affected: [] });
  });

  it('is what `make check-changed` runs', () => {
    expect(readRepoFile('Makefile')).toMatch(
      /^check-changed:\n\t@node scripts\/check-changed\.mjs$/m,
    );
  });

  it('is what `make precheck` runs, with --precheck', () => {
    expect(readRepoFile('Makefile')).toMatch(
      /^precheck:\n\t@node scripts\/check-changed\.mjs --precheck$/m,
    );
  });
});

describe('scripts/check-changed.mjs --precheck', () => {
  it('plans no tests, no Rust checks and no repo rule tests', () => {
    const plan = precheckPlanFor('apps/desktop/src-tauri/src/main.rs', 'docs/README.md');
    expect(plan).toMatchObject({
      full: false,
      precheck: true,
      changed: ['apps/desktop'],
      affected: ['apps/desktop'],
      rust: false,
    });
  });

  it('typechecks the changed packages and every dependent, and drifts only the changed ones', () => {
    const plan = precheckPlanFor('packages/contracts/src/entities.ts');
    expect(plan.full).toBe(false);
    expect(plan.typecheck).toEqual(
      expect.arrayContaining(['@10db/contracts', '@10db/db', '@10db/daemon', '@10db/desktop']),
    );
    expect(plan.drift).toEqual(['@10db/contracts']);
  });

  it('checks a daemon change and its dependents only', () => {
    const plan = precheckPlanFor('apps/daemon/src/runner/runner.ts');
    expect(plan.changed).toEqual(['apps/daemon']);
    expect(plan.drift).toEqual([]);
  });

  it.each([
    ['the lockfile', 'pnpm-lock.yaml'],
    ['the root manifest', 'package.json'],
    ['the lint config', 'eslint.config.js'],
    ['the gate script', 'scripts/gate.sh'],
    ['a CI workflow', '.github/workflows/ci.yml'],
    ['the Makefile', 'Makefile'],
  ])('puts every package in the plan for %s, never the gate', (_name, file) => {
    const plan = precheckPlanFor('apps/desktop/src/app.tsx', file);
    expect(plan).toMatchObject({ full: true, precheck: true });
    expect(plan.reason).toContain(file);
  });

  it('plans nothing for no changed file', () => {
    expect(precheckPlanFor()).toMatchObject({ full: false, changed: [], affected: [] });
  });

  it.each([
    ['a .env template', 'apps/daemon/.env.example'],
    ['a .env file', 'apps/daemon/.env'],
    ['a desktop .env file', 'apps/desktop/.env.production'],
  ])('never names %s to Prettier: the gate sandbox denies reading it', (_name, file) => {
    const plan = precheckPlanFor(file, 'apps/daemon/src/runner/runner.ts');
    expect(plan.format).toEqual(['apps/daemon/src/runner/runner.ts']);
  });

  it('still formats a file whose name only contains .env', () => {
    const plan = precheckPlanFor('apps/daemon/src/sandbox/command-env.ts');
    expect(plan.format).toEqual(['apps/daemon/src/sandbox/command-env.ts']);
  });

  it('runs knip, which is whole-repo, for any change, but not for no change', () => {
    expect(precheckPlanFor('apps/daemon/src/delivery/index.ts').knip).toBe(true);
    expect(precheckPlanFor('docs/architecture/decisions/README.md').knip).toBe(true);
    expect(precheckPlanFor().knip).toBe(false);
  });

  it('runs the docs rule tests when a decision file is added', () => {
    const plan = precheckPlanFor('docs/architecture/decisions/2026-11-02-new-thing.md');
    expect(plan.repoTests).toEqual(['tests/repo/src/architecture-docs.test.ts']);
  });

  it('runs the agent file rule tests for an AGENTS.md and an agent rule file', () => {
    expect(precheckPlanFor('apps/daemon/AGENTS.md').repoTests).toEqual([
      'tests/repo/src/agent-docs.test.ts',
      'tests/repo/src/architecture-docs.test.ts',
    ]);
    expect(precheckPlanFor('.claude/rules/testing.md').repoTests).toEqual([
      'tests/repo/src/agent-docs.test.ts',
      'tests/repo/src/architecture-docs.test.ts',
    ]);
  });

  describe('agent-docs.test.ts beyond the agent files', () => {
    const agentDocs = 'tests/repo/src/agent-docs.test.ts';

    it.each([
      ['a CLAUDE.md anywhere', 'apps/daemon/src/CLAUDE.md'],
      ['a root CLAUDE.md', 'CLAUDE.md'],
      ['a package manifest', 'packages/db/package.json'],
      ['an app manifest', 'apps/daemon/package.json'],
      ['a grab-bag module in an app', 'apps/desktop/src/utils.ts'],
      ['a grab-bag module in a package', 'packages/contracts/src/lib/common.tsx'],
    ])('runs it for %s', (_name, file) => {
      expect(precheckPlanFor(file).repoTests).toContain(agentDocs);
    });

    it('runs it over every package for a file in a new app or package directory', () => {
      // A directory with no manifest is not a workspace package, so the plan cannot place its files
      // and falls back to every step, the agent docs test included.
      for (const file of ['packages/brand-new/src/index.ts', 'apps/brand-new/README.txt']) {
        expect(precheckPlanFor(file)).toMatchObject({ full: true, precheck: true });
      }
    });

    it.each([
      ['a normal source file', 'apps/daemon/src/runner/runner.ts'],
      ['a utils-like name that is not a grab-bag', 'apps/daemon/src/format-utils.ts'],
      ['a grab-bag name outside apps and packages', 'scripts/utils.ts'],
      ['a harness directory with a dot name', 'apps/.claude/.cc-writes/x.json'],
    ])('does not run it for %s', (_name, file) => {
      expect(precheckPlanFor(file).repoTests ?? []).not.toContain(agentDocs);
    });
  });

  it('runs no repo rule tests for a package source change: they are not about it', () => {
    expect(precheckPlanFor('apps/daemon/src/runner/runner.ts').repoTests).toEqual([]);
  });

  it('keeps the changed packages check without knip or repo rule tests', () => {
    const plan = planFor('docs/architecture/decisions/README.md');
    expect(plan.knip).toBeUndefined();
    expect(plan.repoTests).toBeUndefined();
  });

  it('runs knip and the docs rule tests over every package too', () => {
    const plan = precheckPlanFor('pnpm-lock.yaml');
    expect(plan.full).toBe(true);
    expect(readRepoFile('scripts/check-changed.mjs')).toMatch(
      /async function runPrecheckEverywhere[\s\S]*?knipStep\(\)[\s\S]*?ALL_REPO_DOC_TESTS/,
    );
  });
});

/**
 * Runs a copy of the script in a temp directory with stub `pnpm`, `bash`, `cargo` and `make` as the
 * only programs on PATH. Each logs its command line and exits 0, so the real format, lint,
 * typecheck, drift and gate never run, and the log says which commands the script chose.
 */
describe('scripts/check-changed.mjs --precheck, run', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function runWithStubs(args: string[]): { stdout: string; commands: string[] } {
    const dir = mkdtempSync(join(tmpdir(), 'check-changed-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'scripts'));
    copyFileSync(
      join(repoRoot, 'scripts/check-changed.mjs'),
      join(dir, 'scripts/check-changed.mjs'),
    );
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const log = join(dir, 'commands.log');
    for (const name of ['pnpm', 'bash', 'cargo', 'make']) {
      const stub = join(bin, name);
      writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> '${log}'\n`);
      chmodSync(stub, 0o755);
    }
    // PATH holds only the stubs, so git is absent too: the script then finds no base to diff against.
    const result = spawnSync(process.execPath, ['scripts/check-changed.mjs', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: bin },
    });
    let commands: string[] = [];
    try {
      commands = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    } catch {
      // nothing ran
    }
    return { stdout: result.stdout, commands };
  }

  // The four per-package steps, plus knip and the docs rule tests, which `runPrecheckEverywhere` adds.
  const EVERY_PACKAGE_STEPS = [
    'pnpm exec knip',
    'pnpm exec vitest run tests/repo/src/agent-docs.test.ts tests/repo/src/architecture-docs.test.ts',
    'pnpm run drift',
    'pnpm run format:check',
    'pnpm run lint',
    'pnpm run typecheck',
  ];

  it('skips a changed file it cannot stat, naming it, and a deleted one silently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-changed-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'scripts'));
    copyFileSync(
      join(repoRoot, 'scripts/check-changed.mjs'),
      join(dir, 'scripts/check-changed.mjs'),
    );
    mkdirSync(join(dir, 'apps/x/src'), { recursive: true });
    mkdirSync(join(dir, 'apps/x/locked'));
    writeFileSync(join(dir, 'apps/x/package.json'), '{"name":"x"}');
    writeFileSync(join(dir, 'apps/x/src/a.ts'), 'export {};\n');
    writeFileSync(join(dir, 'apps/x/locked/b.ts'), 'export {};\n');
    // A directory without search permission makes lstat of what is inside fail with EACCES, as the
    // sandbox's read deny list does for apps/daemon/.env.example.
    chmodSync(join(dir, 'apps/x/locked'), 0o000);
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const log = join(dir, 'commands.log');
    const stub = join(bin, 'pnpm');
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "pnpm $*" >> '${log}'\n`);
    chmodSync(stub, 0o755);
    try {
      const result = spawnSync(
        process.execPath,
        [
          'scripts/check-changed.mjs',
          '--precheck',
          '--',
          'apps/x/src/a.ts',
          'apps/x/src/gone.ts',
          'apps/x/locked/b.ts',
        ],
        { cwd: dir, encoding: 'utf8', env: { PATH: bin } },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        'check-changed: skipping what it cannot read: apps/x/locked/b.ts\n',
      );
      expect(result.stdout).not.toContain('gone.ts');
      const commands = readFileSync(log, 'utf8').split('\n').filter(Boolean);
      expect(commands).toContain('pnpm exec prettier --check --ignore-unknown apps/x/src/a.ts');
      expect(commands).toContain(
        'pnpm exec eslint --max-warnings=0 --no-warn-ignored apps/x/src/a.ts',
      );
    } finally {
      chmodSync(join(dir, 'apps/x/locked'), 0o755);
    }
  });

  it('counts a file it cannot stat as changed only when a commit or the index changes it', () => {
    const repo = createThrowawayRepo('check-changed-git');
    const locked = ['apps/x/locked', 'apps/y/locked', 'apps/z/locked'];
    try {
      const write = (path: string, content: string) => {
        mkdirSync(join(repo.dir, path, '..'), { recursive: true });
        writeFileSync(join(repo.dir, path), content);
      };
      write('scripts/check-changed.mjs', readRepoFile('scripts/check-changed.mjs'));
      for (const name of ['x', 'y', 'z']) {
        write(`apps/${name}/package.json`, JSON.stringify({ name }));
        write(`apps/${name}/locked/a.ts`, 'export {};\n');
      }
      write('docs/a.md', 'a\n');
      repo.git('add', '.');
      repo.commit('base');
      repo.git('branch', 'main');
      // apps/y's file changes in a commit, apps/z's only in the index, apps/x's not at all.
      write('docs/a.md', 'b\n');
      write('apps/y/locked/a.ts', 'export const y = 1;\n');
      repo.git('add', 'docs/a.md', 'apps/y/locked/a.ts');
      repo.commit('change');
      write('apps/z/locked/a.ts', 'export const z = 1;\n');
      repo.git('add', 'apps/z/locked/a.ts');
      // Without search permission lstat of what is inside fails with EACCES, as the sandbox's read
      // deny list makes it fail with EPERM for apps/daemon/.env.example. git cannot compare such a
      // file with the index, so a diff against the worktree reports it as changed.
      for (const dir of locked) chmodSync(join(repo.dir, dir), 0o000);
      const result = spawnSync(
        process.execPath,
        ['scripts/check-changed.mjs', '--plan', '--precheck'],
        { cwd: repo.dir, encoding: 'utf8', env: repo.env },
      );
      expect(result.status, result.stderr).toBe(0);
      const plan = JSON.parse(result.stdout) as Plan & { files: string[] };
      expect(plan.files).toEqual(['apps/y/locked/a.ts', 'apps/z/locked/a.ts', 'docs/a.md']);
      expect(plan.changed).toEqual(['apps/y', 'apps/z']);
      expect(plan.affected).toEqual(['apps/y', 'apps/z']);
      expect(result.stderr).toContain(
        'check-changed: skipping what it cannot read: apps/x/locked/a.ts\n',
      );
    } finally {
      for (const dir of locked) chmodSync(join(repo.dir, dir), 0o755);
      repo.remove();
    }
  });

  it('runs the four steps over every package, not the gate, for a file it cannot place', () => {
    const run = runWithStubs(['--precheck', '--', 'pnpm-lock.yaml']);
    expect(run.stdout).toContain('pre-check over every package');
    expect(run.stdout).toContain('CHECK-CHANGED PASS');
    expect(run.commands.filter((c) => c.startsWith('bash'))).toEqual([]);
    expect([...run.commands].sort()).toEqual(EVERY_PACKAGE_STEPS);
    // Drift regenerates files in the tree, so it runs last.
    expect(run.commands.at(-1)).toBe('pnpm run drift');
  });

  it('runs the four steps over every package, not the gate, when there is no base', () => {
    const run = runWithStubs(['--precheck']);
    expect(run.stdout).toContain('no base branch to diff against');
    expect(run.commands.filter((c) => c.startsWith('bash'))).toEqual([]);
    expect([...run.commands].sort()).toEqual(EVERY_PACKAGE_STEPS);
  });

  /** Runs a copy with a `pnpm` that fails `fails`' commands; every changed file is `apps/x/…`. */
  function runFailing(fails: string, files: string[], flags: string[] = []) {
    const dir = mkdtempSync(join(tmpdir(), 'check-changed-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, 'apps/x/src'), { recursive: true });
    copyFileSync(
      join(repoRoot, 'scripts/check-changed.mjs'),
      join(dir, 'scripts/check-changed.mjs'),
    );
    writeFileSync(
      join(dir, 'apps/x/package.json'),
      JSON.stringify({ name: '@10db/x', scripts: { drift: 'true' } }),
    );
    for (const file of files) writeFileSync(join(dir, file), 'export {};\n');
    mkdirSync(join(dir, '.gate'));
    writeFileSync(join(dir, '.gate/rust.log'), 'left by an earlier run\n');
    writeFileSync(
      join(dir, 'bin/pnpm'),
      `#!/bin/sh\ncase "$*" in\n  ${fails}) echo "the step's output"; exit 1 ;;\nesac\n`,
    );
    chmodSync(join(dir, 'bin/pnpm'), 0o755);
    const result = spawnSync(
      process.execPath,
      ['scripts/check-changed.mjs', ...flags, '--', ...files],
      { cwd: dir, encoding: 'utf8', env: { PATH: join(dir, 'bin') } },
    );
    return { dir, status: result.status, stdout: result.stdout };
  }

  it('names each failing step and its log as the gate does, the summary line last', () => {
    const run = runFailing('exec\\ vitest*', ['apps/x/src/a.ts']);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(
      '\nFAILED test: pnpm exec vitest run --passWithNoTests apps/x/ (log .gate/test.log)\n',
    );
    expect(run.stdout.trimEnd().split('\n').at(-1)).toMatch(/^CHECK-CHANGED FAIL: test \(\d+s\)$/);
    expect(readFileSync(join(run.dir, '.gate/test.log'), 'utf8')).toBe("the step's output\n");
  });

  it('leaves only the logs of its own run in .gate/', () => {
    const run = runFailing('exec\\ vitest*', ['apps/x/src/a.ts']);
    expect(readdirSync(join(run.dir, '.gate')).sort()).toEqual([
      'drift-10db-x.log',
      'format.log',
      'lint.log',
      'test.log',
    ]);
  });

  it('gives a step whose name has a space a FAILED line the fix brief can read', () => {
    const run = runFailing('--filter*drift', ['apps/x/src/a.ts']);
    expect(run.stdout).toContain(
      '\nFAILED drift-10db-x: pnpm --filter @10db/x run drift (log .gate/drift-10db-x.log)\n',
    );
  });

  it('prints no FAILED line for a run that passes', () => {
    const run = runFailing('nothing', ['apps/x/src/a.ts']);
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain('FAILED');
  });

  it('keeps the FAILED line of a step with hundreds of files short, so the next ones stay in the tail 10db reads', () => {
    const files = Array.from(
      { length: 400 },
      (_, n) => `apps/x/src/a-file-with-quite-a-long-name-${String(n)}.ts`,
    );
    const run = runFailing('exec\\ prettier*|exec\\ vitest*', files);
    const failed = run.stdout.split('\n').filter((line) => line.startsWith('FAILED '));
    expect(failed).toEqual([
      'FAILED format: node scripts/check-changed.mjs (log .gate/format.log)',
      'FAILED test: pnpm exec vitest run --passWithNoTests apps/x/ (log .gate/test.log)',
    ]);
  });

  it('names the pre-check to rerun when a step of the pre-check has too long a command', () => {
    const files = Array.from(
      { length: 400 },
      (_, n) => `apps/x/src/a-file-with-quite-a-long-name-${String(n)}.ts`,
    );
    const run = runFailing('exec\\ prettier*', files, ['--precheck']);
    expect(run.stdout).toContain(
      '\nFAILED format: node scripts/check-changed.mjs --precheck (log .gate/format.log)\n',
    );
  });

  it('does run the gate for the same unplaced file without --precheck', () => {
    const run = runWithStubs(['--', 'pnpm-lock.yaml']);
    expect(run.stdout).toContain('running the full gate');
    expect(run.commands).toEqual([expect.stringMatching(/^bash .*scripts\/gate\.sh$/)]);
  });
});
