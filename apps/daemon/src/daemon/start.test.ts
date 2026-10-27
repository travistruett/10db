import {
  existsSync,
  fstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  BenchmarkStatusDto,
  BoardColumnDto,
  EventsHead,
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
import { getAccount, getWorkstream, listAccounts } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { WebSocket } from 'ws';
import { apiClient, quickFlowId } from '../../test/api-client';
import { createTempRepo, tempDir, waitFor, waitForAsync } from '../../test/fixtures';
import { ManualClock } from '../clock';
import type { CaffeinateSpawner } from '../keep-awake';
import { FakeAdapter, type FakeScriptBook, type SessionSpec } from '../sessions';
import { AlreadyRunningError, readRuntimeInfo, startDaemon, type RunningDaemon } from './index';

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
      laneSandbox: null,
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
        laneSandbox: null,
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
        laneSandbox: null,
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
      laneSandbox: null,
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

  it('stops while a UI client is still connected to the event stream', async () => {
    const running = await startDaemon({
      laneSandbox: null,
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
      laneSandbox: null,
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
      const running = await startDaemon({
        laneSandbox: null,
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
      const specs: SessionSpec[] = [];
      adapter.seen = (spec) => {
        specs.push(spec);
        return {};
      };
      const running = await startDaemon({
        laneSandbox: null,
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

  it('runs lanes under a lane sandbox built from its own data dir, home and git when the sandbox is on', async () => {
    const repo = createTempRepo();
    // A short root: the lane temp directory's whole path must fit the sandbox's limit.
    const tmpRoot = realpathSync(mkdtempSync('/tmp/sbd-'));
    try {
      const adapter = new FakeAdapter({ Alpha: [[{ do: 'turn_complete' }]] });
      const specs: SessionSpec[] = [];
      adapter.seen = (spec) => {
        specs.push(spec);
        return {};
      };
      const running = await startDaemon({
        dataDir: dir.path,
        port: 0,
        adapter,
        logLevel: 'warn',
        laneSandbox: { tmpRoot },
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
      const sandbox = specs[0]?.sandbox;
      expect(sandbox?.settings.filesystem.allowRead).toContain(realpathSync(repo.path));
      expect(sandbox?.settings.filesystem.denyRead).toEqual(
        expect.arrayContaining([dir.path, join(homedir(), '.claude.json')]),
      );
      expect(sandbox?.settings.network).not.toHaveProperty('allowLocalBinding');
      const laneTmp = sandbox?.env['CLAUDE_CODE_TMPDIR'] ?? '';
      expect(sandbox?.env['npm_config_cache']).toBe(join(laneTmp, 'cache', 'npm'));
      expect(dirname(laneTmp)).toBe(tmpRoot);
      // The session ended, so its temp dir is gone.
      expect(readdirSync(tmpRoot)).toEqual([]);
    } finally {
      repo.cleanup();
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

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
        laneSandbox: null,
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
      startDaemon({
        laneSandbox: null,
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

  it.each([
    { name: 'the built-in origins', allowedOrigins: undefined, base: 'http://localhost:1420' },
    {
      name: 'the origins it is given',
      allowedOrigins: ['http://localhost:3000'],
      base: 'http://localhost:3000',
    },
  ])(
    'lets a dev UI origin through CORS beside $name, and no other',
    async ({ allowedOrigins, base }) => {
      const running = await startDaemon({
        laneSandbox: null,
        dataDir: dir.path,
        port: 0,
        adapter: new FakeAdapter({}),
        logLevel: 'warn',
        ...(allowedOrigins ? { allowedOrigins } : {}),
        devUiOrigin: 'http://localhost:51234',
        ...QUIET,
      });
      daemon = running;
      const allowedOrigin = async (origin: string): Promise<string | null> =>
        (await fetch(`${running.url}/health`, { headers: { Origin: origin } })).headers.get(
          'access-control-allow-origin',
        );
      expect(await allowedOrigin('http://localhost:51234')).toBe('http://localhost:51234');
      expect(await allowedOrigin(base)).toBe(base);
      expect(await allowedOrigin('http://localhost:51235')).toBeNull();
    },
  );

  it('honors a fixed dev token and serves keep-awake, the event head and the system check', async () => {
    const token = 'd'.repeat(43);
    const spawned: number[] = [];
    const check: SystemCheckDto = {
      loginEnv: { source: 'login_shell', warning: null },
      claudeCode: { verifiedOn: '2.1.302', warning: null },
      tools: [{ name: 'git', path: '/usr/bin/git', version: 'git version 2.50.1', required: true }],
      benchmarkSync: null,
    };
    daemon = await startDaemon({
      laneSandbox: null,
      dataDir: dir.path,
      port: 0,
      adapter: new FakeAdapter({}),
      logLevel: 'warn',
      uiToken: token,
      caffeinate: recordingCaffeinate(spawned),
      systemCheck: () => Promise.resolve(check),
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
  });

  it('holds keep-awake and watches the repo while a lane runs, and lets go when it is cancelled', async () => {
    const repo = createTempRepo();
    const spawned: number[] = [];
    const roots: string[] = [];
    const closed: string[] = [];
    try {
      daemon = await startDaemon({
        laneSandbox: null,
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
        laneSandbox: null,
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
        laneSandbox: null,
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
      laneSandbox: null,
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

  it('seeds the team, reports no AA key, plans on hand-set scores, and refuses an over-budget start', async () => {
    const repo = createTempRepo();
    try {
      daemon = await startDaemon({
        laneSandbox: null,
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
      const profiles = await api.get('/model-profiles', z.array(ModelProfileDto));
      const sonnetHigh = profiles.find((p) => p.model === 'sonnet' && p.effort === 'high');
      if (!sonnetHigh) throw new Error('not seeded');
      // Hand-set (invented) scores: the profile becomes manual and the only measured one.
      expect(
        await api.patch(`/model-profiles/${sonnetHigh.id}`, ModelProfileDto, {
          scores: { intelligence: 50, coding: 50, agentic: 50 },
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
        'implement:sonnet@high',
        'review:sonnet@high',
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
        laneSandbox: null,
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
        laneSandbox: null,
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
      laneSandbox: null,
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
      laneSandbox: null,
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
      laneSandbox: null,
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
