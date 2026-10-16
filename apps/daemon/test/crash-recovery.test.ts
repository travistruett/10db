import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DaemonEvent, ProjectDto, TaskDto, WorkstreamDto } from '@10db/contracts';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readRuntimeInfo } from '../src/daemon';
import type { FakeScriptBook } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, tempDir, waitForAsync, type TempDir } from './fixtures';

const DAEMON_DIR = resolve(import.meta.dirname, '..');
const BOOK: FakeScriptBook = {
  Xray: [
    [
      {
        do: 'tool',
        toolName: 'Write',
        input: { file_path: 'src/x/one.txt', content: 'one\n' },
      },
      {
        do: 'mcp',
        tool: 'commit',
        args: { opId: 'op-x-00001', paths: ['src/x/one.txt'], message: 'Add one' },
      },
      { do: 'activity', summary: 'about to hang' },
      { do: 'hang' },
    ],
    [
      {
        do: 'mcp',
        tool: 'commit',
        args: { opId: 'op-x-00001', paths: ['src/x/one.txt'], message: 'Add one' },
      },
      {
        do: 'tool',
        toolName: 'Write',
        input: { file_path: 'src/x/two.txt', content: 'two\n' },
      },
      {
        do: 'mcp',
        tool: 'commit',
        args: { opId: 'op-x-00002', paths: ['src/x/two.txt'], message: 'Add two' },
      },
      { do: 'turn_complete' },
    ],
  ],
};

let repo: TempDir;
let data: TempDir;
let child: ChildProcess | null = null;

function launchDaemon(): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: DAEMON_DIR,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      TENDB_DATA_DIR: data.path,
      TENDB_PORT: '0',
      TENDB_LOG_LEVEL: 'warn',
      TENDB_FAKE_SCRIPTS: join(data.path, 'book.json'),
    },
    stdio: 'ignore',
  });
}

/** Connects to the daemon with `pid`; a daemon.json left by an earlier, killed daemon is skipped. */
async function connect(pid: number | undefined) {
  return waitForAsync(async () => {
    try {
      const info = readRuntimeInfo(data.path);
      if (info.pid !== pid) return undefined;
      const url = `http://127.0.0.1:${String(info.port)}`;
      const ok = await fetch(`${url}/health`).then((r) => r.ok);
      if (!ok) return undefined;
      return apiClient(url, readFileSync(join(data.path, 'ui-token'), 'utf8'));
    } catch {
      return undefined;
    }
  }, 20_000);
}

beforeAll(() => {
  repo = createTempRepo();
  data = tempDir('crash');
  writeFileSync(join(data.path, 'book.json'), JSON.stringify(BOOK));
});
afterAll(() => {
  child?.kill('SIGKILL');
  repo.cleanup();
  data.cleanup();
});

describe('kill -9 mid-step', () => {
  it('recovers, resumes, and finishes without duplicating the commit', async () => {
    child = launchDaemon();
    let api = await connect(child.pid);
    const project = await api.post('/projects', ProjectDto, {
      name: 'crash',
      repoPath: repo.path,
      gateCommand: 'test -f src/x/two.txt',
      areas: [{ name: 'x', globs: ['src/x/**'] }],
    });
    const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
      title: 'Xray',
      acceptanceCriteria: ['two files'],
      areas: ['x'],
    });
    const ws = await api.post(`/tasks/${task.id}/start`, WorkstreamDto);
    await waitForAsync(async () =>
      (await api.get('/events?after=0&limit=1000', z.array(DaemonEvent))).find(
        (e) => e.type === 'session.activity' && e.data['summary'] === 'about to hang',
      ),
    );

    const killed = new Promise((r) => child?.once('exit', r));
    child.kill('SIGKILL');
    await killed;

    child = launchDaemon();
    api = await connect(child.pid);
    const done = await waitForAsync(async () => {
      const list = await api.get('/workstreams?active=false', z.array(WorkstreamDto));
      const mine = list.find((w) => w.id === ws.id);
      return mine?.state === 'DONE' ? mine : undefined;
    }, 30_000);
    // The kill counted as a failed attempt, then the step_done that followed reset the count.
    expect(done.recoveryAttempts).toBe(0);

    const events = await api.get('/events?after=0&limit=5000', z.array(DaemonEvent));
    expect(
      events.some(
        (e) =>
          e.type === 'workstream.changed' &&
          e.data['to'] === 'RECOVERING' &&
          e.data['reason'] === 'daemon restarted',
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === 'recovery.step')).toBe(true);

    const trailers = execFileSync('git', [
      '-C',
      repo.path,
      'log',
      '--format=%(trailers:key=10db-Op,valueonly)',
    ])
      .toString()
      .split('\n')
      .filter(Boolean);
    expect(trailers.filter((t) => t === 'op-x-00001')).toHaveLength(1);
    const db = new Database(join(data.path, '10db.sqlite'), { readonly: true });
    const ops = z
      .object({ n: z.number() })
      .parse(db.prepare("SELECT count(*) AS n FROM tool_ops WHERE op_id = 'op-x-00001'").get());
    const sessions = z
      .array(z.object({ exit_reason: z.string() }))
      .parse(
        db
          .prepare('SELECT exit_reason FROM sessions WHERE workstream_id = ? ORDER BY sequence')
          .all(ws.id),
      );
    db.close();
    expect(ops.n).toBe(1);
    expect(sessions.map((s) => s.exit_reason)).toEqual(['daemon_restart', 'step_done']);
    // Two daemon boots plus a 30 s wait budget: far beyond vitest's 5 s default, and CI is slower.
  }, 90_000);
});
