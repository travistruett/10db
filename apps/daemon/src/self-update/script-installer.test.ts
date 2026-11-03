import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, waitFor, type TempDir } from '../../test/fixtures';
import { silentLogger } from '../log';
import { createScriptInstaller, type ScriptInstaller } from './script-installer';

const COMMIT = 'd'.repeat(40);
const RUNNING = 'a'.repeat(40);
const TARGET = { repo: 'owner/10db' };
const GH = '/opt/homebrew/bin/gh';
const FIXED_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

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
const environments = (): string[] => lines('environments');

const stagedOk = (commit = COMMIT) =>
  `mkdir -p "$stage" && echo ${commit} > "$stage/commit"\n` +
  `echo '{"ok":true,"mode":"stage","step":"done","message":"","commit":"${commit}"}' > "$status"`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
  it('runs the stage half of the install script for main, in the target’s repository', async () => {
    fakeScript(stagedOk());
    const result = await installer.stage(TARGET, RUNNING);
    expect(result).toEqual({
      ok: true,
      current: false,
      dir: join(workDir, 'stage'),
      commit: COMMIT,
    });
    const [call] = invocations();
    expect(call).toContain('owner/10db|');
    expect(call).toContain(`--stage ${join(workDir, 'stage')}`);
    expect(call).toContain(` --running ${RUNNING} main`);
  });

  it('says the newest finished build is the running one, and keeps no folder for it', async () => {
    fakeScript(
      `echo '{"ok":true,"mode":"stage","step":"current","message":"","commit":"${RUNNING}"}' > "$status"`,
    );
    expect(await installer.stage(TARGET, RUNNING)).toEqual({
      ok: true,
      current: true,
      commit: RUNNING,
    });
    expect(existsSync(join(workDir, 'stage'))).toBe(false);
  });

  it('hands the data directory to the script, so it backs up the daemon’s own database', async () => {
    fakeScript(stagedOk());
    await installer.stage(TARGET, RUNNING);
    expect(invocations()[0]).toContain(`|${join(dir.path, 'data')}|`);
  });

  it('reports the step and message the script wrote when it failed', async () => {
    fakeScript(
      `echo '{"ok":false,"mode":"stage","step":"verify-checksum","message":"checksum mismatch","commit":""}' > "$status"\nexit 1`,
    );
    expect(await installer.stage(TARGET, RUNNING)).toEqual({
      ok: false,
      step: 'verify-checksum',
      message: 'checksum mismatch',
    });
  });

  it('reports a script that died without a status, with what it printed', async () => {
    fakeScript('echo "boom from the script" >&2\nexit 7');
    const result = await installer.stage(TARGET, RUNNING);
    expect(result).toMatchObject({ ok: false, step: 'stage' });
    expect(result.ok ? '' : result.message).toContain('boom from the script');
    expect(result.ok ? '' : result.message).toContain('7');
  });

  it('reports a script that is not there', async () => {
    expect(await installer.stage(TARGET, RUNNING)).toMatchObject({ ok: false, step: 'stage' });
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

  it('stops a script that never ends, and says so', async () => {
    const quick = installerWith({ stageTimeoutMs: 300 });
    fakeScript('exec sleep 30');
    const result = await quick.stage(TARGET, RUNNING);
    expect(result).toMatchObject({ ok: false, step: 'stage' });
    expect(result.ok ? '' : result.message).toContain('did not finish');
  });

  it('kills what the script started and removes its scratch folder when it times out', async () => {
    const quick = installerWith({ stageTimeoutMs: 300, env: () => ({ PATH: '/usr/bin:/bin' }) });
    // As gh run download is to the real script: a child of bash, which outlives a kill of bash alone.
    fakeScript(
      [
        `scratch="$(mktemp -d "$TMPDIR/10db-install.XXXXXX")"`,
        `echo "$scratch" > "${workDir}/scratch"`,
        `sleep 30 & echo $! > "${workDir}/grandchild"`,
        'wait',
      ].join('\n'),
    );
    const result = await quick.stage(TARGET, RUNNING);
    expect(result).toMatchObject({ ok: false, step: 'stage' });
    const grandchild = Number(readFileSync(join(workDir, 'grandchild'), 'utf8').trim());
    await waitFor(() => !alive(grandchild));
    expect(existsSync(readFileSync(join(workDir, 'scratch'), 'utf8').trim())).toBe(false);
  });

  it('removes the scratch folder of a script that failed on its own', async () => {
    fakeScript(
      [
        `scratch="$(mktemp -d "$TMPDIR/10db-install.XXXXXX")"`,
        `echo "$scratch" > "${workDir}/scratch"`,
        'exit 1',
      ].join('\n'),
    );
    await installer.stage(TARGET, RUNNING);
    expect(existsSync(readFileSync(join(workDir, 'scratch'), 'utf8').trim())).toBe(false);
  });

  it('fails at the stage step, without throwing, when its folders cannot be made', async () => {
    const blocked = join(dir.path, 'a-file');
    writeFileSync(blocked, 'not a folder');
    const nowhere = installerWith({ workDir: blocked, env: () => ({}) });
    const result = await nowhere.stage(TARGET, RUNNING);
    expect(result).toMatchObject({ ok: false, step: 'stage' });
    expect(result.ok ? '' : result.message).toContain('ENOTDIR');
  });

  it('runs the script with a fixed PATH, the resolved gh, and nothing that steers a shell or a loader', async () => {
    fakeScript(stagedOk());
    await installer.stage(TARGET, RUNNING);
    // The builder's own sign-in still reaches gh.
    expect(environments()).toEqual([`${FIXED_PATH}|${GH}|||builders-token`]);
  });
});

