import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clock, Timer } from '../clock';
import { downloadFile, ensurePinned, extractZipWithTar } from '../environment';
import type { Logger } from '../log';
import type { LaneProcessFailure, LaneProcessSetup, LedgerSweep } from '../sandbox';
import { startAppProxy, type AppProxy } from './app-proxy';
import { BROWSER_PIN } from './browser-pin';
import { withDeadline } from './deadline';
import { openBrowserLedger, type BrowserLedger, type CommandReader } from './browser-ledger';
import type { BrowserStatus } from './camera';

/** How long the browser stays open after its last use. */
export const BROWSER_IDLE_MS = 5 * 60_000;
/** How long a launch may take before it is given up. */
const LAUNCH_TIMEOUT_MS = 30_000;

/** How long the browser gets to close before what is left of it is stopped from its ledger. */
export const BROWSER_CLOSE_MS = 10_000;

/**
 * A use left the browser in a state it can't be trusted in (a page that would not close, which could
 * still reach the proxy once it lets the next app through). The host closes the browser, stopping its
 * processes if it won't close, before the use settles; the next use launches a fresh one.
 */
export class BrowserStuckError extends Error {
  override readonly name = 'BrowserStuckError';
}

/** Why there are no pictures when the daemon has no process ledger to hold the browser in. */
export const NO_LEDGER_PROBLEM = "pictures need the sandbox's roots, which were refused";

/** What 10db launches Chromium with: the fields of Playwright's launch options it sets. */
export interface BrowserLaunch {
  readonly executablePath: string;
  readonly headless: true;
  /** Without it Playwright adds `--no-sandbox`. */
  readonly chromiumSandbox: true;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly artifactsDir: string;
  readonly handleSIGINT: false;
  readonly handleSIGTERM: false;
  readonly handleSIGHUP: false;
  readonly timeout: number;
}

/**
 * The launch: the pinned executable, headless, its renderer sandboxed, every request (loopback
 * included) through the daemon's proxy, no UDP around it, its artifacts under the data dir, only the
 * env given, and the daemon's own signals left to the daemon. The proxy is passed as Chromium's own
 * switches, not Playwright's `proxy` option, so `PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK`
 * cannot let loopback around it.
 */
export function launchOptions(
  executablePath: string,
  proxyPort: number,
  artifactsDir: string,
  env: Readonly<Record<string, string>>,
): BrowserLaunch {
  return {
    executablePath,
    headless: true,
    chromiumSandbox: true,
    args: [
      `--proxy-server=http://127.0.0.1:${String(proxyPort)}`,
      '--proxy-bypass-list=<-loopback>',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ],
    env,
    artifactsDir,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    timeout: LAUNCH_TIMEOUT_MS,
  };
}

/** The only variables the browser gets: where home and temp are. */
function browserEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of ['HOME', 'TMPDIR']) {
    const value = env[name];
    if (value !== undefined && value !== '') kept[name] = value;
  }
  return kept;
}

/** What the host needs of a launched browser; Playwright's `Browser` is one. */
export interface ClosableBrowser {
  isConnected(): boolean;
  close(): Promise<void>;
}

/** The browser can't be used: the message says why, for the status line. */
export class BrowserHostError extends Error {
  override readonly name = 'BrowserHostError';
}

