import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { envWithoutGitVariables } from './fixtures';
import { repoRoot } from './workspace';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function script(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
}

interface FakeTools {
  /** Include a `mise` that records its arguments, one call per line, in `calls`. */
  mise?: boolean;
  /** Include an `xcode-select` that reports the Command Line Tools as installed. */
  xcode?: boolean | 'missing';
  /** A cargo from the mise-managed toolchain: on PATH, and `mise which cargo` finds it. */
  cargo?: boolean;
  /** A cargo that mise doesn't manage (Homebrew Rust), which ignores rust-toolchain.toml. */
  systemCargo?: boolean;
}

/** Runs scripts/setup.sh as on macOS, with only fake tools (plus /usr/bin and /bin) on PATH and no terminal. */
function runSetup(tools: FakeTools, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), '10db-setup-'));
  cleanup.push(dir);
  const calls = join(dir, 'calls');
  writeFileSync(calls, '');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // `mise which cargo` answers from the fake toolchain and isn't recorded; every other call is
  // recorded in `calls` and echoed, so the output shows when it ran relative to the messages.
  if (tools.mise) {
    const whichCargo = tools.cargo === true ? 'exit 0' : 'exit 1';
    script(
      bin,
      'mise',
      `if [ "$1" = which ]; then ${whichCargo}; fi\necho "$*" >> '${calls}'\necho "mise $*"`,
    );
  }
  // setup.sh checks for the Command Line Tools only on macOS, and CI runs this on Linux.
  script(bin, 'uname', 'echo Darwin');
  if (tools.xcode === 'missing') script(bin, 'xcode-select', 'exit 2');
  else if (tools.xcode !== false) script(bin, 'xcode-select', 'echo /Library/Developer');
  if (tools.cargo === true || tools.systemCargo === true) script(bin, 'cargo', 'exit 0');
  const result = spawnSync('/bin/bash', [resolve(repoRoot, 'scripts/setup.sh')], {
    encoding: 'utf8',
    env: { ...envWithoutGitVariables(), PATH: `${bin}:/usr/bin:/bin`, ...env },
  });
  return {
    status: result.status,
    output: result.stdout + result.stderr,
    calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean),
  };
}

describe('scripts/setup.sh', () => {
  it('prints the exact install command when the Command Line Tools are missing', () => {
    const { status, output, calls } = runSetup({ mise: true, xcode: 'missing' });
    expect(status).toBe(1);
    expect(output).toContain('xcode-select --install');
    expect(calls).toEqual([]);
  });

  it('asks for mise when it is not installed', () => {
    const { status, output } = runSetup({});
    expect(status).toBe(1);
    expect(output).toContain('brew install mise');
  });

  it('installs the tools and runs pnpm through the mise-pinned toolchain', () => {
    const { status, calls } = runSetup({ mise: true }, { INSTALL_RUST: 'no' });
    expect(status).toBe(0);
    expect(calls).toEqual([
      'install node pnpm gitleaks actionlint zizmor cargo-deny',
      'exec -- pnpm install --frozen-lockfile',
    ]);
  });

  it('installs Rust without asking when INSTALL_RUST=yes', () => {
    const { status, calls } = runSetup({ mise: true }, { INSTALL_RUST: 'yes' });
    expect(status).toBe(0);
    expect(calls).toContain('install rust');
  });

  it('skips Rust when INSTALL_RUST=no', () => {
    const { status, output, calls } = runSetup({ mise: true }, { INSTALL_RUST: 'no' });
    expect(status).toBe(0);
    expect(calls).not.toContain('install rust');
    expect(output).toContain('INSTALL_RUST=yes make setup');
  });

  it('skips Rust, with the install hint, when INSTALL_RUST is unset and there is no terminal', () => {
    const { status, output, calls } = runSetup({ mise: true });
    expect(status).toBe(0);
    expect(calls).not.toContain('install rust');
    expect(output).toContain('INSTALL_RUST=yes make setup');
  });

  it('leaves Rust alone when the mise-managed cargo is already installed', () => {
    const { status, calls } = runSetup({ mise: true, cargo: true }, { INSTALL_RUST: 'yes' });
    expect(status).toBe(0);
    expect(calls).not.toContain('install rust');
  });

  it('installs the pinned Rust even when a cargo that mise does not manage is on PATH', () => {
    // Homebrew Rust ignores rust-toolchain.toml, so it must not count as installed.
    const { status, calls } = runSetup({ mise: true, systemCargo: true }, { INSTALL_RUST: 'yes' });
    expect(status).toBe(0);
    expect(calls).toContain('install rust');
  });

  it('settles the Rust question before the long installs start', () => {
    const { output } = runSetup({ mise: true }, { INSTALL_RUST: 'no' });
    expect(output.indexOf('Skipping Rust')).toBeGreaterThan(-1);
    expect(output.indexOf('Skipping Rust')).toBeLessThan(output.indexOf('mise install'));
    expect(output.indexOf('Skipping Rust')).toBeLessThan(output.indexOf('pnpm install'));
  });

  it('rejects an INSTALL_RUST value other than yes or no', () => {
    const { status, output, calls } = runSetup({ mise: true }, { INSTALL_RUST: 'maybe' });
    expect(status).toBe(1);
    expect(output).toContain('INSTALL_RUST must be yes or no');
    // Rejected up front, before any long install runs.
    expect(calls).toEqual([]);
  });
});
