import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mintId, type BatchDto, type ProjectDto } from '@10db/contracts';
import { createTestStore, deleteAppSetting, listInbox, seedProject } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTempRepoWithOrigin,
  isolatedGitEnv,
  SANDBOXED,
  tempDir,
  type TempDir,
} from '../../test/fixtures';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore } from '../events';
import { createGit } from '../git';
import { createInboxService } from '../inbox';
import { silentLogger } from '../log';
import { listNetworkHosts } from '../permissions';
import { createGateRunner, type GateRequest, type GateRunner } from '../verify';
import { resolvePnpm } from './pnpm-binary';
import {
  createWorktreeDependencies,
  installCommand,
  raiseInstallHostCards,
} from './worktree-dependencies';

const STANDALONE_PNPM = await resolvePnpm(
  Object.fromEntries(
    Object.entries(process.env).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]])),
  ),
  [],
);

let tmp: TempDir;
let worktree: string;
let bin: string;
let calls: string;
let requests: GateRequest[];
const signal = new AbortController().signal;
const batch = { id: mintId('Batch') } as BatchDto;
// Only what the step reads.
const project = { id: mintId('Project'), sandboxLoopback: true } as ProjectDto;

beforeEach(() => {
  tmp = tempDir('worktree-deps');
  worktree = join(tmp.path, 'worktree');
  bin = join(tmp.path, 'bin');
  calls = join(tmp.path, 'calls.log');
  mkdirSync(worktree);
  mkdirSync(bin);
  requests = [];
});
afterEach(() => {
  tmp.cleanup();
});

/** A `pnpm` that records where it ran and with what, prints a line and exits with `FAKE_PNPM_EXIT`. */
function fakePnpm(): void {
  const script = join(bin, 'pnpm');
  writeFileSync(
    script,
    `#!/bin/sh\nprintf '%s | %s\\n' "$PWD" "$*" >> '${calls}'\necho "fake pnpm: $FAKE_PNPM_SAYS"\nexit "\${FAKE_PNPM_EXIT:-0}"\n`,
  );
  chmodSync(script, 0o755);
}

function dependencies(
  env: Record<string, string> = {},
  timeoutMs = 20_000,
  onRequest: () => void = () => undefined,
  pnpmVersion?: () => Promise<string | null>,
) {
  const real = createGateRunner({ sandbox: null, logger: silentLogger });
  const gate: GateRunner = {
    run: (request) => {
      requests.push(request);
      onRequest();
      return real.run(request);
    },
  };
  return createWorktreeDependencies({
    gate,
    clock: new ManualClock(),
    dataDir: join(tmp.path, 'data'),
    sessionEnv: () => ({
      PATH: `${bin}:/usr/bin:/bin`,
      pnpm_config_store_dir: join(tmp.path, 'store'),
      ...env,
    }),
    resolvePnpm: () => Promise.resolve(join(bin, 'pnpm')),
    ...(pnpmVersion === undefined ? {} : { pnpmVersion }),
    rules: () => [{ toolName: 'SandboxNetworkAccess', pattern: 'registry.npmjs.org' }],
    checkouts: () => [join(tmp.path, 'main')],
    timeoutMs,
  });
}

const LEFT_PAD_LOCKFILE =
  'importers:\n  .:\n    dependencies:\n      left-pad:\n        specifier: 1.3.0\n        version: 1.3.0\n';

/** A copy whose `left-pad` resolves, with a stale marker in `.pnpm` and the given `.modules.yaml`. */
function installedCopy(modulesYaml: string): void {
  writeFileSync(join(worktree, 'pnpm-lock.yaml'), LEFT_PAD_LOCKFILE);
  mkdirSync(join(worktree, 'node_modules/left-pad'), { recursive: true });
  mkdirSync(join(worktree, 'node_modules/.pnpm'), { recursive: true });
  writeFileSync(join(worktree, 'node_modules/.pnpm/stale'), '');
  writeFileSync(join(worktree, 'node_modules/.modules.yaml'), modulesYaml);
}

function refresh(deps: ReturnType<typeof dependencies>) {
  return deps.refresh({ batch, project, path: worktree, signal });
}

