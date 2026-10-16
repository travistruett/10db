import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { createGateRunner } from './index';

const runner = createGateRunner();
let dir: { path: string; cleanup(): void };
beforeEach(() => {
  dir = tempDir('gate');
});
afterEach(() => {
  dir.cleanup();
});

const run = (command: string, timeoutMs = 10_000) =>
  runner.run({
    repo: dir.path,
    command,
    logPath: join(dir.path, 'logs', 'gate.log'),
    timeoutMs,
    env: process.env,
  });

const DEADLINE_MS = 10_000;

async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const isGone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

async function readPid(): Promise<number> {
  const file = join(dir.path, 'grandchild.pid');
  await waitUntil(
    () => existsSync(file) && readFileSync(file, 'utf8').endsWith('\n'),
    'grandchild pid',
  );
  return Number(readFileSync(file, 'utf8'));
}

const expectGone = (pid: number): Promise<void> =>
  waitUntil(() => isGone(pid), `pid ${String(pid)} to exit`);

describe('gate runner', () => {
  it('records a passing gate with its output in the log and the tail', async () => {
    const result = await run('echo checks-ok');
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.tail).toContain('checks-ok');
    expect(readFileSync(result.logPath, 'utf8')).toContain('checks-ok');
  });

  it('records the exit code of a failing gate and stderr', async () => {
    const result = await run('echo broken >&2; exit 3');
    expect(result.exitCode).toBe(3);
    expect(result.tail).toContain('broken');
  });

  it('kills the whole process group on timeout', async () => {
    const result = await run(`sh -c 'sleep 30' & echo $! > grandchild.pid; wait`, 1_000);
    expect(result).toMatchObject({ exitCode: 124, timedOut: true });
    expect(result.durationMs).toBeLessThan(5_000);
    await expectGone(await readPid());
  });

  it('kills the process group when aborted, and reports the spawned pid', async () => {
    const abort = new AbortController();
    const pids: number[] = [];
    const pending = runner.run({
      repo: dir.path,
      command: `sh -c 'sleep 30' & echo $! > grandchild.pid; wait`,
      logPath: join(dir.path, 'logs', 'gate.log'),
      timeoutMs: 10_000,
      env: process.env,
      signal: abort.signal,
      onSpawn: (pid) => {
        pids.push(pid);
      },
    });
    const grandchild = await readPid();
    abort.abort();
    const result = await pending;
    expect(result).toMatchObject({ exitCode: 130, aborted: true, timedOut: false });
    expect(result.durationMs).toBeLessThan(5_000);
    expect(pids).toHaveLength(1);
    await expectGone(grandchild);
  });

  it('rejects and kills the group when onSpawn throws', async () => {
    let leader = 0;
    await expect(
      runner.run({
        repo: dir.path,
        command: 'sleep 30',
        logPath: join(dir.path, 'logs', 'gate.log'),
        timeoutMs: 10_000,
        env: process.env,
        onSpawn: (pid) => {
          leader = pid;
          throw new Error('stale fence');
        },
      }),
    ).rejects.toThrow('stale fence');
    await expectGone(leader);
  });

  it('still runs the gate when the log cannot be written', async () => {
    const result = await runner.run({
      repo: dir.path,
      command: 'echo still-runs',
      logPath: dir.path,
      timeoutMs: 10_000,
      env: process.env,
    });
    expect(result.exitCode).toBe(0);
    expect(result.tail).toContain('still-runs');
  });

  it('keeps only the end of very long output in the tail', async () => {
    const result = await run(`yes line | head -n 5000; echo LAST-LINE`);
    expect(result.tail.length).toBeLessThanOrEqual(4096);
    expect(result.tail).toContain('LAST-LINE');
  });
});