const staged = (): { dir: string; commit: string } => ({
  dir: join(workDir, 'stage'),
  commit: COMMIT,
});

function stagedScript(body: string): void {
  const scripts = join(workDir, 'stage', 'scripts', 'release');
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, 'install-app.sh'), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

describe('apply', () => {
  it('starts the staged copy of the script detached, to quit the app and start it again', async () => {
    stagedScript(`echo "$*" > "${workDir}/applied"`);
    expect(await installer.apply(staged())).toMatchObject({ ok: true });
    const args = await waitFor(() => {
      const path = join(workDir, 'applied');
      return existsSync(path) && readFileSync(path, 'utf8').trim();
    });
    expect(args).toBe(
      `--apply ${join(workDir, 'stage')} --quit-first --relaunch --status-file ${join(workDir, 'status.json')}`,
    );
  });

  it('says when the detached script has ended, and leaves its status to read', async () => {
    stagedScript(
      [
        'while [ "$#" -gt 0 ]; do case "$1" in --status-file) status="$2" ;; esac; shift; done',
        `echo '{"ok":false,"mode":"apply","step":"lock","message":"held","commit":"${COMMIT}"}' > "$status"`,
        'exit 1',
      ].join('\n'),
    );
    const result = await installer.apply(staged());
    expect(result.ok).toBe(true);
    if (result.ok) await result.ended;
    expect(installer.outcome.read()).toMatchObject({ ok: false, step: 'lock' });
  });

  it('starts it with the fixed PATH and the resolved gh as well, never the login PATH', async () => {
    stagedScript(
      `echo "$PATH|$TENDB_INSTALL_GH|\${BASH_ENV:-}|\${DYLD_INSERT_LIBRARIES:-}|\${GH_TOKEN:-}" > "${workDir}/applied-env"`,
    );
    expect(await installer.apply(staged())).toMatchObject({ ok: true });
    const seen = await waitFor(() => {
      const path = join(workDir, 'applied-env');
      return existsSync(path) && readFileSync(path, 'utf8').trim();
    });
    expect(seen).toBe(`${FIXED_PATH}|${GH}|||builders-token`);
  });

  it('fails at the start-install step when there is no staged script to run', async () => {
    expect(await installer.apply(staged())).toMatchObject({ ok: false, step: 'start-install' });
  });

  it('fails at the start-install step, without throwing, when its log cannot be opened', async () => {
    stagedScript(`touch "${workDir}/ran"`);
    mkdirSync(join(workDir, 'apply.log'));
    const result = await installer.apply(staged());
    expect(result).toMatchObject({ ok: false, step: 'start-install' });
    expect(result.ok ? '' : result.message).toContain('EISDIR');
    expect(existsSync(join(workDir, 'ran'))).toBe(false);
  });
});

