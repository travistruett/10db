import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createLaneProcessWatch,
  createProcessLedger,
  reapLaneProcessLedgers,
} from './lane-processes';
import { systemOpenPaths, systemProcessTable } from './process-table';

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

  it('stops a job a command handed to launchd before any sample by its open output file, and leaves one in the checkout alone', async (ctx) => {
    if (!psWorks) ctx.skip();
    // The lane's temp dir, and the checkout other lanes and the builder share.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lp-out-')));
    const checkout = realpathSync(mkdtempSync(join(tmpdir(), 'lp-co-')));
    try {
      const root = spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' });
      started.push(root);
      const rootPid = root.pid ?? 0;
      await until(async () => alive(rootPid));
      const rootRow = (await systemProcessTable()).find((r) => r.pid === rootPid);
      if (rootRow === undefined) throw new Error('root not listed');
      const watch = createLaneProcessWatch({
        table: systemProcessTable,
        openPaths: systemOpenPaths,
        places: [dir],
        ledger: null,
        graceMs: 3_000,
      });
      await watch.track({ pid: rootPid, startedAt: rootRow.startedAt });
      // `sleep 304 &` in the checkout, its output going to Claude Code's file in the temp dir; and
      // another lane's `sleep 305 > dev.log 2>&1 &` in the same checkout.
      const run = (script: string) => {
        const shell = spawn('/bin/sh', ['-c', script], {
          cwd: checkout,
          detached: true,
          stdio: 'ignore',
        });
        started.push(shell);
        return shell.pid ?? 0;
      };
      const mine = run(`sleep 304 > '${join(dir, 'b1.output')}' 2>&1 &`);
      const theirs = run('sleep 305 > dev.log 2>&1 &');
      await until(async () => !(await alive(mine)) && !(await alive(theirs)));
      const job = async (group: number) =>
        (await systemProcessTable()).filter((r) => r.pgid === group && r.ppid === 1);
      expect((await job(mine)).length).toBe(1);
      expect((await job(theirs)).length).toBe(1);
      await watch.end();
      expect(await job(mine)).toEqual([]);
      expect((await job(theirs)).length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  it('stops a job a command handed to launchd before any sample, by its working directory in the temp dir', async (ctx) => {
    if (!psWorks) ctx.skip();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lp-cwd-')));
    try {
      // The session's own process, standing in for claude.
      const root = spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' });
      started.push(root);
      const rootPid = root.pid ?? 0;
      await until(async () => alive(rootPid));
      const rootRow = (await systemProcessTable()).find((r) => r.pid === rootPid);
      if (rootRow === undefined) throw new Error('root not listed');
      const watch = createLaneProcessWatch({
        table: systemProcessTable,
        openPaths: systemOpenPaths,
        places: [dir],
        ledger: null,
        graceMs: 3_000,
      });
      await watch.track({ pid: rootPid, startedAt: rootRow.startedAt });
      // `sleep 303 &` from a command that returns at once: its shell is gone before any sample.
      const shell = spawn('/bin/sh', ['-c', 'sleep 303 > /dev/null 2>&1 &'], {
        cwd: dir,
        detached: true,
        stdio: 'ignore',
      });
      started.push(shell);
      const shellPid = shell.pid ?? 0;
      await until(async () => !(await alive(shellPid)));
      const job = async () =>
        (await systemProcessTable()).filter((r) => r.pgid === shellPid && r.ppid === 1);
      expect((await job()).length).toBe(1);
      await watch.end();
      expect(await job()).toEqual([]);
      expect(await alive(rootPid)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