export interface BrowserHostDeps<B extends ClosableBrowser> {
  readonly dataDir: string;
  /**
   * The lane ledgers' sweep and the files root they live in. Null when the sandbox's roots were
   * refused: with nothing to hold it in, a browser could outlive the daemon, so none is launched.
   */
  readonly ledgers: { readonly sweep: LedgerSweep; readonly root: string } | null;
  readonly processes: LaneProcessSetup;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly launch: (options: BrowserLaunch) => Promise<B>;
  /** The checked executable; fetched and checked first when it is not there. Defaults to the pinned build. */
  readonly ensure?: () => Promise<string>;
  /** Where `HOME` and `TMPDIR` are read from; defaults to the daemon's own environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly commands?: CommandReader;
}

/**
 * The one browser the daemon takes pictures with: fetched and checked by `prepare`, launched on first
 * use, held in a process ledger while it runs, used by one caller at a time (the proxy lets one app
 * through at a time), and closed after `BROWSER_IDLE_MS` idle and at shutdown.
 */
export interface BrowserHost<B> {
  /** Fetches and checks the pinned build if need be; the status is `fetching` meanwhile. True once ready. */
  prepare(): Promise<boolean>;
  status(): BrowserStatus;
  /**
   * Runs `fn` with the browser and its proxy, launching both first when closed, after any use before
   * it ends. The proxy lets nothing through when `fn` returns.
   */
  use<T>(fn: (browser: B, proxy: AppProxy) => Promise<T>): Promise<T>;
  /** Closes the browser and refuses every later use. */
  close(): Promise<void>;
}

type Prepared =
  | { readonly kind: 'off' }
  | { readonly kind: 'fetching'; readonly ready: Promise<boolean> }
  | { readonly kind: 'ready'; readonly exe: string }
  | { readonly kind: 'refused'; readonly problem: string };

interface Running<B> {
  readonly browser: B;
  readonly proxy: AppProxy;
  readonly ledger: BrowserLedger;
}

export function createBrowserHost<B extends ClosableBrowser>(
  deps: BrowserHostDeps<B>,
): BrowserHost<B> {
  const logger = deps.logger.child({ module: 'pictures' });
  const artifactsDir = join(deps.dataDir, 'browser', 'artifacts');
  const ensure =
    deps.ensure ??
    (() =>
      ensurePinned(deps.dataDir, BROWSER_PIN, {
        download: downloadFile,
        extract: extractZipWithTar,
      }));
  let prepared: Prepared = { kind: 'off' };
  let running: Running<B> | null = null;
  let idle: Timer | null = null;
  let closed = false;
  /** Read through a call: `close` may run while a use awaits. */
  const isClosed = (): boolean => closed;
  /** Every use and every shut-down runs after the one before it. */
  let queue: Promise<unknown> = Promise.resolve();
  const reported = new Set<LaneProcessFailure>();

  function prepare(): Promise<boolean> {
    if (deps.ledgers === null) return Promise.resolve(false);
    if (prepared.kind === 'ready') return Promise.resolve(true);
    if (prepared.kind === 'fetching') return prepared.ready;
    const ready = ensure().then(
      (exe) => {
        prepared = { kind: 'ready', exe };
        logger.info({ version: BROWSER_PIN.version }, 'the browser for pictures is ready');
        return true;
      },
      (error: unknown) => {
        const problem = error instanceof Error ? error.message : String(error);
        prepared = { kind: 'refused', problem };
        logger.warn({ err: problem }, 'the browser for pictures was refused');
        return false;
      },
    );
    prepared = { kind: 'fetching', ready };
    return ready;
  }

  async function shut(): Promise<void> {
    const r = running;
    running = null;
    if (r === null) return;
    try {
      await withDeadline(
        deps.clock,
        BROWSER_CLOSE_MS,
        () => r.browser.close(),
        () => undefined,
      );
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'the browser for pictures did not close cleanly; its processes are stopped from its ledger',
      );
    }
    // Stops whatever of the browser still runs, the browser itself when its close never ended.
    await r.ledger.end();
    await r.proxy.close();
    logger.info({}, 'closed the browser for pictures');
  }

  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = queue.then(job, job);
    queue = run.catch(() => undefined);
    return run;
  }

  async function open(): Promise<Running<B>> {
    const ledgers = deps.ledgers;
    if (ledgers === null) throw new BrowserHostError(NO_LEDGER_PROBLEM);
    if (running !== null) {
      if (running.browser.isConnected()) return running;
      await shut();
    }
    if (!(await prepare())) {
      throw new BrowserHostError(
        prepared.kind === 'refused' ? prepared.problem : 'the browser for pictures is not ready',
      );
    }
    if (prepared.kind !== 'ready')
      throw new BrowserHostError('the browser for pictures is not ready');
    const exe = prepared.exe;
    await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
    await chmod(artifactsDir, 0o700);
    reported.clear();
    const ledger = openBrowserLedger({
      root: ledgers.root,
      sweep: ledgers.sweep,
      processes: deps.processes,
      ...(deps.commands === undefined ? {} : { commands: deps.commands }),
      onError: (failure, error) => {
        if (reported.has(failure)) return;
        reported.add(failure);
        logger.warn(
          { failure, err: error instanceof Error ? error.message : String(error) },
          "could not watch the browser for pictures' processes",
        );
      },
    });
    let proxy: AppProxy | null = null;
    let browser: B | null = null;
    try {
      proxy = await startAppProxy({
        onRefused: (target) => {
          logger.info({ target }, 'the pictures proxy refused a request off the app');
        },
        onTunnel: (target) => {
          logger.debug({ target }, 'the pictures proxy opened a tunnel to the app');
        },
      });
      browser = await deps.launch(
        launchOptions(exe, proxy.port, artifactsDir, browserEnv(deps.env ?? process.env)),
      );
      await ledger.track(exe);
    } catch (error) {
      try {
        await browser?.close();
      } catch {
        // The ledger stops what is left.
      }
      await ledger.end();
      await proxy?.close();
      throw error;
    }
    running = { browser, proxy, ledger };
    logger.info({ version: BROWSER_PIN.version }, 'launched the browser for pictures');
    return running;
  }

  function armIdle(): void {
    idle?.cancel();
    idle = deps.clock.setTimeout(() => {
      idle = null;
      void enqueue(shut);
    }, BROWSER_IDLE_MS);
  }

  return {
    prepare,
    status() {
      if (deps.ledgers === null) return { state: 'refused', problem: NO_LEDGER_PROBLEM };
      switch (prepared.kind) {
        case 'off':
          return { state: 'off', problem: null };
        case 'fetching':
          return { state: 'fetching', problem: null, ready: prepared.ready };
        case 'ready':
          return { state: 'ready', problem: null };
        case 'refused':
          return { state: 'refused', problem: prepared.problem };
      }
    },
    use(fn) {
      return enqueue(async () => {
        if (closed) throw new BrowserHostError('the browser for pictures is shut down');
        idle?.cancel();
        idle = null;
        const r = await open();
        try {
          return await fn(r.browser, r.proxy);
        } catch (error) {
          if (error instanceof BrowserStuckError) await shut();
          throw error;
        } finally {
          r.proxy.allow(null);
          if (!isClosed()) armIdle();
        }
      });
    },
    async close() {
      closed = true;
      idle?.cancel();
      idle = null;
      await enqueue(shut);
    },
  };
}
