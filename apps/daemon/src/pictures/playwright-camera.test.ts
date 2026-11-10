import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, waitForAsync, type TempDir } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { silentLogger } from '../log';
import { createLedgerSweep, systemProcessTable, type LedgerSweep } from '../sandbox';
import { createBrowserHost, type BrowserHost, type BrowserLaunch } from './browser-host';
import { ShotOutcome, type PageCamera, type Shot } from './camera';
import { createPlaywrightCamera, type CameraBrowser } from './playwright-camera';

// The browser is a child process 10db does not own, so a stand-in takes its place at Playwright's
// boundary: a real detached process the host holds in its ledger, whose context never finishes a page
// and whose close behaves as playwright-core 1.65.0's does for a wedged context. The first close never
// ends; a later one returns at once, since the context is already closing.

interface StandIn extends CameraBrowser {
  readonly pid: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('the camera, on a page that will not close', () => {
  let dir: TempDir;
  let clock: ManualClock;
  let sweep: LedgerSweep;
  let host: BrowserHost<StandIn>;
  let contexts: number;
  let pids: number[];

  const launch = (options: BrowserLaunch): Promise<StandIn> =>
    new Promise((resolve, reject) => {
      const child = spawn(options.executablePath, ['600'], { detached: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('spawn', () => {
        const pid = child.pid;
        if (pid === undefined) {
          reject(new Error('no pid'));
          return;
        }
        pids.push(pid);
        const running = (): boolean => child.exitCode === null && child.signalCode === null;
        resolve({
          pid,
          isConnected: running,
          close: () =>
            new Promise<void>((done) => {
              if (!running()) {
                done();
                return;
              }
              child.once('exit', () => {
                done();
              });
              child.kill('SIGTERM');
            }),
          newContext: () => {
            contexts += 1;
            let closing = false;
            return Promise.resolve({
              route: () =>
                Promise.resolve({
                  dispose: () => Promise.resolve(),
                  [Symbol.asyncDispose]: () => Promise.resolve(),
                }),
              routeWebSocket: () => Promise.resolve(),
              newPage: () => new Promise<Page>(() => undefined),
              storageState: () => new Promise<never>(() => undefined),
              close: () => {
                if (closing) return Promise.resolve();
                closing = true;
                return new Promise<void>(() => undefined);
              },
            });
          },
        });
      });
    });

  beforeEach(() => {
    dir = tempDir('camera-stuck');
    const ledgerRoot = join(dir.path, 'files');
    mkdirSync(ledgerRoot);
    clock = new ManualClock();
    contexts = 0;
    pids = [];
    sweep = createLedgerSweep(ledgerRoot, {
      table: systemProcessTable,
      timers: { setTimeout: () => ({ cancel: () => undefined }) },
    });
    host = createBrowserHost({
      dataDir: join(dir.path, 'data'),
      ledgers: { sweep, root: ledgerRoot },
      processes: { table: systemProcessTable },
      clock,
      logger: silentLogger,
      launch,
      ensure: () => Promise.resolve('/bin/sleep'),
      env: {},
    });
  });
  afterEach(async () => {
    await host.close();
    sweep.stop();
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Gone already.
      }
    }
    dir.cleanup();
  });

  /** Shoots, lets `cut` end the page, and runs the clock until the shot settles. */
  async function stuckShot(camera: PageCamera, cut: (signal: AbortController) => void) {
    const controller = new AbortController();
    const settled: { shot: Shot | null } = { shot: null };
    const shooting = camera
      .shoot({
        appUrl: 'http://127.0.0.1:9',
        route: '/people',
        viewport: { width: 800, height: 600 },
        theme: 'default',
        storageState: null,
        signal: controller.signal,
      })
      .then((value) => {
        settled.shot = value;
      });
    await waitForAsync(() => Promise.resolve(contexts === 1 ? true : undefined), 10_000);
    cut(controller);
    // Each time a timer waits (the close's, then the browser's), let it run out.
    for (let round = 0; round < 4 && settled.shot === null; round += 1) {
      await waitForAsync(
        () =>
          Promise.resolve(settled.shot !== null || clock.pendingTimers() > 0 ? true : undefined),
        10_000,
      );
      clock.advance(60_000);
    }
    await shooting;
    return settled.shot;
  }

  it.each<[string, (controller: AbortController) => void]>([
    [
      'past the deadline',
      () => {
        clock.advance(1_000);
      },
    ],
    [
      'aborted',
      (controller) => {
        controller.abort();
      },
    ],
  ])('closes the browser before a shot %s settles', async (_name, cut) => {
    const camera = createPlaywrightCamera(host, silentLogger, { clock, deadlineMs: 1_000 });
    const shot = await stuckShot(camera, cut);
    expect(shot).toMatchObject({
      outcome: ShotOutcome.Failed,
      reason: 'the page would not close, so the browser was closed',
    });
    expect(pids).toHaveLength(1);
    expect(alive(pids[0] ?? 0)).toBe(false);
  });
});
