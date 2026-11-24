import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { mintId, type ProjectDto } from '@10db/contracts';
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
import { createNodeModulesTemplates, templateKey, templatesRoot } from './node-modules-template';
import { readPnpmVersion, resolvePnpm } from './pnpm-binary';
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
const owner = { kind: 'batch', id: mintId('Batch') } as const;
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
    copyIdOf: () => null,
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

/** An empty copy, with no pnpm calls or gate requests yet: where each case of a looped test starts. */
function freshCopy(): void {
  rmSync(worktree, { recursive: true, force: true });
  mkdirSync(worktree);
  rmSync(calls, { force: true });
  requests = [];
}

function refresh(deps: ReturnType<typeof dependencies>) {
  return deps.refresh({ owner, project, path: worktree, signal });
}

function withLockfileAndModules(): void {
  writeFileSync(join(worktree, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  mkdirSync(join(worktree, 'node_modules'));
}

describe('refreshing a worktree’s dependencies', () => {
  it('runs nothing without a pnpm lockfile, or when the seed left no node_modules, and installs when the cut skipped the seed', async () => {
    fakePnpm();
    const deps = dependencies();
    const lockfile = join(worktree, 'pnpm-lock.yaml');
    const modules = join(worktree, 'node_modules');
    const cases: { name: string; arrange: () => void; seeded?: false }[] = [
      {
        name: 'the cut skipped the seed and there is no lockfile',
        arrange: () => undefined,
        seeded: false,
      },
      {
        name: 'there is no pnpm lockfile',
        arrange: () => {
          mkdirSync(modules);
        },
      },
      {
        name: 'the seed left no node_modules',
        arrange: () => {
          rmSync(modules, { recursive: true });
          writeFileSync(lockfile, 'lockfileVersion: 9\n');
        },
      },
    ];
    for (const { name, arrange, seeded } of cases) {
      arrange();
      expect
        .soft(
          await deps.refresh({
            owner,
            project,
            path: worktree,
            signal,
            ...(seeded === undefined ? {} : { seeded }),
          }),
          name,
        )
        .toEqual({ kind: 'skipped' });
      expect.soft(existsSync(calls), name).toBe(false);
      expect.soft(requests, name).toEqual([]);
    }

    // The same copy, a lockfile and no node_modules, when the cut skipped the seed.
    const result = await deps.refresh({ owner, project, path: worktree, signal, seeded: false });
    expect(result.kind).toBe('installed');
    expect(readFileSync(calls, 'utf8')).toContain('install --frozen-lockfile');
  });

  describe('a node_modules the copy already has', () => {
    const stale = () => existsSync(join(worktree, 'node_modules/.pnpm/stale'));
    const modulesYaml = () => existsSync(join(worktree, 'node_modules/.modules.yaml'));
    const lockfile = () => existsSync(join(worktree, 'pnpm-lock.yaml'));
    const callCount = () => readFileSync(calls, 'utf8').trim().split('\n').length;
    const daemonPnpm = (version: string | null) =>
      dependencies({}, 20_000, undefined, () => Promise.resolve(version));

    interface Case {
      name: string;
      arrange: () => void;
      deps: () => ReturnType<typeof dependencies>;
      check: (result: Awaited<ReturnType<typeof refresh>>, name: string) => void;
    }

    /** Runs each case on a fresh copy and a fresh call log. */
    async function each(cases: Case[]): Promise<void> {
      fakePnpm();
      for (const { name, arrange, deps, check } of cases) {
        freshCopy();
        arrange();
        check(await refresh(deps()), name);
      }
    }

    it('is removed and installed from scratch when it is broken, names another store or pnpm, or its .modules.yaml cannot be read', async () => {
      await each([
        {
          name: 'the packages its lockfile names are missing',
          arrange: () => {
            // A pruned install: node_modules exists, the lockfile's dependency does not resolve.
            writeFileSync(join(worktree, 'pnpm-lock.yaml'), LEFT_PAD_LOCKFILE);
            mkdirSync(join(worktree, 'node_modules/.pnpm/stale'), { recursive: true });
            writeFileSync(
              join(worktree, 'node_modules/.modules.yaml'),
              'packageManager: pnpm@12.15.0\n',
            );
          },
          deps: () => dependencies(),
          check: (result, name) => {
            expect.soft(result, name).toMatchObject({ kind: 'installed', startedOver: true });
            expect.soft(modulesYaml(), name).toBe(false);
            expect.soft(lockfile(), name).toBe(true);
          },
        },
        {
          name: 'its packages all resolve, but it names another store',
          arrange: () => {
            writeFileSync(join(worktree, 'pnpm-lock.yaml'), LEFT_PAD_LOCKFILE);
            mkdirSync(join(worktree, 'node_modules/left-pad'), { recursive: true });
            writeFileSync(
              join(worktree, 'node_modules/.modules.yaml'),
              'packageManager: pnpm@12.9.1\nstoreDir: /private/tmp/10db-earlier/cache/pnpm-store/v11\n',
            );
          },
          deps: () => dependencies(),
          check: (result, name) => {
            expect.soft(result.kind, name).toBe('installed');
            expect.soft(modulesYaml(), name).toBe(false);
            expect.soft(lockfile(), name).toBe(true);
          },
        },
        {
          name: '.modules.yaml cannot be read: the log says so, not that it names another store',
          arrange: () => {
            installedCopy('storeDir: [unclosed\n');
          },
          deps: () => dependencies({ pnpm_config_store_dir: '/tmp/10db-now/store' }),
          check: (result, name) => {
            expect.soft(result, name).toMatchObject({ kind: 'installed', startedOver: true });
            if (result.kind !== 'installed') return;
            const text = readFileSync(result.logPath, 'utf8');
            expect.soft(text, name).toContain('node_modules/.modules.yaml could not be read');
            expect.soft(text, name).not.toContain('names a pnpm store');
          },
        },
        {
          name: '.modules.yaml names another pnpm',
          arrange: () => {
            installedCopy('packageManager: pnpm@12.15.0\n');
          },
          deps: () => daemonPnpm('12.9.1'),
          check: (result, name) => {
            expect.soft(result, name).toMatchObject({ kind: 'installed', startedOver: true });
            expect.soft(stale(), name).toBe(false);
            expect.soft(callCount(), name).toBe(1);
          },
        },
      ]);
    });

    it('is left for pnpm to bring in line when it is the daemon’s pnpm, or the daemon’s pnpm version cannot be read', async () => {
      await each([
        {
          name: 'the daemon’s own pnpm',
          arrange: () => {
            installedCopy('packageManager: pnpm@12.9.1\n');
          },
          deps: () => daemonPnpm('12.9.1'),
          check: (result, name) => {
            expect.soft(result, name).toMatchObject({ kind: 'installed', startedOver: false });
            expect.soft(stale(), name).toBe(true);
          },
        },
        {
          name: 'the daemon’s pnpm version cannot be read',
          arrange: () => {
            installedCopy('packageManager: pnpm@12.15.0\n');
          },
          deps: () => daemonPnpm(null),
          check: (result, name) => {
            expect.soft(result, name).toMatchObject({ kind: 'installed', startedOver: false });
            expect.soft(stale(), name).toBe(true);
          },
        },
      ]);
    });
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

    it('starts over once with a fresh install when the failed install left packages missing, and only then', async () => {
      const callCount = () => readFileSync(calls, 'utf8').trim().split('\n').length;
      const cases: {
        name: string;
        pnpm: () => void;
        refresh: () => ReturnType<typeof refresh>;
        check: (result: Awaited<ReturnType<typeof refresh>>, name: string) => void;
      }[] = [
        {
          name: 'the fresh install works',
          pnpm: pnpmThatBreaksOnce,
          refresh: () => {
            // A marker only a leftover of the broken install would keep.
            writeFileSync(join(worktree, 'node_modules/.pnpm/leftover'), '');
            return refresh(dependencies());
          },
          check: (result, name) => {
            expect.soft(result, name).toMatchObject({ kind: 'installed', startedOver: true });
            expect.soft(requests, name).toHaveLength(2);
            expect.soft(callCount(), name).toBe(2);
            expect.soft(existsSync(join(worktree, 'node_modules/left-pad')), name).toBe(true);
            expect
              .soft(existsSync(join(worktree, 'node_modules/.pnpm/leftover')), name)
              .toBe(false);
          },
        },
        {
          name: 'the fresh install fails too: its failure is reported',
          // Always fails, and always leaves left-pad missing.
          pnpm: () => {
            fakePnpm();
            writeFileSync(
              join(bin, 'pnpm'),
              `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nrm -rf node_modules/left-pad\nexit 1\n`,
            );
          },
          refresh: () => refresh(dependencies()),
          check: (result, name) => {
            expect.soft(result, name).toMatchObject({ kind: 'failed', exitCode: 1 });
            expect.soft(callCount(), name).toBe(2);
          },
        },
        {
          name: 'the failed install was already the start over the caller asked for',
          pnpm: () => {
            fakePnpm();
            writeFileSync(
              join(bin, 'pnpm'),
              `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 1\n`,
            );
          },
          refresh: () =>
            dependencies().refresh({ owner, project, path: worktree, signal, startOver: true }),
          check: (result, name) => {
            expect.soft(result, name).toMatchObject({ kind: 'failed', exitCode: 1 });
            expect.soft(callCount(), name).toBe(1);
          },
        },
        {
          name: 'the failed install left every package in place',
          pnpm: fakePnpm,
          refresh: () => refresh(dependencies({ FAKE_PNPM_EXIT: '7' })),
          check: (result, name) => {
            expect.soft(result, name).toMatchObject({ kind: 'failed', exitCode: 7 });
            expect.soft(callCount(), name).toBe(1);
            expect.soft(existsSync(join(worktree, 'node_modules/.pnpm/stale')), name).toBe(true);
          },
        },
      ];
      for (const { name, pnpm, refresh: run, check } of cases) {
        freshCopy();
        pnpm();
        installedCopy('packageManager: pnpm@12.9.1\n');
        check(await run(), name);
      }
    });
  });

  it('installs from the worktree’s own lockfile with scripts and the pnpmfile off, as a package install with the project’s own hosts and the checkouts, and updates the lockfile when asked for a dependency change', async () => {
    fakePnpm();
    withLockfileAndModules();
    const deps = dependencies({ FAKE_PNPM_SAYS: 'done' });
    const result = await refresh(deps);
    expect(result.kind).toBe('installed');
    expect(readFileSync(calls, 'utf8').trim()).toBe(
      `${realpathSync(worktree)} | install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --store-dir ${join(tmp.path, 'store')} --modules-dir node_modules --virtual-store-dir node_modules/.pnpm`,
    );
    if (result.kind !== 'installed') throw new Error('not installed');
    expect(readFileSync(result.logPath, 'utf8')).toContain('fake pnpm: done');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      project: { repoPath: worktree, sandboxLoopback: true },
      command: installCommand(join(bin, 'pnpm')),
      packageInstall: true,
      rules: [{ toolName: 'SandboxNetworkAccess', pattern: 'registry.npmjs.org' }],
      checkouts: [join(tmp.path, 'main'), worktree],
      timeoutMs: 20_000,
    });

    // A dependency change: the lockfile is updated, not frozen.
    const update = await deps.refresh({ owner, project, path: worktree, signal, mode: 'update' });
    expect(update.kind).toBe('installed');
    const call = readFileSync(calls, 'utf8').trim().split('\n').at(-1);
    expect(call).toContain('install --no-frozen-lockfile --ignore-scripts --ignore-pnpmfile');
    expect(call).not.toContain(' --frozen-lockfile');
    expect(requests[1]?.command).toBe(installCommand(join(bin, 'pnpm'), 'update'));
  });

  it('reports a failed install with its exit code, output and log, the hosts the sandbox blocked it from, and one that outlives its limit as timed out', async () => {
    fakePnpm();
    withLockfileAndModules();
    const failed = await refresh(
      dependencies({ FAKE_PNPM_EXIT: '7', FAKE_PNPM_SAYS: 'registry 403' }),
    );
    expect(failed).toMatchObject({
      kind: 'failed',
      exitCode: 7,
      timedOut: false,
    });
    if (failed.kind !== 'failed') throw new Error('not failed');
    expect(failed.tail).toContain('registry 403');

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
      copyIdOf: () => null,
    });
    expect(await refresh(deps)).toMatchObject({
      kind: 'failed',
      exitCode: 1,
      blockedHosts: ['registry.npmjs.org'],
    });

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
    const result = await deps.refresh({ owner, project, path: worktree, signal: stop.signal });
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
      copyIdOf: () => null,
      // The only pnpm on PATH lies in a checkout.
      resolvePnpm: (env, checkouts) => resolvePnpm(env, [...checkouts, bin]),
    });
    const result = await refresh(deps);
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.tail).toContain('No trustworthy pnpm');
    expect(result.blockedHosts).toEqual([]);
    expect(existsSync(calls)).toBe(false);
    // No install ran and nothing was removed.
    expect(result).toMatchObject({ installs: 0, startedOver: false });
    expect(existsSync(join(worktree, 'node_modules'))).toBe(true);
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
        copyIdOf: () => null,
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

  it.skipIf(SANDBOXED || STANDALONE_PNPM === null)(
    'makes a template of a real pnpm workspace install, and a clone of it resolves in another copy',
    async () => {
      const files: Record<string, string> = {
        'package.json': '{"name":"root","private":true}\n',
        'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
        'packages/lib/package.json': '{"name":"lib","version":"1.0.0","main":"index.js"}\n',
        'packages/lib/index.js': 'module.exports = 1;\n',
        'packages/app/package.json': '{"name":"app","dependencies":{"lib":"workspace:*"}}\n',
        'pnpm-lock.yaml': [
          "lockfileVersion: '9.0'",
          '',
          'importers:',
          '',
          '  .: {}',
          '',
          '  packages/app:',
          '    dependencies:',
          '      lib:',
          '        specifier: workspace:*',
          '        version: link:../lib',
          '',
          '  packages/lib: {}',
          '',
        ].join('\n'),
      };
      const other = join(tmp.path, 'other');
      for (const at of [worktree, other])
        for (const [relative, content] of Object.entries(files)) {
          mkdirSync(dirname(join(at, relative)), { recursive: true });
          writeFileSync(join(at, relative), content);
        }
      const env = Object.fromEntries(
        Object.entries(process.env).flatMap(([k, v]) =>
          v === undefined || k.startsWith('pnpm_config_') ? [] : [[k, v]],
        ),
      );
      const deps = createWorktreeDependencies({
        gate: createGateRunner({ sandbox: null, logger: silentLogger }),
        clock: new ManualClock(),
        dataDir: join(tmp.path, 'data'),
        sessionEnv: () => ({ ...env, pnpm_config_store_dir: join(tmp.path, 'store') }),
        rules: () => [],
        checkouts: () => [worktree, other],
        timeoutMs: 60_000,
        copyIdOf: () => null,
        resolvePnpm,
        pnpmVersion: readPnpmVersion,
        templates: createNodeModulesTemplates({
          root: templatesRoot(join(tmp.path, 'data')),
          logger: silentLogger,
        }),
      });
      const made = await deps.refresh({
        owner,
        project,
        path: worktree,
        signal,
        seeded: false,
        makeTemplate: true,
      });
      expect(made.kind, JSON.stringify(made)).toBe('installed');
      expect(readdirSync(templatesRoot(join(tmp.path, 'data')))).toHaveLength(1);
      const cloned = await deps.refresh({ owner, project, path: other, signal, seeded: false });
      expect(cloned).toMatchObject({ kind: 'installed', fromTemplate: true, installs: 0 });
      const resolved = createRequire(join(other, 'packages/app/package.json')).resolve('lib');
      expect(realpathSync(resolved)).toBe(realpathSync(join(other, 'packages/lib/index.js')));
    },
    90_000,
  );
});

