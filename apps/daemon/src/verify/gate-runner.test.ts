import { readFileSync } from 'node:fs';
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
    const result = await run(`sh -c 'sleep 30' & echo started; wait`, 300);
    expect(result).toMatchObject({ exitCode: 124, timedOut: true });
    expect(result.durationMs).toBeLessThan(5_000);
  });

  it('kills the process group when aborted, and reports the spawned pid', async () => {
    const abort = new AbortController();
    const pids: number[] = [];
    const result = await runner.run({
      repo: dir.path,
      command: `sh -c 'sleep 30' & echo started; wait`,
      logPath: join(dir.path, 'logs', 'gate.log'),
      timeoutMs: 10_000,
      env: process.env,
      signal: abort.signal,
      onSpawn: (pid) => {
        pids.push(pid);
        setImmediate(() => {
          abort.abort();
        });
      },
    });
    expect(result).toMatchObject({ exitCode: 130, aborted: true, timedOut: false });
    expect(result.durationMs).toBeLessThan(5_000);
    expect(pids).toHaveLength(1);
  });

  it('keeps only the end of very long output in the tail', async () => {
    const result = await run(`yes line | head -n 5000; echo LAST-LINE`);
    expect(result.tail.length).toBeLessThanOrEqual(4096);
    expect(result.tail).toContain('LAST-LINE');
  });
});
