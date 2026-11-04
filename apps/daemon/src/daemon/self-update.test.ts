import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  BatchDto,
  HealthResponse,
  ProjectDto,
  SelfUpdateStatusDto,
  TaskDto,
  WorkstreamDto,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { apiClient, quickFlowId } from '../../test/api-client';
import { FakeGh } from '../../test/fake-gh';
import {
  createTempRepo,
  createTempRepoWithOrigin,
  githubOrigin,
  isolatedGitEnv,
  NETWORK_ENV,
  tempDir,
  waitFor,
  waitForAsync,
} from '../../test/fixtures';
import { FakeAdapter } from '../sessions';
import type { ScriptInstaller, ScriptStatus } from '../self-update';

import { startDaemon, type RunningDaemon } from './index';

const RUNNING = '1'.repeat(40);
const NEW = '2'.repeat(40);
/** The repository the test build was made for: the only one it follows. */
const BUILT_FOR = 'acme/10db';
const QUIET = { caffeinate: () => null, watch: false } as const;
const inboxCard = z.object({ title: z.string(), body: z.string(), projectId: z.string() });

let dir: { path: string; cleanup(): void };
let daemon: RunningDaemon | null;
let repo: { path: string; cleanup(): void };
let staged: string[];
let applied: string[];
let head: string;
/** Whether main is ahead of the running commit, as GitHub's comparison says. */
let ahead: boolean;
/** How many times main's head was asked: a check ran for each. */
let heads: number;
/** While true, asking GitHub for main's head fails, as it does offline or signed out. */
let failHead: boolean;
let installer: ScriptInstaller;
/** What the install script left behind, as the next daemon finds it. */
let status: ScriptStatus | null;
/** The commit make rollback-app recorded it replaced, as the next daemon finds it. */
let rolledBackFrom: string | null;
/** Ends the detached install script while the daemon still runs; it never ends by itself. */
let endScript: () => void;

beforeEach(() => {
  status = null;
  rolledBackFrom = null;
  endScript = () => undefined;
  dir = tempDir('daemon-self-update');
  daemon = null;
  staged = [];
  applied = [];
  head = NEW;
  ahead = true;
  heads = 0;
  installer = {
    stage: (target) => {
      staged.push(target.repo);
      return Promise.resolve({
        ok: true,
        current: false,
        dir: join(dir.path, 'stage'),
        commit: head,
      });
    },
    stop: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
    rollback: {
      read: () => rolledBackFrom,
      clear: () => {
        rolledBackFrom = null;
      },
    },
    apply: (build) => {
      applied.push(build.commit);
      const ended = new Promise<void>((resolve) => {
        endScript = resolve;
      });
      return Promise.resolve({ ok: true, ended });
    },
    outcome: {
      read: () => status,
      clear: () => {
        status = null;
      },
    },
  };
  // A project whose origin is somebody else's repository: it has no say in where updates come from.
  repo = createTempRepo();
  execFileSync(
    'git',
    ['-C', repo.path, 'remote', 'add', 'origin', 'https://github.com/someone-else/app.git'],
    { env: isolatedGitEnv(), stdio: 'pipe' },
  );
});
afterEach(async () => {
  await daemon?.stop();
  repo.cleanup();
  dir.cleanup();
});

async function start(
  options: {
    updatable?: boolean;
    repository?: string | null;
    /** GitHub can't be reached, until the test sets `failHead` false. */
    failHead?: boolean;
    intervalMs?: number;
    adapter?: FakeAdapter;
    caps?: { global: number };
    /** What a batch's delivery reaches GitHub with: a project that ships needs both. */
    delivery?: { gh: FakeGh; networkEnv: () => Readonly<Record<string, string>> };
  } = {},
): Promise<ReturnType<typeof apiClient>> {
  failHead = options.failHead ?? false;
  daemon = await startDaemon({
    sandbox: null,
    dataDir: dir.path,
    port: 0,
    adapter: options.adapter ?? new FakeAdapter({}),
    logLevel: 'warn',
    ...(options.caps ? { caps: options.caps } : {}),
    ...options.delivery,
    build: {
      commit: RUNNING,
      repository: options.repository === undefined ? BUILT_FOR : options.repository,
      releaseDir: join(dir.path, 'release'),
      updatable: options.updatable ?? true,
    },
    selfUpdate: {
      intervalMs: options.intervalMs ?? 20,
      headOf: () => {
        heads += 1;
        return failHead ? Promise.reject(new Error('gh: offline')) : Promise.resolve(head);
      },
      isAhead: () => Promise.resolve(ahead),
      installer,
    },
    ...QUIET,
  });
  return apiClient(daemon.url, daemon.token);
}

