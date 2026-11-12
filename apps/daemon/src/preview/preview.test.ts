import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassNoticeKind, type ProjectId } from '@10db/contracts';
import { getPassProgress, patchProject, setPassNotice } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir, waitFor, waitForAsync, type TempDir } from '../../test/fixtures';
import { captureLogs, type LogCapture } from '../../test/log-capture';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import { silentLogger } from '../log';
import { abandonPass } from '../pass';
import { createGateRunner } from '../verify';
import { answers } from './probe';
import { startPreview, type Preview, type PreviewTiming } from './preview';
import type { PreviewLedgers } from './preview-ledger';
import { createLedgerSweep, reapLaneProcessLedgers, systemProcessTable } from '../sandbox';

// Decision 2026-11-11-10db-runs-the-preview-while-a-pass-is-open: while a project has a pass and a
// preview command, 10db runs the command (under the gate's sandbox; none here, as for the gate
// tests that need none) unless something answers at the app address already, restarts it a few
// times, and says in the pass header only what needs a look. Real pass, database and child process.

let w: PassWorld;
let dir: TempDir;
let logs: LogCapture;
let preview: Preview | null = null;
const servers: Server[] = [];

afterEach(async () => {
  await preview?.stop();
  preview = null;
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) =>
          s.close(() => {
            resolve();
          }),
        ),
    ),
  );
  w.close();
  dir.cleanup();
});

/** A port nothing listens on yet. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise<void>((resolve) =>
    probe.close(() => {
      resolve();
    }),
  );
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

/** A dev server that serves the app at `port` and notes each start in `marks`. */
const serving = (port: number, marks: string): string =>
  `echo start >> '${marks}'; exec '${process.execPath}' -e "require('http').createServer((q, s) => s.end('ok')).listen(${String(port)}, '127.0.0.1')"`;

interface Setup {
  readonly app: string;
  readonly port: number;
  readonly marks: string;
  readonly projectId: ProjectId;
}

/** A pass on a project whose app is at a free port and whose preview command is `command`. */
async function world(
  command: (port: number, marks: string) => string | null = serving,
  loopback = true,
): Promise<Setup> {
  dir = tempDir('preview');
  w = await openPassWorld({ project: { sandboxLoopback: loopback } });
  const port = await freePort();
  const app = `http://127.0.0.1:${String(port)}`;
  const marks = join(dir.path, 'starts');
  w.h.state.write((ctx) =>
    patchProject(ctx, w.h.project.id, { appUrl: app, previewCommand: command(port, marks) }),
  );
  logs = captureLogs();
  return { app, port, marks, projectId: w.h.project.id };
}

function start(
  timing: Partial<PreviewTiming> = {},
  ledgers: PreviewLedgers | null = null,
): Preview {
  preview = startPreview({
    ledgers,
    state: w.h.state,
    bus: w.h.bus,
    gate: createGateRunner({ sandbox: null, logger: silentLogger }),
    dataDir: dir.path,
    sessionEnv: () => ({ PATH: '/usr/bin:/bin' }),
    rules: () => [],
    checkouts: () => [w.h.repo],
    logger: logs.logger,
    timing: {
      restartAfterMs: 20,
      answerWithinMs: 5_000,
      probeEveryMs: 20,
      stopWithinMs: 500,
      ...timing,
    },
  });
  return preview;
}

const starts = (marks: string): number =>
  existsSync(marks) ? readFileSync(marks, 'utf8').split('\n').filter(Boolean).length : 0;
const previewNotices = () =>
  getPassProgress(w.h.store.db, w.opened.pass.id).notices.filter(
    (n) => n.kind === PassNoticeKind.PreviewStarting || n.kind === PassNoticeKind.PreviewStopped,
  );
const logged = (msg: string) => logs.lines().some((l) => l['msg'] === msg);

