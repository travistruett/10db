import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, waitForAsync, type TempDir } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { silentLogger } from '../log';
import {
  createLedgerSweep,
  reapLaneProcessLedgers,
  systemProcessTable,
  type LedgerSweep,
} from '../sandbox';
import {
  BROWSER_IDLE_MS,
  createBrowserHost,
  launchOptions,
  NO_LEDGER_PROBLEM,
  type BrowserHost,
  type BrowserLaunch,
} from './browser-host';

describe('launchOptions', () => {
  const options = launchOptions(
    '/data/tools/chrome-headless-shell',
    4567,
    '/data/browser/artifacts',
    {
      HOME: '/Users/b',
      TMPDIR: '/var/t/',
    },
  );
  it.each<[string, (o: BrowserLaunch) => unknown, unknown]>([
    ['runs the renderer sandboxed', (o) => o.chromiumSandbox, true],
    ['never asks for --no-sandbox', (o) => o.args.some((a) => a.startsWith('--no-sandbox')), false],
    ['is headless', (o) => o.headless, true],
    ['runs the pinned executable', (o) => o.executablePath, '/data/tools/chrome-headless-shell'],
    [
      'sends every request through the proxy',
      (o) => o.args.includes('--proxy-server=http://127.0.0.1:4567'),
      true,
    ],
    [
      'sends loopback through the proxy too',
      (o) => o.args.includes('--proxy-bypass-list=<-loopback>'),
      true,
    ],
    [
      'sends no UDP around the proxy',
      (o) => o.args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'),
      true,
    ],
    ['keeps its artifacts under the data dir', (o) => o.artifactsDir, '/data/browser/artifacts'],
    ['gets only the env it is given', (o) => o.env, { HOME: '/Users/b', TMPDIR: '/var/t/' }],
    [
      "leaves the daemon's signals to the daemon",
      (o) => [o.handleSIGINT, o.handleSIGTERM, o.handleSIGHUP],
      [false, false, false],
    ],
  ])('%s', (_name, read, expected) => {
    expect(read(options)).toEqual(expected);
  });
});