describe('a copy’s node_modules from a template', () => {
  const VERSION = '10.0.0';
  const root = (): string => templatesRoot(join(tmp.path, 'data'));

  function withTemplates() {
    const real = createGateRunner({ sandbox: null, logger: silentLogger });
    return createWorktreeDependencies({
      gate: {
        run: (request) => {
          requests.push(request);
          return real.run(request);
        },
      },
      clock: new ManualClock(),
      dataDir: join(tmp.path, 'data'),
      sessionEnv: () => ({ PATH: `${bin}:/usr/bin:/bin`, pnpm_config_store_dir: 'store' }),
      resolvePnpm: () => Promise.resolve(join(bin, 'pnpm')),
      pnpmVersion: () => Promise.resolve(VERSION),
      rules: () => [],
      checkouts: () => [worktree],
      timeoutMs: 20_000,
      copyIdOf: () => null,
      templates: createNodeModulesTemplates({ root: root(), logger: silentLogger }),
    });
  }

  /** A template made from another copy with the same lockfile, its `left-pad` installed. */
  async function templateOfLeftPad(): Promise<string> {
    const made = join(tmp.path, 'made');
    mkdirSync(join(made, 'node_modules/left-pad'), { recursive: true });
    writeFileSync(join(made, 'node_modules/left-pad/index.js'), 'module.exports = 1;\n');
    writeFileSync(join(made, 'pnpm-lock.yaml'), LEFT_PAD_LOCKFILE);
    const key = templateKey(made, VERSION);
    if (key === null) throw new Error('no key');
    await createNodeModulesTemplates({ root: root(), logger: silentLogger }).capture({
      key,
      path: made,
    });
    expect(existsSync(join(root(), key))).toBe(true);
    return key;
  }

  const unseeded = (deps: ReturnType<typeof withTemplates>, extra: object = {}) =>
    deps.refresh({ owner, project, path: worktree, signal, seeded: false, ...extra });

  it('never clones for a dependency change or a start over, and clones a template whose lockfile matches otherwise, running no install', async () => {
    fakePnpm();
    const key = await templateOfLeftPad();
    for (const [name, extra] of [
      ['a dependency change', { mode: 'update' }],
      ['a start over', { startOver: true }],
    ] as const) {
      freshCopy();
      writeFileSync(join(worktree, 'pnpm-lock.yaml'), LEFT_PAD_LOCKFILE);
      const installed = await unseeded(withTemplates(), extra);
      expect.soft(installed, name).toMatchObject({ kind: 'installed', installs: 1 });
      expect.soft(requests, name).toHaveLength(1);
      expect.soft(existsSync(join(root(), key)), name).toBe(true);
    }

    freshCopy();
    writeFileSync(join(worktree, 'pnpm-lock.yaml'), LEFT_PAD_LOCKFILE);
    const result = await unseeded(withTemplates());
    expect(result).toMatchObject({
      kind: 'installed',
      fromTemplate: true,
      installs: 0,
      startedOver: false,
    });
    expect(requests).toEqual([]);
    expect(existsSync(calls)).toBe(false);
    expect(readFileSync(join(worktree, 'node_modules/left-pad/index.js'), 'utf8')).toBe(
      'module.exports = 1;\n',
    );
    if (result.kind === 'installed')
      expect(readFileSync(result.logPath, 'utf8')).toContain('no install ran');
  });

  it('installs as before, and removes the template, when there is none, its marker is missing, or its tree lacks a package or is unreadable', async () => {
    const damages: [string, (template: string) => void][] = [
      [
        'there is no template',
        (template) => {
          rmSync(template, { recursive: true });
        },
      ],
      [
        'its marker is missing',
        (template) => {
          rmSync(join(template, 'template.json'));
        },
      ],
      [
        'its tree lacks a package',
        (template) => {
          rmSync(join(template, 'tree/node_modules/left-pad'), { recursive: true });
        },
      ],
      [
        'its tree is unreadable',
        (template) => {
          chmodSync(join(template, 'tree'), 0o000);
        },
      ],
    ];
    fakePnpm();
    for (const [name, damage] of damages) {
      freshCopy();
      const key = await templateOfLeftPad();
      damage(join(root(), key));
      writeFileSync(join(worktree, 'pnpm-lock.yaml'), LEFT_PAD_LOCKFILE);
      const result = await unseeded(withTemplates());
      expect.soft(result, name).toMatchObject({ kind: 'installed', installs: 1 });
      expect.soft(result, name).not.toHaveProperty('fromTemplate');
      expect.soft(requests, name).toHaveLength(1);
      expect.soft(existsSync(join(root(), key)), name).toBe(false);
    }
  });

  it('makes a template of a whole install when asked, and sweeps one no copy uses', async () => {
    fakePnpm();
    mkdirSync(join(root(), 'stale', 'tree'), { recursive: true });
    writeFileSync(join(worktree, 'pnpm-lock.yaml'), LEFT_PAD_LOCKFILE);
    // What the install would have made: the fake pnpm makes nothing.
    mkdirSync(join(worktree, 'node_modules/left-pad'), { recursive: true });
    const deps = withTemplates();
    expect(await unseeded(deps)).toMatchObject({ kind: 'installed', installs: 1 });
    expect(readdirSync(root())).toEqual(['stale']);
    expect(await unseeded(deps, { makeTemplate: true })).toMatchObject({
      kind: 'installed',
      installs: 1,
    });
    expect(readdirSync(root())).toEqual([templateKey(worktree, VERSION)]);
  });
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
          installs: 1,
          startedOver: false,
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