async function addProject(api: ReturnType<typeof apiClient>) {
  return api.post('/projects', ProjectDto, {
    name: '10db',
    repoPath: repo.path,
    gateCommand: 'true',
    flowId: await quickFlowId(api),
    areas: [{ name: 'src', globs: ['src/**'] }],
  });
}

const selfUpdate = (api: ReturnType<typeof apiClient>) =>
  api.get('/settings/self-update', SelfUpdateStatusDto);

/** Waits until main was looked at `n` more times, so that many checks ran after this point. */
const afterChecks = async (n: number): Promise<void> => {
  const target = heads + n;
  await waitFor(() => heads >= target);
};

const failureCards = async (api: ReturnType<typeof apiClient>) =>
  (await api.get('/inbox', z.array(inboxCard))).filter((card) =>
    card.title.startsWith('Updating 10db failed'),
  );

describe('self-update in the daemon', () => {
  it('names the commit it runs in /health', async () => {
    await start();
    const health = HealthResponse.parse(await (await fetch(`${daemon?.url ?? ''}/health`)).json());
    expect(health.commit).toBe(RUNNING);
  });

  it('installs the build of the repository the app was built for, with no action from the builder', async () => {
    const api = await start();
    await addProject(api);
    await waitFor(() => applied.length > 0 && applied);
    // Not the project's origin: the repository was fixed when the app was built.
    expect(staged).toEqual([BUILT_FOR]);
    expect(applied).toEqual([NEW]);
    expect(await selfUpdate(api)).toMatchObject({
      enabled: true,
      isDefault: true,
      runningCommit: RUNNING,
      availableCommit: NEW,
      waitMinutes: 15,
    });
  });

  it('needs no project: the update follows the app, not a checkout', async () => {
    await start();
    await waitFor(() => applied.length > 0 && applied);
    expect(staged).toEqual([BUILT_FOR]);
  });

  it('is one switch for the whole app, kept across a restart', async () => {
    // Main is the running commit, so there is nothing to install while the switch is turned off.
    head = RUNNING;
    const api = await start({ intervalMs: 3_600_000 });
    const off = await api.put('/settings/self-update', SelfUpdateStatusDto, { enabled: false });
    expect(off).toMatchObject({ enabled: false, isDefault: false });
    await daemon?.stop();
    daemon = null;

    // Main moved on while the app was off.
    head = NEW;
    heads = 0;
    const next = await start();
    expect(await selfUpdate(next)).toMatchObject({ enabled: false, isDefault: false });
    // With the switch off a check asks GitHub nothing, so there is no event to wait on: let a few
    // intervals (20 ms each) pass, and nothing is fetched or installed by itself.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(heads).toBe(0);
    expect(staged).toEqual([]);
    expect(applied).toEqual([]);

    // Turning it on is what starts the update.
    await next.put('/settings/self-update', SelfUpdateStatusDto, { enabled: true });
    await waitFor(() => applied.length > 0 && applied);
    expect(staged).toEqual([BUILT_FOR]);
  });

  it('shows its commit but never replaces a copy that is not the one in Applications', async () => {
    const api = await start({ updatable: false });
    expect(await selfUpdate(api)).toMatchObject({
      runningCommit: RUNNING,
      availableCommit: null,
    });
    expect(heads).toBe(0);
    expect(staged).toEqual([]);
    expect(applied).toEqual([]);
  });

  it('never replaces a build that knows no repository', async () => {
    const api = await start({ repository: null });
    expect(await selfUpdate(api)).toMatchObject({ runningCommit: RUNNING });
    expect(heads).toBe(0);
    expect(applied).toEqual([]);
  });

  describe('says in Settings why the app cannot update itself', () => {
    it('has no reason while it can', async () => {
      const api = await start();
      await waitFor(() => applied.length > 0 && applied);
      expect((await selfUpdate(api)).blocker).toBeNull();
    });

    it('names a copy outside Applications', async () => {
      const api = await start({ updatable: false });
      expect((await selfUpdate(api)).blocker).toMatchObject({ kind: 'not-in-applications' });
    });

    it('names a build with no repository', async () => {
      const api = await start({ repository: null, updatable: false });
      expect((await selfUpdate(api)).blocker).toMatchObject({ kind: 'no-repository' });
    });

    it('names a GitHub that cannot be reached, and stops once it can', async () => {
      const api = await start({ failHead: true });
      await waitForAsync(async () => (await selfUpdate(api)).blocker?.kind === 'unreachable');
      head = RUNNING;
      failHead = false;
      await waitForAsync(async () => (await selfUpdate(api)).blocker === null);
    });

    it('names a failed update when no project is registered to carry its card', async () => {
      installer.stage = () =>
        Promise.resolve({ ok: false, step: 'download', message: 'connection reset' });
      const api = await start();
      const found = await waitForAsync(async () => {
        const { blocker } = await selfUpdate(api);
        return blocker?.kind === 'failed' && blocker;
      });
      expect(found.message).toContain('connection reset');
      // The builder turning the switch off and on is what tries again.
      expect(found.message).toContain('Update 10db by itself');
    });
  });

  it('leaves a build from another branch alone: main is not ahead of it', async () => {
    ahead = false;
    const api = await start();
    await addProject(api);
    await afterChecks(3);
    expect(staged).toEqual([]);
    expect(applied).toEqual([]);
    expect(await selfUpdate(api)).toMatchObject({ availableCommit: null });
    // Once main is ahead of it, the same build is updated.
    ahead = true;
    await waitFor(() => applied.length > 0 && applied);
  });

  it('waits while a lane is mid-session: the build is fetched, and nothing is installed', async () => {
    // Main is the running commit until the lane is under way: a check that found nothing mid-session
    // would install at once, and hold the scheduler back for good.
    head = RUNNING;
    const api = await start({ adapter: new FakeAdapter({ Alpha: [[{ do: 'hang' }]] }) });
    const project = await addProject(api);
    const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
      title: 'Alpha',
      acceptanceCriteria: ['it works'],
      areas: ['src'],
    });
    await api.post(`/tasks/${task.id}/start`, z.unknown());
    // The lane holds its session until the daemon stops.
    await waitForAsync(async () => {
      const lanes = await api.get('/workstreams?active=true', z.array(WorkstreamDto));
      return lanes.some((w) => w.taskId === task.id && ['STARTING', 'RUNNING'].includes(w.state));
    });
    // Main moves on.
    head = NEW;
    await waitFor(() => staged.length > 0);
    await afterChecks(5);
    expect(applied).toEqual([]);
    expect(staged).toEqual([BUILT_FOR]);
  });

  describe('a waiting update drains the factory', () => {
    const lanesOf = async (api: ReturnType<typeof apiClient>) =>
      new Map(
        (await api.get('/workstreams?active=true', z.array(WorkstreamDto))).map((w) => [
          w.taskId,
          w,
        ]),
      );
    const startTask = async (
      api: ReturnType<typeof apiClient>,
      projectId: string,
      title: string,
      area: string,
    ) => {
      const task = await api.post(`/projects/${projectId}/tasks`, TaskDto, {
        title,
        acceptanceCriteria: ['it works'],
        areas: [area],
      });
      await api.post(`/tasks/${task.id}/start`, z.unknown());
      return task;
    };

    /** A lane holds its session, an update waits past a limit of 0 minutes, and the factory drains. */
    async function drained() {
      head = RUNNING;
      const api = await start({
        caps: { global: 2 },
        adapter: new FakeAdapter({ Alpha: [[{ do: 'hang' }]], Beta: [[{ do: 'hang' }]] }),
      });
      await api.put('/settings/self-update/wait', SelfUpdateStatusDto, { minutes: 0 });
      const project = await api.post('/projects', ProjectDto, {
        name: '10db',
        repoPath: repo.path,
        gateCommand: 'true',
        flowId: await quickFlowId(api),
        areas: [
          { name: 'src', globs: ['src/**'] },
          { name: 'docs', globs: ['docs/**'] },
        ],
      });
      const alpha = await startTask(api, project.id, 'Alpha', 'src');
      // RUNNING: its session has begun. A lane still STARTING when the drain begins waits at the hold
      // before it starts one, and the update does not count it.
      await waitForAsync(async () => (await lanesOf(api)).get(alpha.id)?.state === 'RUNNING');
      // Main moves on while the lane is mid-session.
      head = NEW;
      await waitForAsync(async () => (await selfUpdate(api)).draining);
      return { api, project, alpha };
    }

    it('says since when it drains, holds a queued lane back, stops nothing, and installs once the running step is done', async () => {
      const { api, project, alpha } = await drained();
      const status = await selfUpdate(api);
      expect(status).toMatchObject({ availableCommit: NEW, waitMinutes: 0, draining: true });
      expect(status.drainingSince).not.toBeNull();
      expect(status.waitingSince).not.toBeNull();

      // A lane cap of 2 leaves room, yet the second task starts nothing while the factory drains.
      const beta = await startTask(api, project.id, 'Beta', 'docs');
      await afterChecks(5);
      const lanes = await lanesOf(api);
      expect(lanes.get(beta.id)?.state).toBe('QUEUED');
      // The running lane was neither stopped nor finished.
      expect(['STARTING', 'RUNNING']).toContain(lanes.get(alpha.id)?.state);
      expect(applied).toEqual([]);

      // The step ends (here the builder cancels the lane): the app installs, with Beta still queued.
      await api.post(`/workstreams/${lanes.get(alpha.id)?.id ?? ''}/cancel`, z.unknown());
      await waitFor(() => applied.length > 0 && applied);
      expect(applied).toEqual([NEW]);
      expect((await lanesOf(api)).get(beta.id)?.state).toBe('QUEUED');
    });

    it('lets lanes start again when the builder turns the switch off', async () => {
      const { api, project } = await drained();
      const beta = await startTask(api, project.id, 'Beta', 'docs');
      await afterChecks(3);
      expect((await lanesOf(api)).get(beta.id)?.state).toBe('QUEUED');
      const off = await api.put('/settings/self-update', SelfUpdateStatusDto, { enabled: false });
      expect(off).toMatchObject({ draining: false, drainingSince: null, waitingSince: null });
      await waitForAsync(async () =>
        ['STARTING', 'RUNNING'].includes((await lanesOf(api)).get(beta.id)?.state ?? ''),
      );
      expect(applied).toEqual([]);
    });

    it('drains at once at Install Now, though the update has waited no time', async () => {
      head = RUNNING;
      const api = await start({
        caps: { global: 2 },
        adapter: new FakeAdapter({ Alpha: [[{ do: 'hang' }]], Beta: [[{ do: 'hang' }]] }),
      });
      const project = await addProject(api);
      const alpha = await startTask(api, project.id, 'Alpha', 'src');
      await waitForAsync(async () => (await lanesOf(api)).get(alpha.id)?.state === 'RUNNING');
      head = NEW;
      // The default limit is 15 minutes: the update only waits.
      await waitForAsync(async () => (await selfUpdate(api)).availableCommit === NEW);
      expect(await selfUpdate(api)).toMatchObject({ draining: false, waitMinutes: 15 });
      const now = await api.post('/settings/self-update/install-now', SelfUpdateStatusDto);
      expect(now).toMatchObject({ draining: true });
      expect(now.drainingSince).not.toBeNull();
      const beta = await startTask(api, project.id, 'Beta', 'src');
      await afterChecks(3);
      expect((await lanesOf(api)).get(beta.id)?.state).toBe('QUEUED');
    });

    it('installs with two lanes of one batch held at their gates, neither waiting on the other', async () => {
      const remote = createTempRepoWithOrigin();
      const network = githubOrigin(remote.repo.path, remote.origin.path);
      try {
        head = RUNNING;
        const sessionEnd = [
          { do: 'await_message', contains: 'go' },
          { do: 'turn_complete' },
        ] as const;
        const adapter = new FakeAdapter({ Alpha: [[...sessionEnd]], Beta: [[...sessionEnd]] });
        const started = vi.spyOn(adapter, 'start');
        const api = await start({
          caps: { global: 2 },
          adapter,
          delivery: {
            gh: new FakeGh(),
            networkEnv: () => ({ ...NETWORK_ENV, GIT_CONFIG_GLOBAL: network.global }),
          },
        });
        await api.put('/settings/self-update/wait', SelfUpdateStatusDto, { minutes: 0 });
        const project = await api.post('/projects', ProjectDto, {
          name: 'shop',
          repoPath: remote.repo.path,
          gateCommand: 'true',
          flowId: await quickFlowId(api),
          areas: [
            { name: 'api', globs: ['src/api/**'] },
            { name: 'ui', globs: ['src/ui/**'] },
          ],
          delivery: 'pull_request',
          prTitlePrefix: 'feat(app)',
        });
        const task = (title: string, area: string) =>
          api.post(`/projects/${project.id}/tasks`, TaskDto, {
            title,
            acceptanceCriteria: ['it works'],
            areas: [area],
          });
        const alpha = await task('Alpha', 'api');
        const beta = await task('Beta', 'ui');
        await api.post(`/projects/${project.id}/batches`, z.tuple([BatchDto]), {
          title: 'Greetings',
          taskIds: [alpha.id, beta.id],
        });
        // A real cut, which a loaded Mac can take seconds over.
        await waitFor(() => started.mock.results.length === 2, 30_000);

        head = NEW;
        await waitForAsync(async () => (await selfUpdate(api)).draining);
        expect(applied).toEqual([]);

        // Both sessions end during the drain, so both lanes reach their gates.
        for (const session of started.mock.results)
          (session.value as { send(text: string): void }).send('go');
        await waitFor(() => applied.length > 0 && applied, 20_000);
        expect(applied).toEqual([NEW]);
        const lanes = await lanesOf(api);
        expect(lanes.get(alpha.id)?.state).toBe('VERIFYING');
        expect(lanes.get(beta.id)?.state).toBe('VERIFYING');
      } finally {
        await daemon?.stop();
        daemon = null;
        network.cleanup();
        remote.cleanup();
      }
    }, 60_000);
  });

  it('raises one card naming the failing step when the build fails, and installs nothing', async () => {
    installer.stage = (target) => {
      staged.push(target.repo);
      return Promise.resolve({
        ok: false,
        step: 'verify-checksum',
        message: 'checksum mismatch',
      });
    };
    const api = await start();
    // The first check ran at start, before any project could carry its card: it only logged. The
    // builder touching the switch lets the failed commit be tried again, now with a project.
    await waitFor(() => staged.length > 0 && staged);
    await addProject(api);
    await api.put('/settings/self-update', SelfUpdateStatusDto, { enabled: true });
    const failures = await waitForAsync(async () => {
      const found = await failureCards(api);
      return found.length > 0 && found;
    });
    // More checks run after the failure; the failed commit is not tried again by itself.
    await afterChecks(3);
    expect(await failureCards(api)).toHaveLength(1);
    expect(failures[0]?.title).toContain('checking the download');
    expect(failures[0]?.body).toContain('checksum mismatch');
    expect(applied).toEqual([]);
    expect(staged).toHaveLength(2);
  });

  it('carries queued work across the update: it is still queued after, and runs', async () => {
    // No lane may start, so the task stays queued while the update installs around it.
    const api = await start({ caps: { global: 0 } });
    const project = await addProject(api);
    const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
      title: 'Alpha',
      acceptanceCriteria: ['it works'],
      areas: ['src'],
    });
    await api.post(`/tasks/${task.id}/start`, z.unknown());
    await waitFor(() => applied.length > 0 && applied);
    const queued = await api.get('/workstreams?active=true', z.array(WorkstreamDto));
    expect(queued.map((w) => [w.taskId, w.state])).toEqual([[task.id, 'QUEUED']]);

    // The app quits and the new one starts on the same data directory.
    await daemon?.stop();
    daemon = null;
    applied = [];
    head = RUNNING;
    const next = await start({
      adapter: new FakeAdapter({ Alpha: [[{ do: 'turn_complete' }]] }),
    });
    await waitForAsync(async () =>
      (await next.get('/workstreams?active=false', z.array(WorkstreamDto))).some(
        (w) => w.taskId === task.id && w.state === 'DONE',
      ),
    );
  });

  it('lets work go on and raises one card when the install fails before the app quits', async () => {
    const api = await start({
      adapter: new FakeAdapter({ Alpha: [[{ do: 'turn_complete' }]] }),
    });
    const project = await addProject(api);
    await waitFor(() => applied.length > 0 && applied);
    // Another make install-app holds the lock: the script stops before it quits this app.
    status = {
      ok: false,
      step: 'lock',
      message: 'another make install-app or make rollback-app holds the lock',
      commit: NEW,
    };
    endScript();
    const failures = await waitForAsync(async () => {
      const found = await failureCards(api);
      return found.length > 0 && found;
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.title).toContain('taking the install lock');
    expect(failures[0]?.projectId).toBe(project.id);

    // The scheduler runs again: a task started now goes to the end.
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
    // The failed commit is not tried again by itself.
    expect(applied).toEqual([NEW]);
  });

  it('lets work go on and raises one card when starting the install throws', async () => {
    // As the installer's own file calls would, before it has started anything (apply.log a folder).
    installer.apply = (build) => {
      applied.push(build.commit);
      throw new Error("EISDIR: illegal operation on a directory, open 'apply.log'");
    };
    const api = await start({
      adapter: new FakeAdapter({ Alpha: [[{ do: 'turn_complete' }]] }),
    });
    // The first check ran before any project could carry its card; touching the switch tries the
    // failed commit again, now with one.
    await waitFor(() => applied.length > 0);
    const project = await addProject(api);
    await api.put('/settings/self-update', SelfUpdateStatusDto, { enabled: true });
    const failures = await waitForAsync(async () => {
      const found = await failureCards(api);
      return found.length > 0 && found;
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.title).toContain('starting the install');
    expect(failures[0]?.body).toContain('EISDIR');

    // The scheduler runs again: a task started now runs to the end.
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
    // More checks ran; the failed commit is not tried again by itself.
    await afterChecks(3);
    expect(applied).toEqual([NEW, NEW]);
  });

  it('stops a stage under way when the app quits', async () => {
    let stageStopped = false;
    installer.stage = (target) => {
      staged.push(target.repo);
      // Waiting for the build of main, which only the stop ends.
      return new Promise((resolve) => {
        installer.stop = () => {
          stageStopped = true;
          resolve({ ok: false, step: 'stage', message: 'stopped' });
          return Promise.resolve();
        };
      });
    };
    await start();
    await waitFor(() => staged.length > 0);
    await daemon?.stop();
    daemon = null;
    expect(stageStopped).toBe(true);
  });

  it('kills a stage under way when the builder turns the switch off, and installs nothing', async () => {
    let finish: (result: { ok: false; step: string; message: string }) => void = () => undefined;
    installer.stage = (target) => {
      staged.push(target.repo);
      // Waiting for the build of main, which only the cancel ends.
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    let cancelled = false;
    installer.cancel = () => {
      cancelled = true;
      finish({ ok: false, step: 'stage', message: 'turned off' });
      return Promise.resolve();
    };
    const api = await start();
    await waitFor(() => staged.length > 0);
    await api.put('/settings/self-update', SelfUpdateStatusDto, { enabled: false });
    await waitFor(() => cancelled);
    // Checks go on asking nothing while the switch is off.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(applied).toEqual([]);
    expect(staged).toHaveLength(1);
    expect(await failureCards(api)).toEqual([]);
  });

  it('stays on the build make rollback-app put back, for the same head of main', async () => {
    // The builder rolled back from NEW, which main's head still is, to RUNNING.
    rolledBackFrom = NEW;
    const api = await start();
    await afterChecks(3);
    expect(rolledBackFrom).toBeNull();
    expect(staged).toEqual([]);
    expect(applied).toEqual([]);
    expect(await failureCards(api)).toEqual([]);

    // A restart keeps it: the daemon recorded the rollback in its database.
    await daemon?.stop();
    daemon = null;
    await start();
    await afterChecks(3);
    expect(applied).toEqual([]);
  });

  it('installs again after a rollback once the builder touches the switch', async () => {
    rolledBackFrom = NEW;
    const api = await start();
    await afterChecks(2);
    await api.put('/settings/self-update', SelfUpdateStatusDto, { enabled: true });
    await waitFor(() => applied.length > 0 && applied);
    expect(applied).toEqual([NEW]);
  });

  it('reports an install that failed after the app quit, once, on the next start', async () => {
    const api = await start({ caps: { global: 0 } });
    const project = await addProject(api);
    await waitFor(() => applied.length > 0 && applied);
    await daemon?.stop();
    daemon = null;
    // The install script failed after quitting, put the old app back and wrote why.
    status = {
      ok: false,
      step: 'backup-database',
      message: 'sqlite3 could not back up the database',
      commit: NEW,
    };
    head = RUNNING;
    const next = await start({ caps: { global: 0 } });
    const failures = await failureCards(next);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.title).toContain('backing up the database');
    expect(failures[0]?.projectId).toBe(project.id);
  });
});