/** A stand-in for Chromium: a real detached child of this process, as Playwright launches one. */
interface StandIn {
  readonly pid: number;
  isConnected(): boolean;
  close(): Promise<void>;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('the browser host', () => {
  let dir: TempDir;
  let dataDir: string;
  let ledgerRoot: string;
  let clock: ManualClock;
  let sweep: LedgerSweep;
  /** The sweep's next round, run by the test instead of after its pause. */
  let sweepRound: (() => void) | null;
  /** How many processes each finished sweep round stopped. */
  let swept: number[];
  let launched: BrowserLaunch[];
  let standIns: StandIn[];
  let host: BrowserHost<StandIn> | null;

  const launch = (options: BrowserLaunch): Promise<StandIn> =>
    new Promise((resolve, reject) => {
      launched.push(options);
      const child = spawn(options.executablePath, ['600'], { detached: true, stdio: 'ignore' });
      const exited = new Promise<void>((done) => {
        child.once('exit', () => {
          done();
        });
      });
      child.once('error', reject);
      child.once('spawn', () => {
        const pid = child.pid;
        if (pid === undefined) {
          reject(new Error('no pid'));
          return;
        }
        const standIn: StandIn = {
          pid,
          isConnected: () => child.exitCode === null && child.signalCode === null,
          close: async () => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
            await exited;
          },
        };
        standIns.push(standIn);
        resolve(standIn);
      });
    });

  function makeHost(withLedger = true): BrowserHost<StandIn> {
    host = createBrowserHost({
      dataDir,
      ledgers: withLedger ? { sweep, root: ledgerRoot } : null,
      processes: { table: systemProcessTable },
      clock,
      logger: silentLogger,
      launch,
      ensure: () => Promise.resolve('/bin/sleep'),
      env: { HOME: dir.path, TMPDIR: dir.path },
    });
    return host;
  }

  beforeEach(() => {
    dir = tempDir('browser-host');
    dataDir = join(dir.path, 'data');
    ledgerRoot = join(dir.path, 'files');
    mkdirSync(ledgerRoot);
    clock = new ManualClock(new Date('2026-11-10T12:00:00Z'));
    sweepRound = null;
    swept = [];
    sweep = createLedgerSweep(
      ledgerRoot,
      {
        table: systemProcessTable,
        timers: {
          setTimeout: (fn) => {
            sweepRound = fn;
            return {
              cancel: () => {
                sweepRound = null;
              },
            };
          },
        },
      },
      {
        onSwept: (report) => {
          swept.push(report.stopped);
        },
      },
    );
    launched = [];
    standIns = [];
    host = null;
  });
  afterEach(async () => {
    await host?.close();
    sweep.stop();
    for (const s of standIns) await s.close();
    dir.cleanup();
  });

  it('never launches without a ledger, and says why', async () => {
    const h = makeHost(false);
    expect(h.status()).toEqual({ state: 'refused', problem: NO_LEDGER_PROBLEM });
    expect(await h.prepare()).toBe(false);
    await expect(h.use(() => Promise.resolve('shot'))).rejects.toThrow(NO_LEDGER_PROBLEM);
    expect(launched).toEqual([]);
  });

  it('is fetching while the pinned build is checked, then ready', async () => {
    let finish: (exe: string) => void = () => undefined;
    host = createBrowserHost({
      dataDir,
      ledgers: { sweep, root: ledgerRoot },
      processes: { table: systemProcessTable },
      clock,
      logger: silentLogger,
      launch,
      ensure: () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
      env: {},
    });
    expect(host.status()).toEqual({ state: 'off', problem: null });
    const prepared = host.prepare();
    const status = host.status();
    expect(status.state).toBe('fetching');
    finish('/bin/sleep');
    expect(await prepared).toBe(true);
    if (status.state === 'fetching') expect(await status.ready).toBe(true);
    expect(host.status()).toEqual({ state: 'ready', problem: null });
  });

  it('is refused, with why, when the pinned build is', async () => {
    host = createBrowserHost({
      dataDir,
      ledgers: { sweep, root: ledgerRoot },
      processes: { table: systemProcessTable },
      clock,
      logger: silentLogger,
      launch,
      ensure: () => Promise.reject(new Error('Chromium for pictures 1 was refused: bad checksum')),
      env: {},
    });
    expect(await host.prepare()).toBe(false);
    expect(host.status()).toEqual({
      state: 'refused',
      problem: 'Chromium for pictures 1 was refused: bad checksum',
    });
    await expect(host.use(() => Promise.resolve(1))).rejects.toThrow(/bad checksum/);
    expect(launched).toEqual([]);
  });

  it('holds the running browser in a ledger the sweep spares, and stops it at close', async () => {
    const h = makeHost();
    const pid = await h.use((browser) => Promise.resolve(browser.pid));
    expect(alive(pid)).toBe(true);
    expect(launched[0]?.artifactsDir).toBe(join(dataDir, 'browser', 'artifacts'));
    expect(statSync(join(dataDir, 'browser', 'artifacts')).mode & 0o777).toBe(0o700);
    const [ledger] = readdirSync(ledgerRoot);
    expect(ledger).toMatch(/^10db-proc-/);
    expect(readFileSync(join(ledgerRoot, ledger ?? ''), 'utf8')).toContain(`"pid":${String(pid)}`);
    // A sweep round while the browser runs leaves it alone.
    sweep.later();
    const round = sweepRound;
    expect(round).not.toBeNull();
    round?.();
    await waitForAsync(() => Promise.resolve(swept.length === 1 ? true : undefined), 5_000);
    expect(swept).toEqual([0]);
    expect(alive(pid)).toBe(true);
    await h.close();
    expect(alive(pid)).toBe(false);
    expect(readdirSync(ledgerRoot)).toEqual([]);
  });

  it('a browser left by a daemon that died is stopped by the next start', async () => {
    const h = makeHost();
    const pid = await h.use((browser) => Promise.resolve(browser.pid));
    expect(alive(pid)).toBe(true);
    // The daemon dies without closing it: the next start reaps every ledger it does not hold.
    const reaped = await reapLaneProcessLedgers(ledgerRoot, { table: systemProcessTable });
    expect(reaped.stopped).toBeGreaterThan(0);
    await waitForAsync(() => Promise.resolve(alive(pid) ? undefined : true), 10_000);
    host = null;
  });

  it('closes the browser after five idle minutes, and launches it again when next used', async () => {
    const h = makeHost();
    const first = await h.use((browser) => Promise.resolve(browser.pid));
    clock.advance(BROWSER_IDLE_MS - 1);
    expect(alive(first)).toBe(true);
    clock.advance(1);
    await waitForAsync(() => Promise.resolve(alive(first) ? undefined : true), 10_000);
    await waitForAsync(
      () => Promise.resolve(readdirSync(ledgerRoot).length === 0 ? true : undefined),
      5_000,
    );
    const second = await h.use((browser) => Promise.resolve(browser.pid));
    expect(second).not.toBe(first);
    expect(launched).toHaveLength(2);
  });

  it('runs one use at a time', async () => {
    const h = makeHost();
    let inside = 0;
    let most = 0;
    const use = () =>
      h.use(async () => {
        inside += 1;
        most = Math.max(most, inside);
        await new Promise((r) => setImmediate(r));
        inside -= 1;
      });
    await Promise.all([use(), use(), use()]);
    expect(most).toBe(1);
    expect(launched).toHaveLength(1);
    expect(existsSync(join(dataDir, 'browser', 'artifacts'))).toBe(true);
  });
});
