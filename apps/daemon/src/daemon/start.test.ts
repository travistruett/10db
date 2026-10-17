import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  EventsHead,
  KeepAwakeStatus,
  ProjectDto,
  TaskDto,
  WorkstreamDto,
  WorkstreamId,
  type SystemCheckDto,
} from '@10db/contracts';
import { getWorkstream } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { WebSocket } from 'ws';
import { apiClient } from '../../test/api-client';
import { createTempRepo, tempDir, waitFor, waitForAsync } from '../../test/fixtures';
import type { CaffeinateSpawner } from '../keep-awake';
import { FakeAdapter, type FakeScriptBook } from '../sessions';
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

  it('does not count a clean stop against the recovery limit', async () => {
    const repo = createTempRepo();
    const book: FakeScriptBook = { Alpha: [[{ do: 'hang' }], [{ do: 'hang' }]] };
    const start = () =>
      startDaemon({
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

  it('honors a fixed dev token and serves keep-awake, the event head and the system check', async () => {
    const token = 'd'.repeat(43);
    const spawned: number[] = [];
    const check: SystemCheckDto = {
      loginEnv: { source: 'login_shell', warning: null },
      tools: [{ name: 'git', path: '/usr/bin/git', version: 'git version 2.50.1', required: true }],
    };
    daemon = await startDaemon({
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
});
