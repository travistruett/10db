import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { patchProject, findOpenByFoldKey } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir, waitFor, type TempDir } from '../../test/fixtures';
import { openPassWorld, type PassWorld } from '../../test/pass-world';
import { systemClock } from '../clock';
import { silentLogger } from '../log';
import { createGateRunner } from '../verify';
import { createAppStart, type AppStart, type AppStartDeps } from './app-start';

// A project's start command brings its stack up when a picture or the dev login finds the app address
// down: once, after Docker Desktop is opened when no engine answers, and a failed start leaves one
// card and is not run again. Real project, database, gate runner, child process and local server.

let w: PassWorld;
let dir: TempDir;
let appStart: AppStart | null = null;
let server: Server | null = null;

afterEach(async () => {
  await appStart?.stop();
  appStart = null;
  await new Promise<void>((resolve) => {
    if (server === null) resolve();
    else
      server.close(() => {
        resolve();
      });
  });
  server = null;
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

/** The stack comes up: something answers at `port`. */
async function bringUpServer(port: number): Promise<void> {
  server = createServer((_request, response) => response.end('ok'));
  await new Promise<void>((resolve) => server?.listen(port, '127.0.0.1', resolve));
}

async function world(command: (marks: string) => string): Promise<{ marks: string; port: number }> {
  dir = tempDir('app-start');
  w = await openPassWorld();
  const port = await freePort();
  const marks = join(dir.path, 'starts');
  w.h.state.write((ctx) =>
    patchProject(ctx, w.h.project.id, {
      appUrl: `http://127.0.0.1:${String(port)}`,
      appStartCommand: command(marks),
    }),
  );
  return { marks, port };
}

function start(extra: Partial<AppStartDeps> = {}): AppStart {
  appStart = createAppStart({
    state: w.h.state,
    inbox: w.h.inbox,
    gate: createGateRunner({ sandbox: null, logger: silentLogger }),
    dataDir: dir.path,
    clock: systemClock,
    logger: silentLogger,
    sessionEnv: () => ({ PATH: '/usr/bin:/bin' }),
    rules: () => [],
    checkouts: () => [w.h.repo],
    dockerSockets: () => [],
    usesDocker: () => Promise.resolve(false),
    timing: { probeEveryMs: 20, appAnswerWithinMs: 3_000, dockerWithinMs: 3_000, ...extra.timing },
    ...extra,
  });
  return appStart;
}

const starts = (marks: string): number =>
  existsSync(marks) ? readFileSync(marks, 'utf8').split('\n').filter(Boolean).length : 0;
const card = () => findOpenByFoldKey(w.h.store.db, w.h.project.id, `app-start:${w.h.project.id}`);

describe('bringing a project’s dev stack up for a picture or a sign-in', () => {
  it('runs the start command once while the address is down and goes on once it answers', async () => {
    const { marks, port } = await world((m) => `echo start >> '${m}'`);
    const answer = start().ensureUp(w.h.project.id);
    await waitFor(() => starts(marks) === 1);
    await bringUpServer(port);
    expect(await answer).toEqual({ up: true });
    // Answering now, so nothing is run again.
    expect(await start().ensureUp(w.h.project.id)).toEqual({ up: true });
    expect(starts(marks)).toBe(1);
  });

  it('opens Docker Desktop first and waits for its socket before running the command', async () => {
    const opened = { at: 0 };
    const flag = () => join(dir.path, 'docker-opened');
    const { marks, port } = await world(
      (m) => `test -f '${join(m, '..', 'docker-opened')}' && echo start >> '${m}'`,
    );
    let engine = false;
    const answer = start({
      usesDocker: () => Promise.resolve(true),
      dockerSockets: () => ['/docker.sock'],
      dockerUp: () => Promise.resolve(engine),
      openDocker: () => {
        opened.at += 1;
        writeFileSync(flag(), 'open');
        // The engine takes a moment to come up after Docker Desktop opens.
        setTimeout(() => {
          engine = true;
        }, 100);
        return Promise.resolve();
      },
    }).ensureUp(w.h.project.id);
    await waitFor(() => starts(marks) === 1);
    expect(engine).toBe(true);
    await bringUpServer(port);
    expect(await answer).toEqual({ up: true });
    expect(opened.at).toBe(1);
  });

  it('leaves one card for a start that fails and does not run it again', async () => {
    const { marks } = await world((m) => `echo run >> '${m}'; echo boom; exit 3`);
    const answer = await start().ensureUp(w.h.project.id);
    expect(answer.up).toBe(false);
    expect(starts(marks)).toBe(1);
    const open = card();
    expect(open?.body).toContain('exited 3');
    expect(open?.body).toContain('boom');
    // Asked again, at once and in parallel: the same answer, no second run, still one card.
    const again = await Promise.all([
      appStart?.ensureUp(w.h.project.id),
      appStart?.ensureUp(w.h.project.id),
    ]);
    expect(again.every((a) => a?.up === false)).toBe(true);
    expect(starts(marks)).toBe(1);
    expect(card()?.id).toBe(open?.id);
  });
});
