import {
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  BenchmarkStatusDto,
  BoardColumnDto,
  EventsHead,
  FolderInspectResult,
  InboxItemDto,
  KeepAwakeStatus,
  McpServerStatusDto,
  mintId,
  ModelProfileDto,
  PersonaDto,
  PickerProposalDto,
  ProjectDto,
  StepPlanDto,
  TaskDto,
  WorkstreamDto,
  SystemCheckDto,
  WorkstreamId,
} from '@10db/contracts';
import {
  findModelProfile,
  getAccount,
  getWorkstream,
  listAccountModels,
  listAccounts,
  patchAccount,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CATALOGUE_URL } from '../catalogue';
import { z } from 'zod';
import { WebSocket } from 'ws';
import { apiClient, quickFlowId } from '../../test/api-client';
import { readModelsDevFixture } from '../../test/models-dev-fixture';
import { seedProfiles } from '../../test/seed-profiles';
import { FakeGh } from '../../test/fake-gh';
import {
  createTempRepo,
  FAKE_SRT,
  isolatedGitEnv,
  SANDBOXED,
  tempDir,
  waitFor,
  waitForAsync,
} from '../../test/fixtures';
import { ManualClock } from '../clock';
import { loadEnv } from '../env';
import { CODEX_VERIFIED_ON, type AgentStatus, type ResolvedTools } from '../environment';
import type { CaffeinateSpawner } from '../keep-awake';
import { FakeAdapter, type FakeScriptBook, type LaneSessionSpec } from '../sessions';
import {
  AlreadyRunningError,
  aaKeyReaderFromEnv,
  readRuntimeInfo,
  startDaemon,
  type RunningDaemon,
} from './index';
import { WorktreeRootError, worktreeRootFor } from './worktree-root';
import { startDaemonWithProfiles } from '../../test/daemon-with-profiles';

/** No real caffeinate and no file watcher in daemon tests that are not about them. */
const QUIET = { caffeinate: () => null, watch: false } as const;

let dir: { path: string; cleanup(): void };
let daemon: RunningDaemon | null;
beforeEach(() => {
  dir = tempDir('daemon');
  daemon = null;
});
afterEach(async () => {
  await daemon?.stop();
  dir.cleanup();
});

