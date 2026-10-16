import { statSync } from 'node:fs';
import { join } from 'node:path';
import { WorkstreamId } from '@10db/contracts';
import { getWorkstream } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { WebSocket } from 'ws';
import { createTempRepo, tempDir, waitFor } from '../../test/fixtures';
import { FakeAdapter, type FakeScriptBook } from '../sessions';
import { AlreadyRunningError, readRuntimeInfo, startDaemon, type RunningDaemon } from './index';

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
    const start = () =>
      startDaemon({
        dataDir: dir.path,
        port: 0,
        adapter: new FakeAdapter({}),
        logLevel: 'warn',
      });
    const running = await start();
    const first = running.stop();
    const second = running.stop();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    await expect(running.stop()).resolves.toBeUndefined();
    expect(() => readRuntimeInfo(dir.path)).toThrow();
    daemon = await start();
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
});
