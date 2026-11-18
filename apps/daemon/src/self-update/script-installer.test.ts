import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { silentLogger } from '../log';
import { createScriptInstaller, type ScriptInstaller } from './script-installer';

const COMMIT = 'd'.repeat(40);
const RUNNING = 'a'.repeat(40);
const TARGET = { repo: 'owner/10db' };
const GH = '/opt/homebrew/bin/gh';

let dir: TempDir;
let releaseDir: string;
let workDir: string;
let installer: ScriptInstaller;

/** Stands in for scripts/release/install-app.sh: it records how it was run, then does `body`. */
function fakeScript(body: string): void {
  const scripts = join(releaseDir, 'scripts', 'release');
  mkdirSync(scripts, { recursive: true });
  const path = join(scripts, 'install-app.sh');
  writeFileSync(
    path,
    [
      '#!/bin/bash',
      `echo "$GH_REPO|$TENDB_INSTALL_DATA_DIR|$*" >> "${workDir}/invocations"`,
      `echo "$PATH|$TENDB_INSTALL_GH|\${BASH_ENV:-}|\${DYLD_INSERT_LIBRARIES:-}|\${GH_TOKEN:-}" >> "${workDir}/environments"`,
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in --status-file) status="$2" ;; --stage) stage="$2" ;; --apply) apply="$2" ;; esac',
      '  shift',
      'done',
      body,
    ].join('\n'),
  );
  chmodSync(path, 0o755);
}

const lines = (name: string): string[] =>
  existsSync(join(workDir, name))
    ? readFileSync(join(workDir, name), 'utf8').split('\n').filter(Boolean)
    : [];
const invocations = (): string[] => lines('invocations');

const stagedOk = (commit = COMMIT) =>
  `mkdir -p "$stage" && echo ${commit} > "$stage/commit"\n` +
  `echo '{"ok":true,"mode":"stage","step":"done","message":"","commit":"${commit}"}' > "$status"`;

function installerWith(overrides: Partial<Parameters<typeof createScriptInstaller>[0]> = {}) {
  return createScriptInstaller({
    releaseDir,
    workDir,
    dataDir: join(dir.path, 'data'),
    gh: GH,
    env: () => ({
      PATH: '/Users/builder/bin:/opt/homebrew/bin:/usr/bin',
      BASH_ENV: '/Users/builder/.bashrc-evil',
      DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
      GH_TOKEN: 'builders-token',
    }),
    logger: silentLogger,
    stageTimeoutMs: 20_000,
    ...overrides,
  });
}

beforeEach(() => {
  dir = tempDir('script-installer');
  releaseDir = join(dir.path, 'release');
  workDir = join(dir.path, 'work');
  mkdirSync(workDir, { recursive: true });
  installer = installerWith();
});
afterEach(() => {
  dir.cleanup();
});

describe('stage', () => {
  it('does not keep a stage folder that is not the build it was told to keep', async () => {
    mkdirSync(join(workDir, 'stage'), { recursive: true });
    writeFileSync(join(workDir, 'stage', 'commit'), `${RUNNING}\n`);
    writeFileSync(join(workDir, 'stage', 'old.dmg'), 'old');
    fakeScript(stagedOk());
    await installer.stage(TARGET, RUNNING, null, COMMIT);
    expect(invocations()[0]).not.toContain('--have');
    expect(existsSync(join(workDir, 'stage', 'old.dmg'))).toBe(false);
  });

  it('starts from an empty stage directory, so an old build is never installed', async () => {
    mkdirSync(join(workDir, 'stage'), { recursive: true });
    writeFileSync(join(workDir, 'stage', 'old.dmg'), 'old');
    fakeScript(
      `echo '{"ok":false,"mode":"stage","step":"download","message":"x","commit":""}' > "$status"\nexit 1`,
    );
    await installer.stage(TARGET, RUNNING);
    expect(existsSync(join(workDir, 'stage', 'old.dmg'))).toBe(false);
  });
});