describe('startDaemon', () => {
  it('serves health, writes runtime files with a private token, and refuses a second instance', async () => {
    daemon = await startDaemon({
      sandbox: null,
      dataDir: dir.path,
      port: 0,
      adapter: new FakeAdapter({}),
      logLevel: 'warn',
      ...QUIET,
    });
    const health = await fetch(`${daemon.url}/health`);
    expect(health.status).toBe(200);
    expect(readRuntimeInfo(dir.path)).toMatchObject({ port: daemon.port, pid: process.pid });
    expect(statSync(join(dir.path, 'ui-token')).mode & 0o777).toBe(0o600);
    const projects = await fetch(`${daemon.url}/projects`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    expect(await projects.json()).toEqual([]);
    await expect(
      startDaemon({
        sandbox: null,
        dataDir: dir.path,
        port: 0,
        adapter: new FakeAdapter({}),
        logLevel: 'warn',
        ...QUIET,
      }),
    ).rejects.toThrow(AlreadyRunningError);
  });

  it('answers 409 for a second project on the same repository', async () => {
    const repo = createTempRepo();
    try {
      daemon = await startDaemon({
        sandbox: null,
        dataDir: dir.path,
        port: 0,
        adapter: new FakeAdapter({}),
        logLevel: 'warn',
        ...QUIET,
      });
      const body = JSON.stringify({
        name: 'demo',
        repoPath: repo.path,
        gateCommand: 'true',
        areas: [{ name: 'src', globs: ['src/**'] }],
      });
      const post = () =>
        fetch(`${daemon?.url ?? ''}/projects`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${daemon?.token ?? ''}`,
            'content-type': 'application/json',
          },
          body,
        });
      expect((await post()).status).toBe(201);
      expect((await post()).status).toBe(409);
    } finally {
      repo.cleanup();
    }
  });

  it('answers 400 for a project whose path is not a git repository', async () => {
    daemon = await startDaemon({
      sandbox: null,
      dataDir: dir.path,
      port: 0,
      adapter: new FakeAdapter({}),
      logLevel: 'warn',
      ...QUIET,
    });
    const res = await fetch(`${daemon.url}/projects`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'demo',
        repoPath: dir.path,
        gateCommand: 'true',
        areas: [{ name: 'src', globs: ['src/**'] }],
      }),
    });
    expect(res.status).toBe(400);
  });

  describe('the worktree root', () => {
    const project = (repoPath: string) =>
      JSON.stringify({
        name: 'demo',
        repoPath,
        gateCommand: 'true',
        areas: [{ name: 'src', globs: ['src/**'] }],
      });
    const post = (running: RunningDaemon, body: string) =>
      fetch(`${running.url}/projects`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${running.token}`, 'content-type': 'application/json' },
        body,
      });
    const options = (worktreeRoot: string) =>
      ({
        sandbox: null,
        dataDir: dir.path,
        port: 0,
        adapter: new FakeAdapter({}),
        logLevel: 'warn',
        worktreeRoot,
        ...QUIET,
      }) as const;

    it('refuses to start when the worktree root lies inside a registered checkout', async () => {
      const repo = createTempRepo();
      try {
        daemon = await startDaemon(options(tempDir('wt').path));
        expect((await post(daemon, project(repo.path))).status).toBe(201);
        await daemon.stop();
        daemon = null;
        await expect(startDaemon(options(join(repo.path, '.wt')))).rejects.toThrow(
          WorktreeRootError,
        );
        // The refused start released the instance lock and the database.
        daemon = await startDaemon(options(tempDir('wt').path));
      } finally {
        repo.cleanup();
      }
    });

    it('answers 400 for a checkout the worktree root lies under', async () => {
      const repo = createTempRepo();
      try {
        daemon = await startDaemon(options(join(repo.path, '.wt')));
        const res = await post(daemon, project(repo.path));
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('worktree root');
      } finally {
        repo.cleanup();
      }
    });

    it('answers 400 for a checkout that lies under the worktree root', async () => {
      const base = tempDir('wt');
      const root = worktreeRootFor(base.path, dir.path);
      const inside = join(root, 'repo');
      mkdirSync(inside, { recursive: true });
      execFileSync('git', ['-C', inside, 'init', '-q', '-b', 'main'], {
        env: isolatedGitEnv(),
        stdio: 'pipe',
      });
      try {
        daemon = await startDaemon(options(base.path));
        const res = await post(daemon, project(inside));
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('worktree root');
      } finally {
        base.cleanup();
      }
    });
  });

  it('stops while a UI client is still connected to the event stream', async () => {
    const running = await startDaemon({
      sandbox: null,
      dataDir: dir.path,
      port: 0,
      adapter: new FakeAdapter({}),
      logLevel: 'warn',
      ...QUIET,
    });
    const client = new WebSocket(
      `ws://127.0.0.1:${String(running.port)}/events/stream?after=0&token=${running.token}`,
    );
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });
    const outcome = await Promise.race([
      running.stop().then(() => 'stopped'),
      new Promise<string>((r) =>
        setTimeout(() => {
          r('hung');
        }, 3000),
      ),
    ]);
    expect(outcome).toBe('stopped');
  });

  it('runs one shutdown however often stop is called (SIGINT, then SIGTERM, then later)', async () => {
    const running = await startDaemon({
      sandbox: null,
      dataDir: dir.path,
      port: 0,
      adapter: new FakeAdapter({}),
      logLevel: 'warn',
      ...QUIET,
    });
    const first = running.stop();
    const second = running.stop();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    await expect(running.stop()).resolves.toBeUndefined();
    expect(() => readRuntimeInfo(dir.path)).toThrow();
    expect(existsSync(join(dir.path, 'daemon.lock'))).toBe(false);
  });

  it("records the default account's identity from its first probe, then runs the task", async () => {
    const repo = createTempRepo();
    try {
      // A fresh data directory: the default account is seeded with no identity; the fake's probe reports builder@example.com.
      const adapter = new FakeAdapter({ Alpha: [[{ do: 'turn_complete' }]] });
      const running = await startDaemonWithProfiles({
        sandbox: null,
        dataDir: dir.path,
        port: 0,
        adapter,
        logLevel: 'warn',
        ...QUIET,
      });
      daemon = running;
      const api = apiClient(running.url, running.token);
      const project = await api.post('/projects', ProjectDto, {
        name: 'demo',
        repoPath: repo.path,
        gateCommand: 'true',
        flowId: await quickFlowId(api),
        areas: [{ name: 'src', globs: ['src/**'] }],
      });
      const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
        title: 'Alpha',
        acceptanceCriteria: ['it works'],
        areas: ['src'],
      });
      await api.post(`/tasks/${task.id}/start`, z.unknown());
      await waitForAsync(async () =>
        (await api.get('/workstreams?active=false', z.array(WorkstreamDto))).some(
          (w) => w.taskId === task.id && w.state === 'DONE',
        ),
      );
      expect(adapter.probes).toHaveLength(1);
      expect(getAccount(running.state.db, project.accountId).expectedIdentity).toBe(
        'builder@example.com',
      );
    } finally {
      repo.cleanup();
    }
  });

  it('runs lanes unsandboxed when the lane sandbox is null', async () => {
    const repo = createTempRepo();
    try {
      const adapter = new FakeAdapter({ Alpha: [[{ do: 'turn_complete' }]] });
      const specs: LaneSessionSpec[] = [];
      adapter.seen = (spec) => {
        specs.push(spec);
        return {};
      };
      const running = await startDaemonWithProfiles({
        sandbox: null,
        dataDir: dir.path,
        port: 0,
        adapter,
        logLevel: 'warn',
        ...QUIET,
      });
      daemon = running;
      const api = apiClient(running.url, running.token);
      const project = await api.post('/projects', ProjectDto, {
        name: 'demo',
        repoPath: repo.path,
        gateCommand: 'true',
        flowId: await quickFlowId(api),
        areas: [{ name: 'src', globs: ['src/**'] }],
      });
      const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
        title: 'Alpha',
        acceptanceCriteria: ['it works'],
        areas: ['src'],
      });
      await api.post(`/tasks/${task.id}/start`, z.unknown());
      await waitFor(() => specs.length > 0);
      expect(specs[0]?.sandbox).toBeNull();
    } finally {
      repo.cleanup();
    }
  });

  /**
   * The sandbox's roots under one short base: the temp root, the Codex lanes root, the files root,
   * and two stand-ins for the system temp dirs a ChatGPT lane writes. The daemon makes the first three.
   */
  function sandboxRoots(base: string) {
    return {
      tmpRoot: join(base, 't'),
      codexLaneTempRoot: join(base, 'l'),
      filesRoot: join(base, 'r'),
      systemTempRoots: [join(base, 'sys'), join(base, 'vartmp')],
    };
  }

  // Its temp root is a short path under the shared `/tmp`, which no sandbox can write.
  it.skipIf(SANDBOXED)(
    'runs lanes and gates under the sandbox, built from its own data dir, home and git, when it is on',
    async () => {
      const repo = createTempRepo();
      // A short base: the lane temp directory's whole path must fit the sandbox's limit.
      const base = realpathSync(mkdtempSync('/tmp/sbd-'));
      const roots = sandboxRoots(base);
      const { tmpRoot, filesRoot, codexLaneTempRoot } = roots;
      for (const dir of roots.systemTempRoots) mkdirSync(dir);
      try {
        const adapter = new FakeAdapter({ Alpha: [[{ do: 'turn_complete' }]] });
        const specs: LaneSessionSpec[] = [];
        adapter.seen = (spec) => {
          specs.push(spec);
          return {};
        };
        const running = await startDaemonWithProfiles({
          dataDir: dir.path,
          port: 0,
          adapter,
          logLevel: 'warn',
          sandbox: { ...roots, runtime: FAKE_SRT },
          ...QUIET,
        });
        daemon = running;
        // Each root it puts files in is made private to this user before any is put there.
        for (const root of [tmpRoot, codexLaneTempRoot, filesRoot])
          expect(statSync(root).mode & 0o777, root).toBe(0o700);
        const api = apiClient(running.url, running.token);
        const project = await api.post('/projects', ProjectDto, {
          name: 'demo',
          repoPath: repo.path,
          gateCommand: 'true',
          flowId: await quickFlowId(api),
          areas: [{ name: 'src', globs: ['src/**'] }],
        });
        const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
          title: 'Alpha',
          acceptanceCriteria: ['it works'],
          areas: ['src'],
        });
        await api.post(`/tasks/${task.id}/start`, z.unknown());
        await waitForAsync(async () =>
          (await api.get('/workstreams?active=false', z.array(WorkstreamDto))).some(
            (w) => w.taskId === task.id && w.state === 'DONE',
          ),
        );
        const sandbox = specs[0]?.sandbox;
        expect(sandbox?.settings.filesystem.allowRead).toContain(realpathSync(repo.path));
        expect(sandbox?.settings.filesystem.denyRead).toEqual(
          expect.arrayContaining([dir.path, join(homedir(), '.claude.json')]),
        );
        expect(sandbox?.settings.network).not.toHaveProperty('allowLocalBinding');
        const laneTmp = sandbox?.env['CLAUDE_CODE_TMPDIR'] ?? '';
        // The caches in the lane's temp dir are for the sandboxed shell alone (its env file).
        expect(sandbox?.env['npm_config_cache']).toBeUndefined();
        expect(dirname(sandbox?.env['CLAUDE_ENV_FILE'] ?? '')).toBe(filesRoot);
        expect(dirname(laneTmp)).toBe(tmpRoot);
        // The gate ran under srt, with the project's network: no hosts, and nothing off the list.
        const gateLogs = join(dir.path, 'logs', 'gate');
        const gateLog = readFileSync(join(gateLogs, readdirSync(gateLogs)[0] ?? ''), 'utf8');
        expect(gateLog).toContain('fake srt: no sandbox; network {"allowedDomains":[]');
        expect(gateLog).toContain('"strictAllowlist":true');
        // The session and the gate ended, so their temp dirs and files are gone; the daemon's mark stays
        // in each root it claimed until it stops, and none is left in a system temp dir.
        // Each root also keeps the marker that keeps Spotlight out of it.
        const mark = `10db-daemon-${String(process.pid)}`;
        for (const root of [tmpRoot, codexLaneTempRoot, filesRoot])
          expect(readdirSync(root).sort(), root).toEqual(['.metadata_never_index', mark].sort());
        for (const dir of roots.systemTempRoots) expect(readdirSync(dir), dir).toEqual([]);
        await running.stop();
        for (const root of [tmpRoot, codexLaneTempRoot, filesRoot])
          expect(readdirSync(root), root).toEqual(['.metadata_never_index']);
      } finally {
        repo.cleanup();
        rmSync(base, { recursive: true, force: true });
      }
    },
  );

  // Same short base as above.
  it.skipIf(SANDBOXED)(
    'asks Time Machine to skip each root it claims, logs a root it could not and runs on, and stops asking at stop()',
    async () => {
      const base = realpathSync(mkdtempSync('/tmp/sbd-'));
      const roots = sandboxRoots(base);
      const asked: string[] = [];
      let stopped = false;
      try {
        daemon = await startDaemon({
          dataDir: dir.path,
          port: 0,
          adapter: new FakeAdapter({}),
          logLevel: 'warn',
          sandbox: {
            ...roots,
            runtime: FAKE_SRT,
            backups: (root, signal) => {
              asked.push(root);
              if (root === realpathSync(roots.filesRoot))
                return Promise.reject(new Error('tmutil failed'));
              // One that never ends by itself: the stop ends it.
              return new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                  stopped = true;
                  reject(new Error('aborted'));
                });
              });
            },
          },
          ...QUIET,
        });
        const running = daemon;
        await waitFor(() => asked.length === 3);
        expect(asked.sort()).toEqual(
          [roots.tmpRoot, roots.codexLaneTempRoot, roots.filesRoot]
            .map((r) => realpathSync(r))
            .sort(),
        );
        const logPath = join(dir.path, 'logs', 'daemon.log');
        await waitFor(
          () => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('Time Machine'),
        );
        expect(readFileSync(logPath, 'utf8')).toContain(realpathSync(roots.filesRoot));
        // The daemon runs on.
        const health = await fetch(`${running.url}/health`);
        expect(health.ok).toBe(true);
        await running.stop();
        daemon = null;
        expect(stopped).toBe(true);
      } finally {
        await daemon?.stop();
        daemon = null;
        rmSync(base, { recursive: true, force: true });
      }
    },
  );

  // Same short base as above.
  it.skipIf(SANDBOXED)(
    'refuses every lane session and gate, and claims no root, when a sandbox root is refused',
    async () => {
      const repo = createTempRepo();
      const base = realpathSync(mkdtempSync('/tmp/sbd-'));
      const roots = sandboxRoots(base);
      // A link where the files root goes: what is made there would land wherever it leads.
      const elsewhere = join(base, 'elsewhere');
      mkdirSync(elsewhere);
      writeFileSync(join(elsewhere, '10db-env-0123456789ab.sh'), '', { mode: 0o400 });
      symlinkSync(elsewhere, roots.filesRoot);
      try {
        const adapter = new FakeAdapter({ Alpha: [[{ do: 'turn_complete' }]] });
        const running = await startDaemonWithProfiles({
          dataDir: dir.path,
          port: 0,
          adapter,
          logLevel: 'warn',
          sandbox: { ...roots, runtime: FAKE_SRT },
          ...QUIET,
        });
        daemon = running;
        const api = apiClient(running.url, running.token);
        const project = await api.post('/projects', ProjectDto, {
          name: 'demo',
          repoPath: repo.path,
          gateCommand: 'true',
          flowId: await quickFlowId(api),
          areas: [{ name: 'src', globs: ['src/**'] }],
        });
        const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
          title: 'Alpha',
          acceptanceCriteria: ['it works'],
          areas: ['src'],
        });
        await api.post(`/tasks/${task.id}/start`, z.unknown());
        const failed = await waitForAsync(async () =>
          (await api.get('/workstreams?active=false', z.array(WorkstreamDto))).find(
            (w) => w.taskId === task.id && w.state === 'FAILED',
          ),
        );
        expect(failed.failureReason).toMatch(/^The lane sandbox could not start: /);
        expect(failed.failureReason).toContain(roots.filesRoot);
        expect(adapter.prompts).toEqual([]);
        // Nothing was claimed or swept through the link.
        expect(readdirSync(elsewhere)).toEqual(['10db-env-0123456789ab.sh']);
      } finally {
        await daemon?.stop();
        daemon = null;
        repo.cleanup();
        rmSync(base, { recursive: true, force: true });
      }
    },
  );

  // Same short base as above.
  it.skipIf(SANDBOXED)(
    'counts every system temp dir a ChatGPT lane writes as a sandbox root: no project is made there',
    async () => {
      const base = realpathSync(mkdtempSync('/tmp/sbd-'));
      // Outside `/private/tmp`, so only what the daemon is given counts.
      const system = tempDir('sys');
      const roots = {
        ...sandboxRoots(base),
        systemTempRoots: [join(system.path, 'tmp'), join(system.path, 'var-tmp')],
      };
      try {
        for (const dir of roots.systemTempRoots) mkdirSync(join(dir, 'repo'), { recursive: true });
        const running = await startDaemon({
          dataDir: dir.path,
          port: 0,
          adapter: new FakeAdapter({}),
          logLevel: 'warn',
          sandbox: { ...roots, runtime: FAKE_SRT },
          ...QUIET,
        });
        daemon = running;
        const api = apiClient(running.url, running.token);
        for (const dir of roots.systemTempRoots)
          expect(
            await api.post('/folders/inspect', FolderInspectResult, { path: join(dir, 'repo') }),
            dir,
          ).toMatchObject({ ok: false, reason: 'protected_path' });
      } finally {
        await daemon?.stop();
        daemon = null;
        rmSync(base, { recursive: true, force: true });
        system.cleanup();
      }
    },
  );

  // Its temp root is a short path under the shared `/tmp`, which no sandbox can write.
  it.skipIf(SANDBOXED)(
    'removes the temp dirs and sealed files a crashed daemon left in its sandbox roots, and its sealed files and ledgers in a system temp dir, before any session starts, and its temp dirs there once it listens',
    async () => {
      const base = realpathSync(mkdtempSync('/tmp/sbd-'));
      const roots = sandboxRoots(base);
      const { tmpRoot, filesRoot } = roots;
      const [systemTemp = ''] = roots.systemTempRoots;
      let planted: ReturnType<typeof spawn> | null = null;
      try {
        for (const root of [tmpRoot, filesRoot, ...roots.systemTempRoots]) mkdirSync(root);
        mkdirSync(join(tmpRoot, 'a1B2c3', 'cache'), { recursive: true });
        mkdirSync(join(systemTemp, '10db-a1B2c3', 'cache'), { recursive: true });
        for (const root of [filesRoot, systemTemp])
          for (const name of [
            '10db-env-0123456789ab.sh',
            '10db-mcp-0123456789ab.json',
            'other.txt',
          ])
            writeFileSync(join(root, name), '', { mode: 0o400 });
        // A ledger there is never read: a ChatGPT lane can write there.
        writeFileSync(join(systemTemp, '10db-proc-4321-0123456789ab.json'), '{}');
        // A mark a ChatGPT lane could plant there, naming a running process that is no daemon.
        planted = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
          stdio: 'ignore',
        });
        const plantedMark = `10db-daemon-${String(planted.pid ?? 0)}`;
        writeFileSync(join(systemTemp, plantedMark), '', { mode: 0o400 });
        daemon = await startDaemon({
          dataDir: dir.path,
          port: 0,
          adapter: new FakeAdapter({}),
          logLevel: 'warn',
          sandbox: { ...roots, runtime: FAKE_SRT },
          ...QUIET,
        });
        const mark = `10db-daemon-${String(process.pid)}`;
        // The claim leaves the Spotlight marker each root is given.
        expect(readdirSync(tmpRoot).sort()).toEqual(['.metadata_never_index', mark].sort());
        expect(readdirSync(filesRoot).sort()).toEqual(
          ['.metadata_never_index', mark, 'other.txt'].sort(),
        );
        // Its sealed files and ledgers there went before any session could start, whatever the mark.
        expect(readdirSync(systemTemp).sort()).toEqual(
          ['10db-a1B2c3', plantedMark, 'other.txt'].sort(),
        );
        // Its temp dirs there go off the event loop, once the daemon listens.
        await waitFor(() => !readdirSync(systemTemp).includes('10db-a1B2c3'));
        expect(readdirSync(systemTemp).sort()).toEqual([plantedMark, 'other.txt'].sort());
      } finally {
        planted?.kill('SIGKILL');
        await daemon?.stop();
        daemon = null;
        rmSync(base, { recursive: true, force: true });
      }
    },
  );

  // Same temp root as above.
  it.skipIf(SANDBOXED)(
    'stops the processes a dead daemon’s lane sessions left, from their ledgers, before any session starts, even while another daemon shares the root',
    async () => {
      const base = realpathSync(mkdtempSync('/tmp/sbd-'));
      const roots = sandboxRoots(base);
      // The ledgers are in the files root.
      const { filesRoot } = roots;
      mkdirSync(filesRoot);
      const T = 'Thu Oct 30 12:00:00 2026';
      // Another daemon, on another data dir, still running with a lane session of its own.
      const other = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
        stdio: 'ignore',
      });
      const otherPid = other.pid ?? 0;
      const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
      const deadPid = dead.pid ?? 0;
      await new Promise((resolve) => dead.once('exit', resolve));
      // Two loops that outlived their session, as the incident left them, and the other daemon's
      // lane's dev server.
      let rows = [
        { pid: process.pid, ppid: 1, pgid: process.pid, startedAt: T },
        { pid: 7001, ppid: 1, pgid: 7000, startedAt: T },
        { pid: 7002, ppid: 1, pgid: 7000, startedAt: T },
        { pid: 7003, ppid: 1, pgid: 7003, startedAt: T },
        { pid: 7004, ppid: 1, pgid: 7004, startedAt: T },
      ];
      try {
        writeFileSync(join(filesRoot, `10db-daemon-${String(otherPid)}`), '', { mode: 0o400 });
        const live = join(filesRoot, `10db-proc-${String(otherPid)}-00000000000a.json`);
        writeFileSync(
          live,
          JSON.stringify({ version: 1, members: [{ pid: 7004, pgid: 7004, startedAt: T }] }),
        );
        const ledger = join(filesRoot, `10db-proc-${String(deadPid)}-0123456789ab.json`);
        writeFileSync(
          ledger,
          JSON.stringify({
            version: 1,
            members: [
              { pid: 7001, pgid: 7000, startedAt: T },
              { pid: 7002, pgid: 7000, startedAt: T },
            ],
          }),
        );
        daemon = await startDaemon({
          dataDir: dir.path,
          port: 0,
          adapter: new FakeAdapter({}),
          logLevel: 'warn',
          sandbox: {
            ...roots,
            runtime: FAKE_SRT,
            processes: {
              table: () => Promise.resolve(rows.map((r) => ({ ...r }))),
              signal: (target) => {
                rows = rows.filter((r) => (target < 0 ? r.pgid !== -target : r.pid !== target));
                return true;
              },
              sleep: () => Promise.resolve(),
            },
          },
          ...QUIET,
        });
        expect(rows.map((r) => r.pid)).toEqual([process.pid, 7003, 7004]);
        expect(readdirSync(filesRoot).sort()).toEqual(
          [
            '.metadata_never_index',
            `10db-daemon-${String(otherPid)}`,
            `10db-daemon-${String(process.pid)}`,
            `10db-proc-${String(otherPid)}-00000000000a.json`,
          ].sort(),
        );
      } finally {
        await daemon?.stop();
        daemon = null;
        other.kill('SIGKILL');
        rmSync(base, { recursive: true, force: true });
      }
    },
  );

  // Same temp root as above.
  it.skipIf(SANDBOXED)(
    'tries again while it runs to stop what a dead daemon’s lane sessions left, when it could not read the machine at start',
    async () => {
      const base = realpathSync(mkdtempSync('/tmp/sbd-'));
      const roots = sandboxRoots(base);
      mkdirSync(roots.filesRoot);
      const T = 'Thu Oct 30 12:00:00 2026';
      const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
      const deadPid = dead.pid ?? 0;
      await new Promise((resolve) => dead.once('exit', resolve));
      let rows = [
        { pid: process.pid, ppid: 1, pgid: process.pid, startedAt: T },
        { pid: 7001, ppid: 1, pgid: 7001, startedAt: T },
      ];
      const ledger = join(roots.filesRoot, `10db-proc-${String(deadPid)}-0123456789ab.json`);
      // An overloaded Mac: `ps` can't fork as the daemon starts, and can again later.
      let readable = false;
      const timers = new ManualClock();
      try {
        writeFileSync(
          ledger,
          JSON.stringify({
            version: 1,
            daemonGroup: 7000,
            members: [{ pid: 7001, pgid: 7001, startedAt: T }],
          }),
        );
        daemon = await startDaemon({
          dataDir: dir.path,
          port: 0,
          adapter: new FakeAdapter({}),
          logLevel: 'warn',
          sandbox: {
            ...roots,
            runtime: FAKE_SRT,
            processes: {
              table: () =>
                readable
                  ? Promise.resolve(rows.map((r) => ({ ...r })))
                  : Promise.reject(new Error('ps: fork failed')),
              signal: (target) => {
                rows = rows.filter((r) => (target < 0 ? r.pgid !== -target : r.pid !== target));
                return true;
              },
              sleep: () => Promise.resolve(),
              timers,
            },
          },
          ...QUIET,
        });
        expect(existsSync(ledger)).toBe(true);
        readable = true;
        timers.advance(30_000);
        await waitFor(() => !existsSync(ledger));
        expect(rows.map((r) => r.pid)).toEqual([process.pid]);
      } finally {
        await daemon?.stop();
        daemon = null;
        rmSync(base, { recursive: true, force: true });
      }
    },
  );

  it('waits for an identity probe in flight before it closes the database', async () => {
    const repo = createTempRepo();
    try {
      const adapter = new FakeAdapter({ Alpha: [[{ do: 'turn_complete' }]] });
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      adapter.probeAccount = async (probe) => {
        adapter.probes.push(probe);
        await held;
        return adapter.probeSeen;
      };
      const running = await startDaemon({
        sandbox: null,
        dataDir: dir.path,
        port: 0,
        adapter,
        logLevel: 'warn',
        ...QUIET,
      });
      daemon = running;
      const api = apiClient(running.url, running.token);
      const project = await api.post('/projects', ProjectDto, {
        name: 'demo',
        repoPath: repo.path,
        gateCommand: 'true',
        flowId: await quickFlowId(api),
        areas: [{ name: 'src', globs: ['src/**'] }],
      });
      const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
        title: 'Alpha',
        acceptanceCriteria: ['it works'],
        areas: ['src'],
      });
      await api.post(`/tasks/${task.id}/start`, z.unknown());
      await waitFor(() => adapter.probes.length === 1);
      let stopped = false;
      const stopping = running.stop().then(() => {
        stopped = true;
      });
      // The deadline is the proof: a stop that ignored the probe would finish well inside it.
      await expect(waitFor(() => stopped, 750)).rejects.toThrow('timed out');
      release();
      await stopping;
      daemon = null;
    } finally {
      repo.cleanup();
    }
  });

  it('does not count a clean stop against the recovery limit', async () => {
    const repo = createTempRepo();
    const book: FakeScriptBook = { Alpha: [[{ do: 'hang' }], [{ do: 'hang' }]] };
    const start = () =>
      startDaemonWithProfiles({
        sandbox: null,
        dataDir: dir.path,
        port: 0,
        adapter: new FakeAdapter(book),
        logLevel: 'warn',
        ...QUIET,
      });
    try {
      let running = await start();
      daemon = running;
      const call = async (path: string, body: unknown): Promise<{ id: string }> => {
        const res = await fetch(`${running.url}${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${running.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return z.object({ id: z.string() }).parse(await res.json());
      };
      const project = await call('/projects', {
        name: 'demo',
        repoPath: repo.path,
        gateCommand: 'true',
        flowId: await quickFlowId(apiClient(running.url, running.token)),
        areas: [{ name: 'api', globs: ['src/**'] }],
      });
      const task = await call(`/projects/${project.id}/tasks`, {
        title: 'Alpha',
        acceptanceCriteria: ['x'],
        areas: ['api'],
      });
      const ws = WorkstreamId.parse((await call(`/tasks/${task.id}/start`, {})).id);
      await waitFor(() => getWorkstream(running.state.db, ws).state === 'RUNNING');
      await running.stop();
      daemon = null;

      running = await start();
      daemon = running;
      await waitFor(() => getWorkstream(running.state.db, ws).state === 'RUNNING');
      expect(getWorkstream(running.state.db, ws).recoveryAttempts).toBe(0);
    } finally {
      repo.cleanup();
    }
  });
  const recordingCaffeinate =
    (spawned: number[]): CaffeinateSpawner =>
    (pid) => {
      spawned.push(pid);
      return { stop: () => undefined, exited: new Promise<void>(() => undefined) };
    };

  /** The status the event stream's upgrade answers for `origin`: 101 when the socket opens. */
  const upgradeStatus = (url: string, origin: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const client = new WebSocket(url, { origin });
      client.once('open', () => {
        client.close();
        resolve(101);
      });
      client.once('unexpected-response', (request, response) => {
        resolve(response.statusCode ?? 0);
        request.destroy();
      });
      client.on('error', reject);
    });

  it.each([
    {
      name: 'no dev UI origin',
      allowedOrigins: undefined,
      devUiOrigin: undefined,
      accepted: ['tauri://localhost', 'http://tauri.localhost'],
      refused: [
        'http://localhost:1420',
        'http://127.0.0.1:1420',
        'http://[::1]:1420',
        'https://evil.example',
      ],
    },
    {
      name: 'the Vite origin opted in',
      allowedOrigins: undefined,
      devUiOrigin: 'http://localhost:1420',
      accepted: ['tauri://localhost', 'http://localhost:1420'],
      refused: ['http://localhost:1421', 'http://127.0.0.1:1420', 'https://evil.example'],
    },
    {
      name: 'an IPv6 loopback origin opted in',
      allowedOrigins: undefined,
      devUiOrigin: 'http://[::1]:51234',
      accepted: ['tauri://localhost', 'http://[::1]:51234'],
      refused: ['http://localhost:51234', 'http://localhost:1420'],
    },
    {
      name: 'a dev UI origin beside the origins it is given',
      allowedOrigins: ['http://localhost:3000'],
      devUiOrigin: 'http://localhost:51234',
      accepted: ['http://localhost:3000', 'http://localhost:51234'],
      refused: ['tauri://localhost', 'http://localhost:51235'],
    },
  ])(
    'with $name, accepts only its origins over CORS and the event stream, and still asks for the token',
    async ({ allowedOrigins, devUiOrigin, accepted, refused }) => {
      const running = await startDaemon({
        sandbox: null,
        dataDir: dir.path,
        port: 0,
        adapter: new FakeAdapter({}),
        logLevel: 'warn',
        ...(allowedOrigins ? { allowedOrigins } : {}),
        ...(devUiOrigin ? { devUiOrigin } : {}),
        ...QUIET,
      });
      daemon = running;
      const corsOrigin = async (origin: string): Promise<string | null> =>
        (await fetch(`${running.url}/health`, { headers: { Origin: origin } })).headers.get(
          'access-control-allow-origin',
        );
      const stream = `ws://127.0.0.1:${String(running.port)}/events/stream?after=0`;
      for (const origin of accepted) {
        expect(await corsOrigin(origin), origin).toBe(origin);
        expect(await upgradeStatus(`${stream}&token=${running.token}`, origin), origin).toBe(101);
        // An accepted origin is not a credential.
        const noToken = await fetch(`${running.url}/projects`, { headers: { Origin: origin } });
        expect(noToken.status, origin).toBe(401);
        expect(await upgradeStatus(`${stream}&token=wrong`, origin), origin).toBe(401);
      }
      for (const origin of refused) {
        expect(await corsOrigin(origin), origin).toBeNull();
        expect(await upgradeStatus(`${stream}&token=${running.token}`, origin), origin).toBe(403);
      }
    },
  );

  it('honors a fixed dev token and serves keep-awake, the event head and the system check', async () => {
    const token = 'd'.repeat(43);
    const spawned: number[] = [];
    const check: SystemCheckDto = {
      loginEnv: { source: 'login_shell', warning: null },
      claudeCode: { verifiedOn: '2.1.302', warning: null },
      codex: { verifiedOn: CODEX_VERIFIED_ON, warning: null },
      tools: [
        {
          name: 'git',
          path: '/usr/bin/git',
          version: 'git version 2.50.1',
          required: true,
          signedIn: null,
        },
      ],
      benchmarkSync: null,
    };
    const checkedWith: ResolvedTools[] = [];
    daemon = await startDaemon({
      sandbox: null,
      dataDir: dir.path,
      port: 0,
      adapter: new FakeAdapter({}),
      logLevel: 'warn',
      uiToken: token,
      caffeinate: recordingCaffeinate(spawned),
      systemCheck: (resolved) => {
        checkedWith.push(resolved);
        return Promise.resolve(check);
      },
      watch: false,
    });
    expect(daemon.token).toBe(token);
    const headers = { Authorization: `Bearer ${token}` };
    expect(await (await fetch(`${daemon.url}/settings/keep-awake`, { headers })).json()).toEqual({
      mode: 'while_running',
      active: false,
    });
    const put = await fetch(`${daemon.url}/settings/keep-awake`, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'always' }),
    });
    expect(await put.json()).toEqual({ mode: 'always', active: true });
    expect(spawned).toEqual([process.pid]);
    const head = EventsHead.parse(
      await (await fetch(`${daemon.url}/events/head`, { headers })).json(),
    );
    expect(head.seq).toBeGreaterThan(0);
    expect(await (await fetch(`${daemon.url}/system`, { headers })).json()).toEqual(check);
    // The check reports the git and gh the daemon resolved, from the install prefixes.
    const prefixed = (name: string) =>
      ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
        .map((prefix) => join(prefix, name))
        .filter((path) => existsSync(path));
    expect(checkedWith).toHaveLength(1);
    expect(prefixed('git')).toContain(checkedWith[0]?.git);
    expect([...prefixed('gh'), null]).toContain(checkedWith[0]?.gh);
  });

  it('reports the pinned agent copies as they stand for each request, and fetches again on a recheck', async () => {
    const token = 'e'.repeat(43);
    const claude: AgentStatus = {
      tool: 'claude',
      label: 'Claude Code',
      pinned: '2.1.302',
      state: 'fetching',
      path: null,
      version: null,
      problem: null,
      newerRelease: null,
    };
    let statuses: readonly AgentStatus[] = [claude];
    let retries = 0;
    daemon = await startDaemon({
      sandbox: null,
      dataDir: dir.path,
      port: 0,
      adapter: new FakeAdapter({}),
      logLevel: 'warn',
      uiToken: token,
      watch: false,
      agents: {
        statuses: () => statuses,
        retry: () => {
          retries += 1;
          return Promise.resolve();
        },
      },
    });
    const system = async (query = '') =>
      SystemCheckDto.parse(
        await (
          await fetch(`${daemon?.url ?? ''}/system${query}`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        ).json(),
      );
    const first = await system();
    expect(first.agents).toEqual([
      expect.objectContaining({ state: 'fetching', newerRelease: null }),
    ]);
    expect(first.tools.find((t) => t.name === 'claude')?.path).toBeNull();
    // The tool check is kept, but the copies are read again: ready now, with a newer release out.
    statuses = [
      {
        ...claude,
        state: 'ready',
        path: '/data/tools/claude/claude',
        version: '2.1.302 (Claude Code)',
        newerRelease: '2.1.319',
      },
    ];
    const second = await system();
    expect(second.agents).toEqual([
      expect.objectContaining({ state: 'ready', pinned: '2.1.302', newerRelease: '2.1.319' }),
    ]);
    expect(second.tools.find((t) => t.name === 'claude')).toMatchObject({
      path: '/data/tools/claude/claude',
      version: '2.1.302 (Claude Code)',
    });
    expect(retries).toBe(0);
    await system('?recheck=1');
    expect(retries).toBe(1);
  });

  it('holds keep-awake and watches the repo while a lane runs, and lets go when it is cancelled', async () => {
    const repo = createTempRepo();
    const spawned: number[] = [];
    const roots: string[] = [];
    const closed: string[] = [];
    try {
      daemon = await startDaemon({
        sandbox: null,
        dataDir: dir.path,
        port: 0,
        adapter: new FakeAdapter({ Alpha: [[{ do: 'hang' }]] }),
        logLevel: 'warn',
        caffeinate: recordingCaffeinate(spawned),
        watch: (root) => {
          roots.push(root);
          return {
            close: () => {
              closed.push(root);
            },
          };
        },
      });
      const api = apiClient(daemon.url, daemon.token);
      const project = await api.post('/projects', ProjectDto, {
        name: 'wired',
        repoPath: repo.path,
        gateCommand: 'true',
        flowId: await quickFlowId(api),
        areas: [{ name: 'api', globs: ['src/api/**'] }],
      });
      const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
        title: 'Alpha',
        acceptanceCriteria: ['works'],
        areas: ['api'],
      });
      const ws = await api.post(`/tasks/${task.id}/start`, WorkstreamDto);
      const keepAwakeActive = async () =>
        (await api.get('/settings/keep-awake', KeepAwakeStatus)).active;

      await waitForAsync(async () => ((await keepAwakeActive()) ? true : undefined));
      expect(spawned).toEqual([process.pid]);
      expect(roots).toEqual([repo.path]);

      await api.post(`/workstreams/${ws.id}/cancel`, z.unknown());
      await waitForAsync(async () => ((await keepAwakeActive()) ? undefined : true));
      expect(closed).toEqual([repo.path]);
    } finally {
      await daemon?.stop();
      daemon = null;
      repo.cleanup();
    }
  });

  it('starts no lane while the Mac is overloaded, raises one card naming what is busy, and starts the lane by itself once the load falls', async () => {
    const repo = createTempRepo();
    let load = 100;
    const adapter = new FakeAdapter({ Alpha: [[{ do: 'turn_complete' }]] });
    const specs: LaneSessionSpec[] = [];
    adapter.seen = (spec) => {
      specs.push(spec);
      return {};
    };
    try {
      daemon = await startDaemonWithProfiles({
        sandbox: null,
        dataDir: dir.path,
        port: 0,
        adapter,
        logLevel: 'warn',
        tickMs: 20,
        ...QUIET,
        load: {
          read: () => ({ load, cores: 10 }),
          processes: {
            rows: () =>
              Promise.resolve([
                { pid: 4242, ppid: 1, pgid: 4242, cpu: 99, command: 'sh busy-loop.sh' },
              ]),
            files: () => Promise.resolve(new Map()),
          },
          sampleMs: 20,
          sustainedMs: 0,
        },
      });
      const api = apiClient(daemon.url, daemon.token);
      const project = await api.post('/projects', ProjectDto, {
        name: 'demo',
        repoPath: repo.path,
        gateCommand: 'true',
        flowId: await quickFlowId(api),
        areas: [{ name: 'src', globs: ['src/**'] }],
      });
      const overloadCards = async () =>
        (await api.get('/inbox?state=OPEN', z.array(InboxItemDto))).filter((item) =>
          item.title.startsWith('The Mac is overloaded'),
        );
      // The card is up once the overload is declared, so the task below starts into a hold.
      const card = await waitForAsync(async () => (await overloadCards())[0]);
      expect(card.body).toContain('pid 4242 (sh busy-loop.sh) at 99% of a core: not 10db’s');
      const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
        title: 'Alpha',
        acceptanceCriteria: ['it works'],
        areas: ['src'],
      });
      const ws = await api.post(`/tasks/${task.id}/start`, WorkstreamDto);
      expect(await daemon.scheduler.tick()).toBe(0);
      expect(specs).toEqual([]);
      expect(getWorkstream(daemon.state.db, ws.id).state).toBe('QUEUED');
      expect(await overloadCards()).toHaveLength(1);

      load = 1;
      await waitFor(() => specs.length > 0);
      await waitForAsync(async () => ((await overloadCards()).length === 0 ? true : undefined));
    } finally {
      await daemon?.stop();
      daemon = null;
      repo.cleanup();
    }
  });

  it('withdraws an overload card left open when 10db restarted mid-overload', async () => {
    const repo = createTempRepo();
    const options = (load: number) => ({
      sandbox: null,
      dataDir: dir.path,
      port: 0,
      adapter: new FakeAdapter({}),
      logLevel: 'warn' as const,
      tickMs: 20,
      ...QUIET,
      load: {
        read: () => ({ load, cores: 10 }),
        processes: {
          rows: () => Promise.resolve([]),
          files: () => Promise.resolve(new Map<number, string[]>()),
        },
        sampleMs: 20,
        sustainedMs: 0,
      },
    });
    const overloadCards = async (api: ReturnType<typeof apiClient>) =>
      (await api.get('/inbox?state=OPEN', z.array(InboxItemDto))).filter((item) =>
        item.title.startsWith('The Mac is overloaded'),
      );
    try {
      daemon = await startDaemon(options(100));
      const before = apiClient(daemon.url, daemon.token);
      await before.post('/projects', ProjectDto, {
        name: 'demo',
        repoPath: repo.path,
        gateCommand: 'true',
        flowId: await quickFlowId(before),
        areas: [{ name: 'src', globs: ['src/**'] }],
      });
      await waitForAsync(async () => (await overloadCards(before))[0]);
      await daemon.stop();

      daemon = await startDaemon(options(1));
      expect(await overloadCards(apiClient(daemon.url, daemon.token))).toEqual([]);
    } finally {
      await daemon?.stop();
      daemon = null;
      repo.cleanup();
    }
  });

  describe('the gh login in GET /system', () => {
    async function systemWith(gh: FakeGh) {
      daemon = await startDaemon({
        sandbox: null,
        dataDir: dir.path,
        port: 0,
        adapter: new FakeAdapter({}),
        logLevel: 'warn',
        gh,
        systemCheck: async (_resolved, ghLogin) => ({
          loginEnv: { source: 'login_shell', warning: null },
          claudeCode: { verifiedOn: '2.1.302', warning: null },
          codex: { verifiedOn: CODEX_VERIFIED_ON, warning: null },
          tools: [
            {
              name: 'gh',
              path: '/usr/bin/gh',
              version: 'gh version 2.0.0',
              required: false,
              signedIn: await ghLogin(),
            },
          ],
          benchmarkSync: null,
        }),
        ...QUIET,
      });
      const api = apiClient(daemon.url, daemon.token);
      const probes = () => gh.calls.filter((c) => c.method === 'authLogin').length;
      return { api, probes };
    }

    it('answers a plain GET after the first from the last probe, and ?recheck=1 asks gh again', async () => {
      const gh = new FakeGh();
      const { api, probes } = await systemWith(gh);
      const login = async (path: string) =>
        (await api.get(path, SystemCheckDto)).tools.find((t) => t.name === 'gh')?.signedIn;

      expect(await login('/system')).toBe('octocat');
      expect(probes()).toBe(1);
      gh.auth = 'signed_out';
      expect(await login('/system')).toBe('octocat');
      expect(probes()).toBe(1);
      expect(await login('/system?recheck=1')).toBeNull();
      expect(probes()).toBe(2);
      expect(await login('/system')).toBeNull();
      expect(probes()).toBe(2);
    });
  });

  it("raises an approval card for each repo MCP server on review, and reports the builder's verdict", async () => {
    const repo = createTempRepo();
    try {
      writeFileSync(
        join(repo.path, '.mcp.json'),
        JSON.stringify({
          mcpServers: { mantine: { command: 'npx', args: ['-y', '@mantine/mcp-server@9.7.2'] } },
        }),
      );
      daemon = await startDaemon({
        sandbox: null,
        dataDir: dir.path,
        port: 0,
        adapter: new FakeAdapter({}),
        logLevel: 'warn',
        ...QUIET,
      });
      const call = async (path: string, body?: unknown) => {
        const res = await fetch(`${daemon?.url ?? ''}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${daemon?.token ?? ''}`,
            'content-type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const json: unknown = await res.json();
        return json;
      };
      const project = ProjectDto.parse(
        await call('/projects', {
          name: 'demo',
          repoPath: repo.path,
          gateCommand: 'true',
          areas: [{ name: 'src', globs: ['src/**'] }],
        }),
      );
      const [pending] = z
        .array(McpServerStatusDto)
        .parse(await call(`/projects/${project.id}/mcp-servers/review`));
      expect(pending).toMatchObject({
        name: 'mantine',
        command: 'npx',
        args: ['-y', '@mantine/mcp-server@9.7.2'],
        verdict: 'pending',
      });
      // Reviewing again folds into the same open card.
      expect(
        z
          .array(McpServerStatusDto)
          .parse(await call(`/projects/${project.id}/mcp-servers/review`))[0]?.inboxId,
      ).toBe(pending?.inboxId);
      await call(`/inbox/${pending?.inboxId ?? ''}/answer`, { choice: 'approve' });
      expect(
        z.array(McpServerStatusDto).parse(await call(`/projects/${project.id}/mcp-servers/review`)),
      ).toEqual([expect.objectContaining({ verdict: 'approved', inboxId: null })]);
    } finally {
      repo.cleanup();
    }
  });

  it('answers 400 when the repo MCP config cannot be parsed, and creates no card', async () => {
    const repo = createTempRepo();
    try {
      writeFileSync(join(repo.path, '.mcp.json'), '{"mcpServers": {');
      daemon = await startDaemon({
        sandbox: null,
        dataDir: dir.path,
        port: 0,
        adapter: new FakeAdapter({}),
        logLevel: 'warn',
        ...QUIET,
      });
      const headers = {
        Authorization: `Bearer ${daemon.token}`,
        'content-type': 'application/json',
      };
      const created = await fetch(`${daemon.url}/projects`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'broken',
          repoPath: repo.path,
          gateCommand: 'true',
          areas: [{ name: 'src', globs: ['src/**'] }],
        }),
      });
      const project = ProjectDto.parse(await created.json());
      const res = await fetch(`${daemon.url}/projects/${project.id}/mcp-servers/review`, {
        method: 'POST',
        headers,
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('is not valid JSON');
    } finally {
      repo.cleanup();
    }
  });

  it('names a rate-limited Artificial Analysis sync on the system check, and clears it when the retry succeeds', async () => {
    const clock = new ManualClock(new Date('2026-10-17T12:00:00.000Z'));
    let aaStatus = 429;
    const aaFetch: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            intelligence_index_version: '9.9',
            pagination: { has_more: false },
            data: [{ slug: 'other-model', name: 'Other', model_creator: { name: 'Lab' } }],
          }),
          { status: aaStatus },
        ),
      );
    daemon = await startDaemon({
      sandbox: null,
      dataDir: dir.path,
      port: 0,
      adapter: new FakeAdapter({}),
      logLevel: 'warn',
      ...QUIET,
      clock,
      aaKey: () => 'aa-test-key',
      fetch: aaFetch,
    });
    const api = apiClient(daemon.url, daemon.token);
    const warning = await waitForAsync(
      async () => (await api.get('/system', SystemCheckDto)).benchmarkSync,
    );
    expect(warning).toMatchObject({ outcome: 'rate_limited' });
    expect(warning?.message).toContain('limit');

    aaStatus = 200;
    clock.advance(15 * 60_000);
    await waitForAsync(async () =>
      (await api.get('/system', SystemCheckDto)).benchmarkSync === null ? true : undefined,
    );
    expect(await api.get('/benchmarks/status', BenchmarkStatusDto)).toMatchObject({
      outcome: 'ok',
    });
  });

  it('fetches the model catalogue at start only when catalogueSync is given', async () => {
    const requests: string[] = [];
    daemon = await startDaemon({
      sandbox: null,
      dataDir: dir.path,
      port: 0,
      adapter: new FakeAdapter({}),
      logLevel: 'warn',
      ...QUIET,
      catalogueSync: true,
      fetch: (input) => {
        requests.push(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        return Promise.reject(new Error('offline'));
      },
    });
    await waitFor(() => requests.length > 0);
    expect(requests).toEqual([CATALOGUE_URL]);
  });

  describe('the model refresh', () => {
    const OPUS = { id: 'opus', resolvedId: 'claude-opus-5-5', efforts: ['low' as const] };
    const startWithList = async (catalogueSync: boolean) => {
      const adapter = new FakeAdapter({ Alpha: [[{ do: 'turn_complete' }]] });
      adapter.probeSeen = { ...adapter.probeSeen, models: [OPUS] };
      const fetches: string[] = [];
      const net = { online: true };
      daemon = await startDaemon({
        sandbox: null,
        dataDir: dir.path,
        port: 0,
        adapter,
        logLevel: 'warn',
        ...QUIET,
        catalogueSync,
        fetch: (input) => {
          fetches.push(
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          );
          return net.online
            ? Promise.resolve(new Response(JSON.stringify(readModelsDevFixture())))
            : Promise.reject(new Error('offline'));
        },
      });
      // With no snapshot given and the fetch off there is no catalogue to build profiles from; the fixture's models stand in.
      if (!catalogueSync) seedProfiles(daemon.state);
      return { adapter, fetches, net, running: daemon };
    };

    it('builds profiles from each account list after the fetch, and a second call joins a run', async () => {
      const { adapter, fetches, running } = await startWithList(true);
      await waitFor(() => listAccountModels(running.state.db).length > 0);
      expect(listAccountModels(running.state.db).map((m) => m.model)).toEqual(['claude-opus-5-5']);
      expect(findModelProfile(running.state.db, 'claude', 'claude-opus-5-5', 'low')).toMatchObject({
        enabled: true,
        tier: 'frontier',
        outputPrice: 20,
      });

      const before = { fetches: fetches.length, probes: adapter.probes.length };
      await Promise.all([
        running.refreshModels({ force: false }),
        running.refreshModels({ force: false }),
      ]);
      expect(fetches.length - before.fetches).toBe(1);
      expect(adapter.probes.length - before.probes).toBe(1);
    });

    it('scores the models an account lists after the profiles exist, in one request, and a second refresh asks for nothing', async () => {
      const adapter = new FakeAdapter({});
      adapter.probeSeen = { ...adapter.probeSeen, models: [OPUS] };
      const aaRequests: string[] = [];
      // No key until the profiles exist, so only the refresh after the catalogue can score them.
      const key: { value: string | null } = { value: null };
      daemon = await startDaemon({
        sandbox: null,
        dataDir: dir.path,
        port: 0,
        adapter,
        logLevel: 'warn',
        ...QUIET,
        catalogueSync: true,
        aaKey: () => key.value,
        fetch: (input) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (!url.includes('artificialanalysis')) {
            return Promise.resolve(new Response(JSON.stringify(readModelsDevFixture())));
          }
          aaRequests.push(url);
          return Promise.resolve(
            new Response(
              JSON.stringify({
                intelligence_index_version: '9.9',
                pagination: { has_more: false },
                data: [
                  {
                    slug: 'claude-opus-5-5-low',
                    name: 'Invented Opus',
                    model_creator: { name: 'Test Lab' },
                    evaluations: { artificial_analysis_intelligence_index: 42 },
                  },
                ],
              }),
            ),
          );
        },
      });
      const running = daemon;
      await waitFor(
        () => findModelProfile(running.state.db, 'claude', 'claude-opus-5-5', 'low') !== undefined,
      );
      key.value = 'aa-test-key';
      await running.refreshModels({ force: false });
      expect(aaRequests).toHaveLength(1);
      expect(findModelProfile(running.state.db, 'claude', 'claude-opus-5-5', 'low')).toMatchObject({
        aaSlug: 'claude-opus-5-5-low',
      });
      await running.refreshModels({ force: false });
      expect(aaRequests).toHaveLength(1);
    });

    it('after a failed fetch reads only accounts not read today, unless the builder forces it', async () => {
      const { adapter, net, running } = await startWithList(true);
      await waitFor(() => listAccountModels(running.state.db).length > 0);
      net.online = false;
      const probes = adapter.probes.length;
      await running.refreshModels({ force: false });
      expect(adapter.probes.length).toBe(probes);
      await running.refreshModels({ force: true });
      expect(adapter.probes.length).toBe(probes + 1);
    });

    it('with the catalogue off fetches nothing and probes no account, whoever asks: not a refresh, a sign-in or a session', async () => {
      const repo = createTempRepo();
      try {
        const { adapter, fetches, running } = await startWithList(false);
        const api = apiClient(running.url, running.token);
        await running.refreshModels({ force: true });
        // A ready account, so the session start needs no probe of its own.
        const [account] = listAccounts(running.state.db);
        if (!account) throw new Error('no default account');
        running.state.write((ctx) =>
          patchAccount(ctx, account.id, { expectedIdentity: 'builder@example.com' }),
        );
        await api.post(`/accounts/${account.id}/connect`, z.unknown());
        adapter.logins[0]?.end({ ok: true });
        await waitForAsync(async () =>
          (await api.get('/accounts/connecting', z.unknown())) === null ? true : undefined,
        );
        const project = await api.post('/projects', ProjectDto, {
          name: 'demo',
          repoPath: repo.path,
          gateCommand: 'true',
          flowId: await quickFlowId(api),
          areas: [{ name: 'src', globs: ['src/**'] }],
        });
        const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
          title: 'Alpha',
          acceptanceCriteria: ['it works'],
          areas: ['src'],
        });
        await api.post(`/tasks/${task.id}/start`, z.unknown());
        await waitForAsync(async () =>
          (await api.get('/workstreams?active=false', z.array(WorkstreamDto))).some(
            (w) => w.taskId === task.id && w.state === 'DONE',
          ),
        );
        expect(fetches).toEqual([]);
        expect(adapter.probes).toEqual([]);
      } finally {
        repo.cleanup();
      }
    });
  });

  it('with TENDB_BENCHMARKS=off never reads the benchmark key and makes no Artificial Analysis request', async () => {
    let keyReads = 0;
    const requests: string[] = [];
    daemon = await startDaemon({
      sandbox: null,
      dataDir: dir.path,
      port: 0,
      adapter: new FakeAdapter({}),
      logLevel: 'warn',
      ...QUIET,
      aaKey: aaKeyReaderFromEnv(loadEnv({ TENDB_BENCHMARKS: 'off' }), () => {
        keyReads += 1;
        return 'aa-test-key';
      }),
      fetch: (input) => {
        requests.push(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        return Promise.reject(new Error('no request expected'));
      },
    });
    const api = apiClient(daemon.url, daemon.token);
    await waitForAsync(async () =>
      (await api.get('/benchmarks/status', BenchmarkStatusDto)).outcome === 'no_key'
        ? true
        : undefined,
    );
    expect(await api.get('/benchmarks/status', BenchmarkStatusDto)).toMatchObject({
      keyConfigured: false,
      outcome: 'no_key',
    });
    expect(keyReads).toBe(0);
    expect(requests).toEqual([]);
  });

  it('seeds the team, reports no AA key, plans on hand-set scores, and refuses an over-budget start', async () => {
    const repo = createTempRepo();
    try {
      daemon = await startDaemon({
        sandbox: null,
        dataDir: dir.path,
        port: 0,
        adapter: new FakeAdapter({}),
        logLevel: 'warn',
        ...QUIET,
      });
      const api = apiClient(daemon.url, daemon.token);
      expect((await api.get('/personas', z.array(PersonaDto))).map((p) => p.key)).toContain(
        'reviewer',
      );
      expect(await api.get('/benchmarks/status', BenchmarkStatusDto)).toMatchObject({
        keyConfigured: false,
        outcome: 'no_key',
        models: 0,
      });
      // With the catalogue fetch off, nothing builds profiles; the fixture's stand in for an account's list.
      seedProfiles(daemon.state);
      const profiles = await api.get('/model-profiles', z.array(ModelProfileDto));
      const sonnetHigh = profiles.find(
        (p) => p.model === 'claude-sonnet-5-5' && p.effort === 'high',
      );
      if (!sonnetHigh) throw new Error('not seeded');
      // Hand-set (invented) scores: the profile becomes manual and the only measured one.
      expect(
        await api.patch(`/model-profiles/${sonnetHigh.id}`, ModelProfileDto, {
          scores: { intelligence: 50 },
          costPerTaskUsd: 2,
        }),
      ).toMatchObject({ source: 'manual' });
      const project = await api.post('/projects', ProjectDto, {
        name: 'demo',
        repoPath: repo.path,
        gateCommand: 'true',
        areas: [{ name: 'src', globs: ['src/**'] }],
      });
      const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
        title: 'T',
        acceptanceCriteria: ['x'],
        areas: ['src'],
      });
      const plan = await api.get(`/tasks/${task.id}/step-plan`, StepPlanDto);
      expect(plan).toMatchObject({ flowName: 'standard', overBudget: [] });
      expect(plan.steps.map((s) => `${s.role}:${s.model}@${s.effort}`)).toEqual([
        'implement:claude-sonnet-5-5@high',
        'review:claude-sonnet-5-5@high',
      ]);
      await api.patch(`/projects/${project.id}`, ProjectDto, { budgetCeiling: 1 });
      await expect(api.post(`/tasks/${task.id}/start`, WorkstreamDto)).rejects.toThrow('-> 400');
    } finally {
      repo.cleanup();
    }
  });

  it('gives a project Icebox, parks a task in it, refuses to start it, and plans it again', async () => {
    const repo = createTempRepo();
    try {
      daemon = await startDaemon({
        sandbox: null,
        dataDir: dir.path,
        port: 0,
        adapter: new FakeAdapter({}),
        logLevel: 'warn',
        ...QUIET,
      });
      const api = apiClient(daemon.url, daemon.token);
      const project = await api.post('/projects', ProjectDto, {
        name: 'demo',
        repoPath: repo.path,
        gateCommand: 'true',
        areas: [{ name: 'src', globs: ['src/**'] }],
      });
      const [icebox] = await api.get(
        `/projects/${project.id}/board-columns`,
        z.array(BoardColumnDto),
      );
      expect(icebox?.name).toBe('Icebox');
      if (!icebox) throw new Error('no Icebox');
      const add = (title: string) =>
        api.post(`/projects/${project.id}/tasks`, TaskDto, {
          title,
          acceptanceCriteria: ['x'],
          areas: ['src'],
        });
      const first = await add('first');
      const second = await add('second');
      await api.post(`/tasks/${second.id}/move`, TaskDto, {
        to: null,
        after: null,
        before: first.id,
      });
      expect(
        (await api.get(`/projects/${project.id}/tasks`, z.array(TaskDto))).map((t) => t.title),
      ).toEqual(['second', 'first']);
      const parked = await api.post(`/tasks/${first.id}/move`, TaskDto, {
        to: icebox.id,
        after: null,
        before: null,
      });
      expect(parked.boardColumnId).toBe(icebox.id);
      await expect(api.post(`/tasks/${first.id}/start`, WorkstreamDto)).rejects.toThrow('-> 409');
      const exploring = await api.post(`/projects/${project.id}/board-columns`, BoardColumnDto, {
        name: 'Exploring',
      });
      const columns = await api.post(
        `/board-columns/${icebox.id}/delete`,
        z.array(BoardColumnDto),
        {
          moveTasksTo: exploring.id,
        },
      );
      expect(columns.map((c) => c.name)).toEqual(['Exploring']);
    } finally {
      repo.cleanup();
    }
  });

  it('proposes one ready task per area for the approval sheet', async () => {
    const repo = createTempRepo();
    try {
      daemon = await startDaemon({
        sandbox: null,
        dataDir: dir.path,
        port: 0,
        adapter: new FakeAdapter({}),
        logLevel: 'warn',
        ...QUIET,
      });
      const api = apiClient(daemon.url, daemon.token);
      const project = await api.post('/projects', ProjectDto, {
        name: 'demo',
        repoPath: repo.path,
        gateCommand: 'true',
        areas: [
          { name: 'src', globs: ['src/**'] },
          { name: 'docs', globs: ['docs/**'] },
        ],
      });
      for (const [title, area] of [
        ['code', 'src'],
        ['words', 'docs'],
      ] as const)
        await api.post(`/projects/${project.id}/tasks`, TaskDto, {
          title,
          acceptanceCriteria: ['x'],
          areas: [area],
        });
      const proposal = await api.get(
        `/projects/${project.id}/candidates?size=2`,
        PickerProposalDto,
      );
      expect(proposal.candidates.map((c) => [c.task.title, c.proposed])).toEqual([
        ['code', true],
        ['words', true],
      ]);
    } finally {
      repo.cleanup();
    }
  });

  it('answers 404 for an unknown project on team, routing-rule and candidate routes and 201 on creates', async () => {
    daemon = await startDaemon({
      sandbox: null,
      dataDir: dir.path,
      port: 0,
      adapter: new FakeAdapter({}),
      logLevel: 'warn',
      ...QUIET,
    });
    const api = apiClient(daemon.url, daemon.token);
    const ghost = mintId('Project');
    const send = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${daemon?.url ?? ''}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${daemon?.token ?? ''}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      await res.text();
      return res.status;
    };
    const repo = createTempRepo();
    try {
      const project = await api.post('/projects', ProjectDto, {
        name: 'demo',
        repoPath: repo.path,
        gateCommand: 'true',
        areas: [{ name: 'src', globs: ['src/**'] }],
      });
      const head = await api.get('/events/head', EventsHead);
      expect(await send('GET', `/projects/${ghost}/team`)).toBe(404);
      expect(await send('GET', `/projects/${ghost}/routing-rules`)).toBe(404);
      expect(await send('GET', `/projects/${ghost}/candidates?size=1`)).toBe(404);
      expect(await send('PUT', `/projects/${ghost}/team`, { bindings: [], members: [] })).toBe(404);
      expect(
        await send('PUT', `/projects/${project.id}/team`, {
          bindings: [{ role: 'review', personaId: mintId('Persona') }],
          members: [],
        }),
      ).toBe(400);
      expect(await api.get('/events/head', EventsHead)).toEqual(head);
    } finally {
      repo.cleanup();
    }
    const persona = {
      key: 'sec',
      name: 'Sec',
      role: 'review',
      tools: 'read_only',
      instructions: 'Check auth.',
    };
    expect(await send('POST', '/personas', persona)).toBe(201);
    expect(await send('POST', '/people', { handle: 'sam', name: 'Sam' })).toBe(201);
    expect(
      await send('POST', '/flows', { name: 'mine', steps: [{ role: 'implement', need: 40 }] }),
    ).toBe(201);
  });

  it('closes its log file on stop, so a start leaks no file descriptor', async () => {
    const logPath = join(dir.path, 'logs', 'daemon.log');
    // The descriptors that point at daemon.log, found by identity so the count does not depend on GC.
    const openLogHandles = () => {
      // Not created yet: the destination hasn't opened it, so nothing points at it.
      if (!existsSync(logPath)) return 0;
      const log = statSync(logPath);
      return readdirSync('/dev/fd').filter((name) => {
        try {
          const handle = fstatSync(Number(name));
          return handle.ino === log.ino && handle.dev === log.dev;
        } catch {
          return false;
        }
      }).length;
    };
    const running = await startDaemon({
      sandbox: null,
      dataDir: dir.path,
      port: 0,
      adapter: new FakeAdapter({}),
      logLevel: 'warn',
      ...QUIET,
    });
    // The destination opens its file asynchronously.
    await waitFor(() => (openLogHandles() === 1 ? true : undefined));
    await running.stop();
    expect(openLogHandles()).toBe(0);
  });

  it.each<{ name: string; shellDir: string; configDir: string | null; warns: boolean }>([
    {
      name: "seeds the default account on the login shell's own Claude Code directory",
      shellDir: '/Users/b/.claude-work',
      configDir: '/Users/b/.claude-work',
      warns: false,
    },
    {
      name: "seeds the default account on Claude Code's default directory, with a warning, when the login shell sets a relative one",
      shellDir: '.claude-relative',
      configDir: null,
      warns: true,
    },
  ])('$name', async ({ shellDir, configDir, warns }) => {
    const running = await startDaemon({
      sandbox: null,
      dataDir: dir.path,
      port: 0,
      adapter: new FakeAdapter({}),
      logLevel: 'warn',
      loginEnv: { PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: shellDir },
      ...QUIET,
    });
    daemon = running;
    expect(listAccounts(running.state.db)).toMatchObject([
      { label: 'Claude plan', configDir, isDefault: true },
    ]);
    if (warns) {
      // The log is written asynchronously, so wait for the warning; it names the variable, never the value.
      const logPath = join(dir.path, 'logs', 'daemon.log');
      await waitFor(
        () => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('CLAUDE_CONFIG_DIR'),
      );
      expect(readFileSync(logPath, 'utf8')).not.toContain(shellDir);
    }
  });
});