describe('stop', () => {
  it('kills a stage under way, what it started included, and removes its scratch folder', async () => {
    fakeScript(
      [
        `scratch="$(mktemp -d "$TMPDIR/10db-install.XXXXXX")"`,
        `echo "$scratch" > "${workDir}/scratch"`,
        `sleep 30 & echo $! > "${workDir}/grandchild"`,
        'wait',
      ].join('\n'),
    );
    // The installer's 20 s deadline is far off: only the stop ends it.
    const stage = installer.stage(TARGET, RUNNING);
    const grandchild = await waitFor(() => {
      const path = join(workDir, 'grandchild');
      const text = existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
      return text !== '' && Number(text);
    });
    const scratch = readFileSync(join(workDir, 'scratch'), 'utf8').trim();
    await installer.stop();
    await waitFor(() => !alive(grandchild));
    expect(existsSync(scratch)).toBe(false);
    expect(existsSync(join(workDir, 'tmp'))).toBe(false);
    expect(await stage).toMatchObject({ ok: false, step: 'stage' });
  });

  it('starts no stage once stopped', async () => {
    fakeScript(`touch "${workDir}/ran"`);
    await installer.stop();
    expect(await installer.stage(TARGET, RUNNING)).toMatchObject({ ok: false, step: 'stage' });
    expect(existsSync(join(workDir, 'ran'))).toBe(false);
  });

  it('leaves an install under way running: it is what quits the app', async () => {
    stagedScript(`echo $$ > "${workDir}/installing"\nexec sleep 30`);
    expect(await installer.apply(staged())).toMatchObject({ ok: true });
    const pid = await waitFor(() => {
      const path = join(workDir, 'installing');
      const text = existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
      return text !== '' && Number(text);
    });
    try {
      await installer.stop();
      expect(alive(pid)).toBe(true);
      expect(existsSync(join(workDir, 'stage', 'scripts', 'release', 'install-app.sh'))).toBe(true);
    } finally {
      process.kill(pid, 'SIGKILL');
    }
  });
});

describe('cancel', () => {
  it('kills a stage under way and removes its folders, and later stages still run', async () => {
    fakeScript(`sleep 30 & echo $! > "${workDir}/grandchild"\nwait`);
    const stage = installer.stage(TARGET, RUNNING);
    const grandchild = await waitFor(() => {
      const path = join(workDir, 'grandchild');
      const text = existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
      return text !== '' && Number(text);
    });
    await installer.cancel();
    await waitFor(() => !alive(grandchild));
    expect(await stage).toMatchObject({ ok: false, step: 'stage' });
    expect(existsSync(join(workDir, 'tmp'))).toBe(false);
    expect(existsSync(join(workDir, 'stage'))).toBe(false);

    fakeScript(stagedOk());
    expect(await installer.stage(TARGET, RUNNING)).toMatchObject({ ok: true, commit: COMMIT });
  });

  it('settles at once when no stage is under way', async () => {
    await installer.cancel();
  });
});

describe('rollback', () => {
  const marker = () => join(workDir, 'rolled-back-from');

  it('reads the commit make rollback-app recorded it replaced, and forgets it', () => {
    writeFileSync(marker(), `${COMMIT}\n`);
    expect(installer.rollback.read()).toBe(COMMIT);
    installer.rollback.clear();
    expect(existsSync(marker())).toBe(false);
    expect(installer.rollback.read()).toBeNull();
  });

  it('reads a marker that is not a commit as none', () => {
    writeFileSync(marker(), 'main\n');
    expect(installer.rollback.read()).toBeNull();
  });
});

describe('outcome', () => {
  it('is empty before any install', () => {
    expect(installer.outcome.read()).toBeNull();
  });

  it('reads the status an install wrote, and forgets it with the staged build', () => {
    mkdirSync(join(workDir, 'stage'), { recursive: true });
    writeFileSync(join(workDir, 'stage', 'old.dmg'), 'old');
    writeFileSync(
      join(workDir, 'status.json'),
      JSON.stringify({
        ok: false,
        mode: 'apply',
        step: 'quit',
        message: 'did not quit',
        commit: COMMIT,
      }),
    );
    expect(installer.outcome.read()).toEqual({
      ok: false,
      step: 'quit',
      message: 'did not quit',
      commit: COMMIT,
    });
    installer.outcome.clear();
    expect(installer.outcome.read()).toBeNull();
    expect(existsSync(join(workDir, 'stage'))).toBe(false);
  });

  it('reads a status file that is not valid as no status', () => {
    writeFileSync(join(workDir, 'status.json'), '{ nope');
    expect(installer.outcome.read()).toBeNull();
  });
});
