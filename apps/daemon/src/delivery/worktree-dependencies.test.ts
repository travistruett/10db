import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { mintId, type BatchDto, type ProjectDto } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SANDBOXED, tempDir, type TempDir } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { silentLogger } from '../log';
import { createGateRunner, type GateRequest, type GateRunner } from '../verify';
import { resolvePnpm } from './pnpm-binary';
import { createWorktreeDependencies, installCommand } from './worktree-dependencies';

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
    rules: () => [{ toolName: 'SandboxNetworkAccess', pattern: 'registry.npmjs.org' }],
    checkouts: () => [join(tmp.path, 'main')],
    timeoutMs,
  });
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