describe('the preview of a project with a pass open', () => {
  it('starts with the daemon, answers, and leaves nothing in the header once it does', async () => {
    const { app, marks } = await world();
    start();
    await waitForAsync(() => answers(app));
    await waitFor(() => previewNotices().length === 0 && logged('the preview answers'));
    expect(starts(marks)).toBe(1);
  });

  it('stops when the pass ends', async () => {
    const { app } = await world();
    start();
    await waitForAsync(() => answers(app));
    await abandonPass(
      { ...w.deps, stopLane: () => Promise.resolve(), wrote: () => Promise.resolve() },
      w.opened.pass.id,
    );
    await waitForAsync(async () => !(await answers(app)));
  });

  it('leaves a dev server the builder runs alone and starts nothing of its own', async () => {
    const { port, marks } = await world();
    const own = createServer((_q, s) => s.end('mine'));
    servers.push(own);
    await new Promise<void>((resolve) => own.listen(port, '127.0.0.1', resolve));
    start();
    await waitFor(() => logged('something answers at the app address already'));
    expect(starts(marks)).toBe(0);
    expect(previewNotices()).toEqual([]);
  });

  it('restarts a command that exits, three times, then stops and says why; Restart runs it again', async () => {
    const { marks, projectId } = await world(
      (_port, m) => `echo start >> '${m}'; echo 'port in use' >&2; exit 3`,
    );
    const service = start();
    const [stopped] = await waitFor(() => {
      const found = previewNotices().filter((n) => n.kind === PassNoticeKind.PreviewStopped);
      return found.length > 0 ? found : undefined;
    });
    expect(starts(marks)).toBe(4);
    expect(stopped?.text).toContain('The preview stopped');
    expect(stopped?.text).toContain('port in use');
    await service.restart(projectId);
    await waitFor(() => starts(marks) >= 5);
  });

  it('says it needs Allow loopback and starts nothing without it', async () => {
    const { marks } = await world(serving, false);
    start();
    const [said] = await waitFor(() => {
      const found = previewNotices();
      return found.length > 0 ? found : undefined;
    });
    expect(said).toMatchObject({ kind: PassNoticeKind.PreviewStopped });
    expect(said?.text).toContain('Allow loopback');
    expect(starts(marks)).toBe(0);
  });

  it('runs the new command once the builder changes it, and stops the old one', async () => {
    const { app, port, marks, projectId } = await world();
    start();
    await waitForAsync(() => answers(app));
    const second = join(dir.path, 'second');
    w.h.state.write((ctx) =>
      patchProject(ctx, projectId, { previewCommand: serving(port, second) }),
    );
    await waitFor(() => starts(second) === 1);
    await waitForAsync(() => answers(app));
    expect(starts(marks)).toBe(1);
  });

  it('clears "Starting" once a slow preview answers after the deadline', async () => {
    const { app } = await world((port, marks) => `sleep 1; ${serving(port, marks)}`);
    start({ answerWithinMs: 100 });
    await waitFor(() => previewNotices().some((n) => n.text.includes('nothing answers at')));
    await waitForAsync(() => answers(app));
    await waitFor(() => previewNotices().length === 0 && logged('the preview answers'));
  });

  it('takes its notice off a pass that has ended', async () => {
    await world(serving, false);
    start();
    await waitFor(() => previewNotices().length > 0);
    await abandonPass(
      { ...w.deps, stopLane: () => Promise.resolve(), wrote: () => Promise.resolve() },
      w.opened.pass.id,
    );
    await waitFor(() => previewNotices().length === 0);
  });

  it('clears what a stopped daemon left in the header when it starts', async () => {
    await world(() => null);
    w.h.state.write((ctx) => {
      setPassNotice(ctx, w.opened.pass.id, {
        id: 'preview-server',
        kind: PassNoticeKind.PreviewStarting,
        text: 'Starting the preview: `pnpm dev`',
        sendable: false,
        cardId: null,
        at: ctx.now,
      });
    });
    start();
    await waitFor(() => previewNotices().length === 0);
  });

  it('says so, with Restart, when a preview that answered stops answering', async () => {
    const { app, projectId } = await world(
      (p, marks) =>
        `echo start >> '${marks}'; exec '${process.execPath}' -e "const s = require('http').createServer((q, r) => { r.end('ok', () => { s.close(); s.closeAllConnections(); }); }); s.listen(${String(p)}, '127.0.0.1'); setInterval(() => {}, 1000)"`,
    );
    const service = start();
    await waitFor(() => logged('the preview answers'));
    expect(await answers(app)).toBe(false);
    await service.lost(projectId);
    const [said] = previewNotices();
    expect(said).toMatchObject({ kind: PassNoticeKind.PreviewStopped });
    expect(said?.text).toContain("doesn't answer");
  });

  it("clears its stopped notice once the builder's own server answers", async () => {
    const { port, projectId } = await world((_p, m) => `echo start >> '${m}'; exit 3`);
    const service = start();
    await waitFor(() => previewNotices().some((n) => n.kind === PassNoticeKind.PreviewStopped));
    const own = createServer((_q, r) => r.end('mine'));
    servers.push(own);
    await new Promise<void>((resolve) => own.listen(port, '127.0.0.1', resolve));
    await service.ensure(projectId);
    expect(previewNotices()).toEqual([]);
  });

  it('stops within its deadline even when a descendant holds its output open', async () => {
    const pidFile = join(tempDir('preview-orphan').path, 'pid');
    const { app } = await world(
      (p) =>
        `exec '${process.execPath}' -e "const c = require('child_process').spawn('/bin/sleep', ['60'], { detached: true, stdio: 'inherit' }); require('fs').writeFileSync('${pidFile}', String(c.pid)); require('http').createServer((q, s) => s.end('ok')).listen(${String(p)}, '127.0.0.1')"`,
    );
    const service = start();
    await waitForAsync(() => answers(app));
    try {
      const stopping = service.stop();
      const outcome = await Promise.race([
        stopping.then(() => 'stopped'),
        new Promise((resolve) =>
          setTimeout(() => {
            resolve('hung');
          }, 3_000),
        ),
      ]);
      expect(outcome).toBe('stopped');
      preview = null;
    } finally {
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
    }
  });

  it('names its processes in a ledger, so a preview a dead daemon left is stopped by the next start', async () => {
    const { app } = await world();
    const root = join(dir.path, 'files');
    mkdirSync(root, { mode: 0o700 });
    const sweep = createLedgerSweep(root, {
      table: systemProcessTable,
      // Its rounds are the next start's here, run by the test.
      timers: { setTimeout: () => ({ cancel: () => undefined }) },
    });
    start({}, { root, sweep, processes: { table: systemProcessTable } });
    await waitForAsync(() => answers(app));
    const pid = await waitFor(() => {
      const [ledger] = readdirSync(root);
      if (ledger === undefined) return undefined;
      const members = (
        JSON.parse(readFileSync(join(root, ledger), 'utf8')) as { members: { pid: number }[] }
      ).members;
      return members[0]?.pid;
    });
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive()).toBe(true);
    // The daemon dies without stopping it: the next start reaps every ledger it does not hold.
    const reaped = await reapLaneProcessLedgers(root, { table: systemProcessTable });
    expect(reaped.stopped).toBeGreaterThan(0);
    await waitFor(() => !alive());
  });

  it('ends the preview when the daemon stops', async () => {
    const { app } = await world();
    const service = start();
    await waitForAsync(() => answers(app));
    await service.stop();
    preview = null;
    await waitForAsync(async () => !(await answers(app)));
  });
});
