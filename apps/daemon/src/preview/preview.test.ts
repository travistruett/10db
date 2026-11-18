import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassNoticeKind, type ProjectId } from '@10db/contracts';
import { getPassProgress, patchProject } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir, waitFor, waitForAsync, type TempDir } from '../../test/fixtures';
import { captureLogs, type LogCapture } from '../../test/log-capture';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import { silentLogger } from '../log';
import { createGateRunner } from '../verify';
import { answers } from './probe';
import { startPreview, type Preview, type PreviewTiming } from './preview';
import type { PreviewLedgers } from './preview-ledger';

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
});
