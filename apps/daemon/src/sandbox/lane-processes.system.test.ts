import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createLaneProcessWatch,
  createProcessLedger,
  reapLaneProcessLedgers,
} from './lane-processes';
import { systemProcessTable } from './process-table';

/**
 * The real process table and real signals, on processes this test starts: a shell that leaves
 * three `sleep`s behind in its own subshell, as a lane's command can. Skipped where `ps` cannot run,
 * such as inside a sandbox.
 */
let psWorks = false;
beforeAll(async () => {
  try {
    await systemProcessTable();
    psWorks = true;
  } catch {
    psWorks = false;
  }
});

const started: ChildProcess[] = [];
afterEach(() => {
  for (const child of started.splice(0)) {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

async function alive(pid: number): Promise<boolean> {
  return (await systemProcessTable()).some((row) => row.pid === pid);
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
}

/** A shell with children, in its own group so the test's cleanup cannot reach this process. */
async function startCommand(): Promise<{ pid: number; startedAt: string }> {
  const child = spawn('/bin/sh', ['-c', '(sleep 300 &) ; (sleep 301 &) ; sleep 302'], {
    detached: true,
    stdio: 'ignore',
  });
  started.push(child);
  const pid = child.pid;
  if (pid === undefined) throw new Error('no pid');
  await until(async () => (await systemProcessTable()).filter((r) => r.pgid === pid).length >= 3);
  const row = (await systemProcessTable()).find((r) => r.pid === pid);
  if (row === undefined) throw new Error('shell not listed');
  return { pid, startedAt: row.startedAt };
}

describe('lane processes on the real machine', () => {
  it('stops the command and what it left behind when the session ends', async (ctx) => {
    if (!psWorks) ctx.skip();
    const root = await startCommand();
    const watch = createLaneProcessWatch({
      table: systemProcessTable,
      ledger: null,
      graceMs: 3_000,
    });
    await watch.track(root);
    await watch.end();
    const left = (await systemProcessTable()).filter((r) => r.pgid === root.pid);
    expect(left).toEqual([]);
  });

  it('stops what is left once the shell that started it is gone, from the ledger, after a restart', async (ctx) => {
    if (!psWorks) ctx.skip();
    const dir = mkdtempSync(join(tmpdir(), 'lp-sys-'));
    try {
      const root = await startCommand();
      const ledger = createProcessLedger(dir);
      await createLaneProcessWatch({ table: systemProcessTable, ledger }).track(root);
      process.kill(root.pid, 'SIGKILL');
      await until(async () => !(await alive(root.pid)));
      const orphans = (await systemProcessTable()).filter((r) => r.pgid === root.pid);
      expect(orphans.length).toBeGreaterThan(0);

      const report = await reapLaneProcessLedgers(dir, {
        table: systemProcessTable,
        graceMs: 3_000,
      });
      expect(report.stopped).toBeGreaterThanOrEqual(orphans.length);
      expect((await systemProcessTable()).filter((r) => r.pgid === root.pid)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
