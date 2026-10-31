import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DaemonEvent, ProjectDto, TaskDto, WorkstreamDto } from '@10db/contracts';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readRuntimeInfo } from '../src/daemon';
import type { FakeScriptBook } from '../src/sessions';
import { apiClient, quickFlowId } from './api-client';
import { createTempRepo, isolatedGitEnv, tempDir, waitForAsync, type TempDir } from './fixtures';

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
        do: 'tool',
        toolName: 'Write',
        input: { file_path: 'src/x/two.txt', content: 'two\n' },
      },
      // A retry of the first operation with a path that now has changes: a retry that were not
      // idempotent would create a second commit carrying the first op's trailer.
      {
        do: 'mcp',
        tool: 'commit',
        args: { opId: 'op-x-00001', paths: ['src/x/two.txt'], message: 'Add one' },
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
      // The test's own temp dir: a sandboxed run can write no other.
      TMPDIR: tmpdir(),
      // The child's git must not read the contributor's own config (hooks, signing, templates).
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      TENDB_DATA_DIR: data.path,
      TENDB_PORT: '0',
      TENDB_LOG_LEVEL: 'warn',
      TENDB_FAKE_SCRIPTS: join(data.path, 'book.json'),
    },
    stdio: 'ignore',
  });
}

/**
 * How long a wait for the daemon to get somewhere may go on. This is a guard against a hang, not a
 * performance budget: a loaded machine can take minutes to boot a daemon, so a wait ends early only when
 * the daemon it waits on has died, which no load causes.
 */
const HANG_GUARD_MS = 300_000;

/** Waits until `check` returns a value, or fails at once if `daemon` exits before it does. */
async function waitForProgress<T>(
  daemon: ChildProcess,
  check: () => Promise<T | undefined | false>,
): Promise<T> {
  return waitForAsync(async () => {
    const value = await check();
    if (value === undefined || value === false) {
      if (daemon.exitCode !== null || daemon.signalCode !== null) {
        throw new Error(
          `the daemon exited (${String(daemon.exitCode ?? daemon.signalCode)}) before the wait finished`,
        );
      }
    }
    return value;
  }, HANG_GUARD_MS);
}

/** Connects to the daemon with `pid`; a daemon.json left by an earlier, killed daemon is skipped. */
async function connect(daemon: ChildProcess) {
  return waitForProgress(daemon, async () => {
    try {
      const info = readRuntimeInfo(data.path);
      if (info.pid !== daemon.pid) return undefined;
      const url = `http://127.0.0.1:${String(info.port)}`;
      const ok = await fetch(`${url}/health`).then((r) => r.ok);
      if (!ok) return undefined;
      return apiClient(url, readFileSync(join(data.path, 'ui-token'), 'utf8'));
    } catch {
      return undefined;
    }
  });
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
  it(
    'recovers, resumes, and finishes without duplicating the commit',
    async () => {
      child = launchDaemon();
      const first = child;
      let api = await connect(first);
      const project = await api.post('/projects', ProjectDto, {
        name: 'crash',
        repoPath: repo.path,
        gateCommand: 'test -f src/x/two.txt',
        flowId: await quickFlowId(api),
        areas: [{ name: 'x', globs: ['src/x/**'] }],
      });
      const task = await api.post(`/projects/${project.id}/tasks`, TaskDto, {
        title: 'Xray',
        acceptanceCriteria: ['two files'],
        areas: ['x'],
      });
      const ws = await api.post(`/tasks/${task.id}/start`, WorkstreamDto);
      await waitForProgress(first, async () =>
        (await api.get('/events?after=0&limit=1000', z.array(DaemonEvent))).find(
          (e) => e.type === 'session.activity' && e.data['summary'] === 'about to hang',
        ),
      );

      const killed = new Promise((r) => first.once('exit', r));
      first.kill('SIGKILL');
      await killed;

      const second = launchDaemon();
      child = second;
      api = await connect(second);
      const done = await waitForProgress(second, async () => {
        const list = await api.get('/workstreams?active=false', z.array(WorkstreamDto));
        const mine = list.find((w) => w.id === ws.id);
        return mine?.state === 'DONE' ? mine : undefined;
      });
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

      const trailers = execFileSync(
        'git',
        ['-C', repo.path, 'log', '--format=%(trailers:key=10db-Op,valueonly)'],
        { env: isolatedGitEnv() },
      )
        .toString()
        .split('\n')
        .filter(Boolean);
      expect(trailers.filter((t) => t === 'op-x-00001')).toHaveLength(1);
      expect(trailers.filter((t) => t === 'op-x-00002')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'commit.recorded')).toHaveLength(2);
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
      // Three waits, each ended by progress or by the daemon dying; this limit only has to exceed the
      // longest they may take (HANG_GUARD_MS each), so it is never what a loaded machine hits first.
    },
    3 * HANG_GUARD_MS + 60_000,
  );
});
