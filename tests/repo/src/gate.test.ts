import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, globSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createThrowawayRepo, envWithoutGitVariables, type ThrowawayRepo } from './fixtures';
import { readRepoFile, repoRoot } from './workspace';

// /bin/bash, not bash from PATH: macOS ships bash 3.2 there, and every script must run on it.
function runGate(env: Record<string, string>) {
  const result = spawnSync('/bin/bash', [resolve(repoRoot, 'scripts/gate.sh')], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...envWithoutGitVariables(), ...env },
  });
  const lines = result.stdout.trim().split('\n');
  return { status: result.status, last: lines.at(-1) ?? '' };
}

/** A directory holding a `cargo` that always fails, so a step that reaches cargo goes red. */
function failingCargoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), '10db-fake-cargo-'));
  writeFileSync(join(dir, 'cargo'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'cargo'), 0o755);
  return dir;
}

describe('scripts/gate.sh', () => {
  it('prints one PASS summary line when the selected steps pass', () => {
    const { status, last } = runGate({ GATE_STEPS: 'format' });
    expect(status).toBe(0);
    expect(last).toMatch(/^GATE PASS format \(\d+s\)$/);
    // Prettier walks the whole repo, which is slow while the other test files run alongside.
  }, 60_000);

  it('reports rust as skipped, not failed, when cargo is missing', () => {
    // A PATH without cargo but with node and pnpm.
    const path = [resolve(process.execPath, '..'), '/usr/bin', '/bin'].join(':');
    // The CI gate job sets GATE_SKIP_RUST for the whole job; clear it so this proves the cargo path.
    const { status, last } = runGate({ GATE_STEPS: 'rust', GATE_SKIP_RUST: '', PATH: path });
    expect(status).toBe(0);
    expect(last).toMatch(/^GATE PASS rust skipped \(\d+s\)$/);
  });

  it('runs rust whenever cargo is on PATH and GATE_SKIP_RUST is unset', () => {
    const fake = failingCargoDir();
    try {
      // The CI gate job sets GATE_SKIP_RUST for the whole job; clear it for this case.
      const { status, last } = runGate({
        GATE_STEPS: 'rust',
        GATE_SKIP_RUST: '',
        PATH: `${fake}:${process.env['PATH'] ?? ''}`,
      });
      expect(status).toBe(1);
      expect(last).toMatch(/^GATE FAIL: rust — /);
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  });

  it('reports rust as skipped when GATE_SKIP_RUST=1, even with cargo on PATH', () => {
    const fake = failingCargoDir();
    try {
      const path = `${fake}:${process.env['PATH'] ?? ''}`;
      const { status, last } = runGate({ GATE_STEPS: 'rust', GATE_SKIP_RUST: '1', PATH: path });
      expect(status).toBe(0);
      expect(last).toMatch(/^GATE PASS rust skipped \(\d+s\)$/);
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  });

  it('names the failing step and exits non-zero', () => {
    const { status, last } = runGate({ GATE_STEPS: 'fail-probe' });
    expect(status).toBe(1);
    expect(last).toMatch(/^GATE FAIL: fail-probe — logs in \.gate\/ \(\d+s\)$/);
  });
});

describe('scripts/check.sh', () => {
  let bare: string | undefined;
  let repo: ThrowawayRepo;

  // A repository whose `main` holds the base commit; `feat/x` is checked out with a passing probe.
  beforeEach(() => {
    repo = createThrowawayRepo('10db-check');
    symlinkSync(resolve(repoRoot, 'node_modules'), join(repo.dir, 'node_modules'));
    repo.stage(
      'package.json',
      '{"name":"probe","private":true,"type":"module","scripts":{"typecheck":"true"}}\n',
    );
    repo.stage('vitest.config.js', 'export default { test: { globals: true } };\n');
    repo.stage('eslint.config.js', "export default [{ rules: { 'no-debugger': 'error' } }];\n");
    repo.stage('probe.test.js', "it('passes', () => {});\n");
    repo.commit('chore(repo): add probe');
    repo.git('branch', 'main');
  });

  afterEach(() => {
    repo.remove();
    if (bare !== undefined) rmSync(bare, { recursive: true, force: true });
    bare = undefined;
  });

  // /bin/bash, not bash from PATH: macOS ships bash 3.2 there, and the script must run on it.
  const check = () => {
    const result = spawnSync('/bin/bash', [resolve(repoRoot, 'scripts/check.sh')], {
      cwd: repo.dir,
      encoding: 'utf8',
      env: repo.env,
    });
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      last: result.stdout.trim().split('\n').at(-1) ?? '',
    };
  };

  it('exits 0 on a clean tree, where no test file changed', () => {
    // make check runs from the pre-push hook on a clean tree. --passWithNoTests is defensive.
    const { status, last } = check();
    expect(status).toBe(0);
    expect(last).toBe('CHECK PASS');
  });

  it('runs the tests of a committed but unpushed change', () => {
    repo.stage('broken.test.js', "it('fails', () => { throw new Error('committed failure'); });\n");
    repo.commit('test(repo): add a failing test');
    const { status, output } = check();
    expect(status).not.toBe(0);
    expect(output).toContain('committed failure');
  });

  it('lints a committed but unpushed change', () => {
    repo.stage('lint-me.js', 'debugger;\n');
    repo.commit('feat(repo): add a lint error');
    const { status, output } = check();
    expect(status).not.toBe(0);
    expect(output).toContain('no-debugger');
  });

  it('measures from the upstream branch, so already pushed commits are not re-checked', () => {
    bare = mkdtempSync(join(tmpdir(), '10db-check-remote-'));
    execFileSync('git', ['init', '-q', '--bare', bare], { env: repo.env });
    repo.stage('broken.test.js', "it('fails', () => { throw new Error('pushed failure'); });\n");
    repo.commit('test(repo): add a failing test');
    repo.git('remote', 'add', 'origin', bare);
    repo.git('push', '-q', '-u', 'origin', 'feat/x');
    repo.stage('fine.test.js', "it('also passes', () => {});\n");
    repo.commit('test(repo): add a passing test');
    const { status, last } = check();
    expect(status).toBe(0);
    expect(last).toBe('CHECK PASS');
  });
});

describe('shell scripts', () => {
  // Bash 4+ features that fail on macOS /bin/bash 3.2 only when the line runs.
  const BASH4 = /\b(mapfile|readarray|coproc)\b|declare -[aA]*A|\$\{\w+(,,|\^\^)\}|;;&|&>>/;

  it.each(globSync('scripts/**/*.sh', { cwd: repoRoot }).sort())(
    '%s avoids bash 4 features',
    (path) => {
      const offending = readRepoFile(path)
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#') && BASH4.test(line));
      expect(offending).toEqual([]);
    },
  );
});
