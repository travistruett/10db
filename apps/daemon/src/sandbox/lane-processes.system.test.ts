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
 * such as inside a sandbox. The cases that find a job by its open files or working directory also
 * need macOS's `lsof`, which CI's Linux image doesn't have.
 */
let psWorks = false;
let lsofWorks = false;
beforeAll(async () => {
  try {
    await systemProcessTable();
    psWorks = true;
  } catch {
    psWorks = false;
  }
  try {
    await systemOpenPaths([process.pid]);
    lsofWorks = true;
  } catch {
    lsofWorks = false;
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

  it('stops what a command started after the mark, and leaves the session’s own process running', async (ctx) => {
    if (!psWorks) ctx.skip();
    // The session waits for a line, then runs a command: a shell with a job in a subshell, as `pnpm dev &` is.
    const session = spawn(
      '/bin/sh',
      ['-c', 'read go; /bin/sh -c "(sleep 306 &) ; sleep 307" ; sleep 308'],
      { detached: true, stdio: ['pipe', 'ignore', 'ignore'] },
    );
    started.push(session);
    const pid = session.pid ?? 0;
    await until(() => alive(pid));
    const row = (await systemProcessTable()).find((r) => r.pid === pid);
    if (row === undefined) throw new Error('session not listed');
    const watch = createLaneProcessWatch({
      table: systemProcessTable,
      ledger: null,
      graceMs: 3_000,
    });
    await watch.track({ pid, startedAt: row.startedAt });
    watch.markOwn();
    session.stdin.write('go\n');
    // The inner shell, its subshell's orphaned sleep and the foreground sleep share the session's group.
    await until(async () => (await systemProcessTable()).filter((r) => r.pgid === pid).length >= 4);
    await watch.endJobs();
    // The job the subshell handed to launchd is gone; the session's own process runs on.
    expect((await systemProcessTable()).filter((r) => r.pgid === pid && r.ppid === 1)).toEqual([]);
    expect(await alive(pid)).toBe(true);
    await watch.end();
  });

  it('stops a job a command handed to launchd before any sample, by its open output file or its working directory in the temp dir, and leaves one in the checkout alone', async (ctx) => {
    if (!psWorks || !lsofWorks) ctx.skip();
    // The lane's temp dir, and the checkout other lanes and the builder share.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lp-out-')));
    const checkout = realpathSync(mkdtempSync(join(tmpdir(), 'lp-co-')));
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
      // Commands that return at once, so each shell is gone before any sample: `sleep 304 &` in the
      // checkout, its output going to Claude Code's file in the temp dir; `sleep 303 &` run from the
      // temp dir; and another lane's `sleep 305 > dev.log 2>&1 &` in the same checkout.
      const run = (script: string, cwd: string) => {
        const shell = spawn('/bin/sh', ['-c', script], { cwd, detached: true, stdio: 'ignore' });
        started.push(shell);
        return shell.pid ?? 0;
      };
      const byFile = run(`sleep 304 > '${join(dir, 'b1.output')}' 2>&1 &`, checkout);
      const byCwd = run('sleep 303 > /dev/null 2>&1 &', dir);
      const theirs = run('sleep 305 > dev.log 2>&1 &', checkout);
      await until(
        async () => !(await alive(byFile)) && !(await alive(byCwd)) && !(await alive(theirs)),
      );
      const job = async (group: number) =>
        (await systemProcessTable()).filter((r) => r.pgid === group && r.ppid === 1);
      expect((await job(byFile)).length).toBe(1);
      expect((await job(byCwd)).length).toBe(1);
      expect((await job(theirs)).length).toBe(1);
      await watch.end();
      expect(await job(byFile)).toEqual([]);
      expect(await job(byCwd)).toEqual([]);
      expect(await alive(rootPid)).toBe(false);
      expect((await job(theirs)).length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
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