function withLockfileAndModules(): void {
  writeFileSync(join(worktree, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  mkdirSync(join(worktree, 'node_modules'));
}

describe('refreshing a worktree’s dependencies', () => {
  it.each([
    [
      'it has no pnpm lockfile',
      () => {
        mkdirSync(join(worktree, 'node_modules'));
      },
    ],
    [
      'the seed left no node_modules',
      () => {
        writeFileSync(join(worktree, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      },
    ],
  ])('runs nothing when %s', async (_name, arrange) => {
    fakePnpm();
    arrange();
    expect(await refresh(dependencies())).toEqual({ kind: 'skipped' });
    expect(existsSync(calls)).toBe(false);
    expect(requests).toEqual([]);
  });

  it('installs into a worktree with no node_modules when the cut skipped the seed', async () => {
    fakePnpm();
    writeFileSync(join(worktree, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    const result = await dependencies().refresh({
      batch,
      project,
      path: worktree,
      signal,
      seeded: false,
    });
    expect(result.kind).toBe('installed');
    expect(readFileSync(calls, 'utf8')).toContain('install --frozen-lockfile');
  });

  it('still runs nothing without a lockfile when the cut skipped the seed', async () => {
    fakePnpm();
    expect(
      await dependencies().refresh({ batch, project, path: worktree, signal, seeded: false }),
    ).toEqual({ kind: 'skipped' });
    expect(existsSync(calls)).toBe(false);
  });

  it('updates the lockfile instead of freezing it when asked for a dependency change', async () => {
    fakePnpm();
    withLockfileAndModules();
    const result = await dependencies().refresh({
      batch,
      project,
      path: worktree,
      signal,
      mode: 'update',
    });
    expect(result.kind).toBe('installed');
    const call = readFileSync(calls, 'utf8');
    expect(call).toContain('install --no-frozen-lockfile --ignore-scripts --ignore-pnpmfile');
    expect(call).not.toContain(' --frozen-lockfile');
    expect(requests[0]?.command).toBe(installCommand(join(bin, 'pnpm'), 'update'));
  });

  it('installs a worktree whose node_modules is missing the packages its lockfile names from nothing', async () => {
    fakePnpm();
    // A pruned install: node_modules exists, the lockfile's dependency does not resolve.
    writeFileSync(
      join(worktree, 'pnpm-lock.yaml'),
      'importers:\n  .:\n    dependencies:\n      left-pad:\n        specifier: 1.3.0\n        version: 1.3.0\n',
    );
    mkdirSync(join(worktree, 'node_modules/.pnpm/stale'), { recursive: true });
    writeFileSync(join(worktree, 'node_modules/.modules.yaml'), 'packageManager: pnpm@12.15.0\n');
    const result = await refresh(dependencies());
    expect(result).toMatchObject({ kind: 'installed', startedOver: true });
    expect(existsSync(join(worktree, 'node_modules/.modules.yaml'))).toBe(false);
    expect(existsSync(join(worktree, 'pnpm-lock.yaml'))).toBe(true);
  });

  it('installs from nothing over a node_modules whose packages all resolve, since it names another store', async () => {
    fakePnpm();
    writeFileSync(
      join(worktree, 'pnpm-lock.yaml'),
      'importers:\n  .:\n    dependencies:\n      left-pad:\n        specifier: 1.3.0\n        version: 1.3.0\n',
    );
    mkdirSync(join(worktree, 'node_modules/left-pad'), { recursive: true });
    writeFileSync(
      join(worktree, 'node_modules/.modules.yaml'),
      'packageManager: pnpm@12.9.1\nstoreDir: /private/tmp/10db-earlier/cache/pnpm-store/v11\n',
    );
    expect((await refresh(dependencies())).kind).toBe('installed');
    expect(existsSync(join(worktree, 'node_modules/.modules.yaml'))).toBe(false);
    expect(existsSync(join(worktree, 'pnpm-lock.yaml'))).toBe(true);
  });

  describe('a node_modules another pnpm made', () => {
    const stale = () => existsSync(join(worktree, 'node_modules/.pnpm/stale'));

    it('is removed, and installed from scratch, when .modules.yaml names another pnpm', async () => {
      fakePnpm();
      installedCopy('packageManager: pnpm@12.15.0\n');
      const result = await refresh(
        dependencies({}, 20_000, undefined, () => Promise.resolve('12.9.1')),
      );
      expect(result).toMatchObject({ kind: 'installed', startedOver: true });
      expect(stale()).toBe(false);
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
    });

    it('is left for pnpm to bring in line when it is the daemon’s pnpm', async () => {
      fakePnpm();
      installedCopy('packageManager: pnpm@12.9.1\n');
      const result = await refresh(
        dependencies({}, 20_000, undefined, () => Promise.resolve('12.9.1')),
      );
      expect(result).toMatchObject({ kind: 'installed', startedOver: false });
      expect(stale()).toBe(true);
    });

    it('is left alone when the daemon’s pnpm version cannot be read', async () => {
      fakePnpm();
      installedCopy('packageManager: pnpm@12.15.0\n');
      const result = await refresh(
        dependencies({}, 20_000, undefined, () => Promise.resolve(null)),
      );
      expect(result).toMatchObject({ kind: 'installed', startedOver: false });
      expect(stale()).toBe(true);
    });
  });

  it('leaves a copy whose .modules.yaml names another store for the install to take up', async () => {
    // Each sandboxed run has its own store under its temp dir, so every copy names a gone one.
    fakePnpm();
    installedCopy(
      'packageManager: pnpm@12.9.1\nstoreDir: /private/tmp/10db-gone/cache/pnpm-store/v11\n',
    );
    const result = await refresh(
      dependencies({}, 20_000, undefined, () => Promise.resolve('12.9.1')),
    );
    expect(result).toMatchObject({ kind: 'installed', startedOver: false });
    expect(existsSync(join(worktree, 'node_modules/.pnpm/stale'))).toBe(true);
  });

  it('says it started over only when it removed a node_modules', async () => {
    fakePnpm();
    // The cut skipped the seed: nothing was there to lose, though the lockfile's package is missing.
    writeFileSync(join(worktree, 'pnpm-lock.yaml'), LEFT_PAD_LOCKFILE);
    const result = await dependencies().refresh({
      batch,
      project,
      path: worktree,
      signal,
      seeded: false,
    });
    expect(result).toMatchObject({ kind: 'installed', startedOver: false });
  });

  describe('an install that fails part way', () => {
    /** Fails the first time, pruning `left-pad` as pnpm's half-removed install does; works the second. */
    function pnpmThatBreaksOnce(): void {
      const script = join(bin, 'pnpm');
      writeFileSync(
        script,
        [
          '#!/bin/sh',
          `printf '%s | %s\\n' "$PWD" "$*" >> '${calls}'`,
          `if [ "$(wc -l < '${calls}')" -le 1 ]; then`,
          '  rm -rf node_modules/left-pad node_modules/.pnpm/stale',
          '  echo "ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR: Operation not permitted"',
          '  exit 1',
          'fi',
          'mkdir -p node_modules/left-pad',
          'echo installed',
          '',
        ].join('\n'),
      );
      chmodSync(script, 0o755);
    }

    it('starts over with a fresh install in the same refresh when packages are left missing', async () => {
      pnpmThatBreaksOnce();
      installedCopy('packageManager: pnpm@12.9.1\n');
      // A marker only a leftover of the broken install would keep.
      writeFileSync(join(worktree, 'node_modules/.pnpm/leftover'), '');
      const result = await refresh(dependencies());
      expect(result).toMatchObject({ kind: 'installed', startedOver: true });
      expect(requests).toHaveLength(2);
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2);
      expect(existsSync(join(worktree, 'node_modules/left-pad'))).toBe(true);
      expect(existsSync(join(worktree, 'node_modules/.pnpm/leftover'))).toBe(false);
    });

    it('reports the second failure when the fresh install fails too', async () => {
      fakePnpm();
      installedCopy('packageManager: pnpm@12.9.1\n');
      // Always fails, and always leaves left-pad missing.
      writeFileSync(
        join(bin, 'pnpm'),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nrm -rf node_modules/left-pad\nexit 1\n`,
      );
      const result = await refresh(dependencies());
      expect(result).toMatchObject({ kind: 'failed', exitCode: 1 });
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2);
    });

    it('does not start over when the failed install left every package in place', async () => {
      fakePnpm();
      installedCopy('packageManager: pnpm@12.9.1\n');
      const result = await refresh(dependencies({ FAKE_PNPM_EXIT: '7' }));
      expect(result).toMatchObject({ kind: 'failed', exitCode: 7 });
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
      expect(existsSync(join(worktree, 'node_modules/.pnpm/stale'))).toBe(true);
    });
  });

  it('installs from the worktree’s own lockfile with scripts and the pnpmfile off', async () => {
    fakePnpm();
    withLockfileAndModules();
    const result = await refresh(dependencies({ FAKE_PNPM_SAYS: 'done' }));
    expect(result.kind).toBe('installed');
    expect(readFileSync(calls, 'utf8').trim()).toBe(
      `${realpathSync(worktree)} | install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --store-dir ${join(tmp.path, 'store')} --modules-dir node_modules --virtual-store-dir node_modules/.pnpm`,
    );
    if (result.kind !== 'installed') throw new Error('not installed');
    expect(readFileSync(result.logPath, 'utf8')).toContain('fake pnpm: done');
  });

  it('runs as a package install in the worktree, with the project’s own hosts and the checkouts', async () => {
    fakePnpm();
    withLockfileAndModules();
    await refresh(dependencies());
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      project: { repoPath: worktree, sandboxLoopback: true },
      command: installCommand(join(bin, 'pnpm')),
      packageInstall: true,
      rules: [{ toolName: 'SandboxNetworkAccess', pattern: 'registry.npmjs.org' }],
      checkouts: [join(tmp.path, 'main'), worktree],
      timeoutMs: 20_000,
    });
  });

  it('reports a failed install with its exit code, output and log', async () => {
    fakePnpm();
    withLockfileAndModules();
    const result = await refresh(
      dependencies({ FAKE_PNPM_EXIT: '7', FAKE_PNPM_SAYS: 'registry 403' }),
    );
    expect(result).toMatchObject({
      kind: 'failed',
      exitCode: 7,
      timedOut: false,
    });
    if (result.kind !== 'failed') throw new Error('not failed');
    expect(result.tail).toContain('registry 403');
  });

  it('reports the hosts the sandbox blocked a failed install from', async () => {
    fakePnpm();
    withLockfileAndModules();
    // The gate runner reads the hosts from the sandbox's stderr; this one reports them as it would.
    const blocked: GateRunner = {
      run: (request) =>
        Promise.resolve({
          exitCode: 1,
          durationMs: 1,
          tail: 'ERR_PNPM_META_FETCH_FAIL',
          logPath: request.logPath,
          timedOut: false,
          aborted: false,
          blockedHosts: ['registry.npmjs.org'],
        }),
    };
    const deps = createWorktreeDependencies({
      gate: blocked,
      clock: new ManualClock(),
      dataDir: join(tmp.path, 'data'),
      sessionEnv: () => ({ PATH: `${bin}:/usr/bin:/bin` }),
      resolvePnpm: () => Promise.resolve(join(bin, 'pnpm')),
      rules: () => [],
      checkouts: () => [],
      timeoutMs: 20_000,
    });
    expect(await refresh(deps)).toMatchObject({
      kind: 'failed',
      exitCode: 1,
      blockedHosts: ['registry.npmjs.org'],
    });
  });

  it('reports an install that outlives its limit as timed out', async () => {
    withLockfileAndModules();
    writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nsleep 30\n');
    chmodSync(join(bin, 'pnpm'), 0o755);
    expect(await refresh(dependencies({}, 200))).toMatchObject({ kind: 'failed', timedOut: true });
  });

  it('reports a shutdown as aborted, not as a failed install', async () => {
    withLockfileAndModules();
    writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nsleep 30\n');
    chmodSync(join(bin, 'pnpm'), 0o755);
    const stop = new AbortController();
    // Shutdown arrives as the install is handed to the gate.
    const deps = dependencies({}, 20_000, () => {
      stop.abort();
    });
    const result = await deps.refresh({ batch, project, path: worktree, signal: stop.signal });
    expect(result).toEqual({ kind: 'aborted' });
  });

  it('fails, saying why, when no pnpm outside the checkouts can be found', async () => {
    fakePnpm();
    withLockfileAndModules();
    const deps = createWorktreeDependencies({
      gate: createGateRunner({ sandbox: null, logger: silentLogger }),
      clock: new ManualClock(),
      dataDir: join(tmp.path, 'data'),
      sessionEnv: () => ({ PATH: bin }),
      rules: () => [],
      checkouts: () => [],
      timeoutMs: 20_000,
      // The only pnpm on PATH lies in a checkout.
      resolvePnpm: (env, checkouts) => resolvePnpm(env, [...checkouts, bin]),
    });
    const result = await refresh(deps);
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.tail).toContain('No trustworthy pnpm');
    expect(result.blockedHosts).toEqual([]);
    expect(existsSync(calls)).toBe(false);
  });

  // The real pnpm: what a repository's own files must not decide.
  // A real install needs pnpm's store lock, which a sandboxed gate (this suite run by 10db) can't open.
  // It also needs a standalone pnpm program; an npm-global or corepack pnpm is a script, which is refused.
  it.skipIf(SANDBOXED || STANDALONE_PNPM === null)(
    'runs the builder’s pnpm and writes only where the daemon says, whatever the repository asks',
    async () => {
      writeFileSync(
        join(worktree, 'package.json'),
        '{"name":"pj","version":"1.0.0","packageManager":"pnpm@9.0.0"}\n',
      );
      writeFileSync(
        join(worktree, 'pnpm-lock.yaml'),
        "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n",
      );
      mkdirSync(join(worktree, 'node_modules'));
      const evil = join(tmp.path, 'evil');
      writeFileSync(
        join(worktree, '.npmrc'),
        `store-dir=${evil}/store\nmodules-dir=evil_modules\nvirtual-store-dir=evil_virtual\n`,
      );
      const store = join(tmp.path, 'store');
      const env = Object.fromEntries(
        Object.entries(process.env).flatMap(([k, v]) =>
          v === undefined || k.startsWith('pnpm_config_') ? [] : [[k, v]],
        ),
      );
      const deps = createWorktreeDependencies({
        gate: createGateRunner({ sandbox: null, logger: silentLogger }),
        clock: new ManualClock(),
        dataDir: join(tmp.path, 'data'),
        sessionEnv: () => ({ ...env, pnpm_config_store_dir: store }),
        rules: () => [],
        checkouts: () => [worktree],
        timeoutMs: 60_000,
        resolvePnpm,
      });
      const result = await refresh(deps);
      expect(result.kind, JSON.stringify(result)).toBe('installed');
      if (result.kind !== 'installed') return;
      // Not the pnpm the package.json pins, and not the repository's store or directories.
      expect(readFileSync(result.logPath, 'utf8')).not.toContain('9.0.0');
      expect(readdirSync(store).length).toBeGreaterThan(0);
      expect(existsSync(evil)).toBe(false);
      expect(existsSync(join(worktree, 'evil_modules'))).toBe(false);
      expect(existsSync(join(worktree, 'evil_virtual'))).toBe(false);
      expect(existsSync(join(worktree, 'node_modules', '.modules.yaml'))).toBe(true);
    },
    90_000,
  );
});

describe('raiseInstallHostCards', () => {
  it('names the file and recommends Allow for a project added before readings', async () => {
    const remote = createTempRepoWithOrigin();
    const repo = remote.repo;
    const { store, close } = createTestStore();
    try {
      const repoGit = (...args: string[]) =>
        execFileSync('git', ['-C', repo.path, ...args], { env: isolatedGitEnv(), stdio: 'pipe' });
      mkdirSync(join(repo.path, 'apps/desktop/src-tauri'), { recursive: true });
      writeFileSync(
        join(repo.path, 'apps/desktop/src-tauri/Cargo.lock'),
        'source = "registry+https://github.com/rust-lang/crates.io-index"\n',
      );
      repoGit('add', 'apps');
      repoGit('commit', '-q', '-m', 'lock');
      // A reading takes only origin's copy of the default branch, which a lane can't move.
      repoGit('push', '-q', 'origin', 'main');
      const state = createStateStore(store, createEventBus());
      const inbox = createInboxService({ state, onParkedAnswer: () => undefined });
      const seeded = seedProject(store, { repoPath: repo.path, delivery: 'pull_request' });
      // No reading was ever kept, as for a project added before 10db kept readings.
      state.write((ctx) => {
        deleteAppSetting(ctx, `network-hosts-found:${seeded.id}`);
      });

      await raiseInstallHostCards(
        { state, inbox, git: createGit(), logger: silentLogger },
        seeded.id,
        {
          kind: 'failed',
          exitCode: 1,
          tail: 'error',
          logPath: '/dev/null',
          timedOut: false,
          blockedHosts: ['index.crates.io'],
        },
      );

      const [card, ...rest] = listInbox(state.db, { states: ['OPEN'] });
      expect(rest).toEqual([]);
      expect(card?.body).toContain(
        "The project's apps/desktop/src-tauri/Cargo.lock needs index.crates.io",
      );
      expect(card?.recommendation).toBe('Allow for the project');
      expect(listNetworkHosts(state.db, seeded.id)).toEqual([]);
    } finally {
      close();
      remote.cleanup();
    }
  });
});
