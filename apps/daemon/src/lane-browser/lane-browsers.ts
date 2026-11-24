import { chmod, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionId } from '@10db/contracts';
import type { Clock, Timer } from '../clock';
import type { Logger } from '../log';
import {
  BROWSER_CLOSE_MS,
  BROWSER_IDLE_MS,
  BrowserStuckError,
  DeadlineError,
  launchOptions,
  NO_LEDGER_PROBLEM,
  openBrowserLedger,
  withDeadline,
  type BrowserLaunches,
  type BrowserLedger,
} from '../pictures';
import type { LaneProcessFailure, LaneProcessSetup, LedgerSweep } from '../sandbox';
import type { LaneDriver, LaunchLaneDriver } from './driver';
import { startLaneProxy, type LaneProxy } from './lane-proxy';
import { createPortOwner, type PortReaders } from './port-owner';
import type { LaneBrowserSession } from './session';

/** How long any one call may take, counted from its arrival, a wait behind another call included. */
export const CALL_DEADLINE_MS = 60_000;
/** How long the browser stays open after a session's last call. */
export const LANE_BROWSER_IDLE_MS = BROWSER_IDLE_MS;

const FETCHING = '10db is fetching its browser; try again in a minute';
const FRESH_BROWSER = 'a fresh browser: no cookies from earlier sessions';
const IDLE_CLOSED =
  'The browser closed after five idle minutes, so its cookies were cleared; sign in again.';
const STOPPED = 'the browser had stopped, so its cookies were cleared; sign in again';
const RESTARTED =
  'the browser was restarted after a stuck page, so its cookies were cleared; sign in again';

/** A call can't be run; the message is what the lane is told. */
export class LaneBrowserError extends Error {
  override readonly name = 'LaneBrowserError';
}

export interface LaneBrowsers {
  /**
   * Runs one call on the session's browser, launching it and its proxy first when closed, after any call of
   * the session in flight, all within `CALL_DEADLINE_MS`; `notes` gets "cookies were cleared" after an idle
   * close. Throws `LaneBrowserError` with the answer's words.
   */
  use<T>(
    session: LaneBrowserSession,
    signal: AbortSignal,
    fn: (driver: LaneDriver, proxy: LaneProxy, notes: string[]) => Promise<T>,
  ): Promise<T>;
  /** Closes the session's browser and proxy; a call in flight answers "the session ended". */
  end(sessionId: SessionId): Promise<void>;
  /** Shutdown: ends every session's browser and refuses later calls. */
  close(): Promise<void>;
}

interface Running {
  readonly driver: LaneDriver;
  readonly proxy: LaneProxy;
  readonly ledger: BrowserLedger;
}

interface Entry {
  /** Every call, launch, idle close and end of the session runs after the one before it. */
  queue: Promise<unknown>;
  running: Running | null;
  idle: Timer | null;
  /** Aborted when the session ends or the daemon stops. */
  readonly end: AbortController;
  launchedBefore: boolean;
  /** What the next call is told about the browser it finds. */
  carry: string[];
}

/** Read through a call: the entry may end, and the daemon close, while a call awaits. */
const isEnded = (entry: Entry): boolean => entry.end.signal.aborted;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The driver as one call sees it: each method also stops when the call's deadline or session ends. */
function boundTo(driver: LaneDriver, call: AbortSignal): LaneDriver {
  const joined = (signal: AbortSignal): AbortSignal => AbortSignal.any([signal, call]);
  return {
    open: (url, viewport, signal) => driver.open(url, viewport, joined(signal)),
    snapshot: (signal) => driver.snapshot(joined(signal)),
    act: (input, signal) => driver.act(input, joined(signal)),
    upload: (ref, files, signal) => driver.upload(ref, files, joined(signal)),
    screenshot: (fullPage, signal) => driver.screenshot(fullPage, joined(signal)),
    isConnected: () => driver.isConnected(),
    close: () => driver.close(),
  };
}

export function createLaneBrowsers(deps: {
  readonly dataDir: string;
  readonly ledgers: { readonly sweep: LedgerSweep; readonly root: string } | null;
  readonly processes: LaneProcessSetup;
  readonly launches: BrowserLaunches;
  /** The pinned build, shared with pictures: one fetch, and whether it is fetching now. */
  readonly build: { ready(): Promise<string>; fetching(): boolean };
  readonly launch: LaunchLaneDriver;
  readonly readers: PortReaders;
  readonly daemonPort: () => number | null;
  readonly clock: Clock;
  readonly logger: Logger;
}): LaneBrowsers {
  const logger = deps.logger.child({ module: 'lane-browser' });
  const launches = deps.launches;
  const entries = new Map<SessionId, Entry>();
  /** Sessions that ended, by id, for the daemon's life: a late call never launches. */
  const ended = new Set<SessionId>();
  let closed = false;
  const isClosed = (): boolean => closed;

  const runningOf = (): Running[] =>
    [...entries.values()].flatMap((entry) => (entry.running === null ? [] : [entry.running]));
  const proxyPorts = (): ReadonlySet<number> =>
    new Set(runningOf().map((running) => running.proxy.port));
  const browserPids = (): ReadonlySet<number> =>
    new Set(runningOf().flatMap((running) => [...running.ledger.pids()]));

  function enqueue<T>(entry: Entry, job: () => Promise<T>): Promise<T> {
    const run = entry.queue.then(job, job);
    entry.queue = run.catch(() => undefined);
    return run;
  }

  /** Closes what the entry runs; safe to run again or beside a queued shut. */
  async function shutBrowser(entry: Entry, sessionId: SessionId, why: string): Promise<void> {
    const running = entry.running;
    entry.running = null;
    entry.idle?.cancel();
    entry.idle = null;
    if (running === null) return;
    try {
      await withDeadline(
        deps.clock,
        BROWSER_CLOSE_MS,
        () => running.driver.close(),
        () => undefined,
      );
    } catch (error) {
      logger.warn(
        { sessionId, err: message(error) },
        'the lane browser did not close cleanly; its processes are stopped from its ledger',
      );
    }
    // Stops whatever of the browser still runs, the browser itself when its close never ended.
    await running.ledger.end();
    await running.proxy.close();
    logger.info({ sessionId, why }, 'closed the lane browser');
  }

  const sessionDir = (sessionId: SessionId): string =>
    join(deps.dataDir, 'browser', 'lanes', sessionId);

  async function shutEntry(entry: Entry, sessionId: SessionId, why: string): Promise<void> {
    await shutBrowser(entry, sessionId, why);
    await rm(sessionDir(sessionId), { recursive: true, force: true });
  }

  async function launchBrowser(entry: Entry, session: LaneBrowserSession): Promise<Running> {
    const ledgers = deps.ledgers;
    if (ledgers === null) throw new LaneBrowserError(NO_LEDGER_PROBLEM);
    if (deps.build.fetching()) throw new LaneBrowserError(FETCHING);
    let exe: string;
    try {
      exe = await deps.build.ready();
    } catch (error) {
      throw new LaneBrowserError(`10db's browser could not be fetched: ${message(error)}`);
    }
    if (isClosed() || isEnded(entry)) throw new LaneBrowserError('the session ended');
    const artifactsDir = join(sessionDir(session.sessionId), 'artifacts');
    await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
    await chmod(artifactsDir, 0o700);
    const reported = new Set<LaneProcessFailure>();
    const ledger = openBrowserLedger({
      root: ledgers.root,
      sweep: ledgers.sweep,
      processes: deps.processes,
      launches,
      onError: (failure, error) => {
        if (reported.has(failure)) return;
        reported.add(failure);
        logger.warn(
          { sessionId: session.sessionId, failure, err: message(error) },
          "could not watch the lane browser's processes",
        );
      },
    });
    let proxy: LaneProxy | null = null;
    const made: { driver: LaneDriver | null } = { driver: null };
    try {
      const owner = createPortOwner(
        {
          clock: deps.clock,
          readers: deps.readers,
          daemonPort: deps.daemonPort,
          proxyPorts,
          browserPids,
        },
        session,
      );
      proxy = await startLaneProxy(owner, logger);
      const env: Record<string, string> = {};
      for (const name of ['HOME', 'TMPDIR']) {
        const value = process.env[name];
        if (value !== undefined && value !== '') env[name] = value;
      }
      const options = launchOptions(exe, proxy.port, artifactsDir, env);
      await launches.one(async () => {
        await ledger.mark();
        made.driver = await deps.launch(options);
        await ledger.track(exe);
      });
    } catch (error) {
      try {
        await made.driver?.close();
      } catch {
        // The ledger stops what is left.
      }
      await ledger.end();
      await proxy?.close();
      logger.warn(
        { sessionId: session.sessionId, err: message(error) },
        'the lane browser did not launch',
      );
      throw new LaneBrowserError(`the browser could not start: ${message(error)}`);
    }
    if (made.driver === null) {
      throw new LaneBrowserError('the browser could not start');
    }
    logger.info({ sessionId: session.sessionId }, 'launched the lane browser');
    return { driver: made.driver, proxy, ledger };
  }

  function armIdle(entry: Entry, sessionId: SessionId): void {
    entry.idle?.cancel();
    entry.idle = deps.clock.setTimeout(() => {
      entry.idle = null;
      void enqueue(entry, async () => {
        if (entry.running === null) return;
        entry.carry.push(IDLE_CLOSED);
        await shutBrowser(entry, sessionId, 'idle');
      });
    }, LANE_BROWSER_IDLE_MS);
  }

  async function work<T>(
    entry: Entry,
    session: LaneBrowserSession,
    call: AbortSignal,
    fn: (driver: LaneDriver, proxy: LaneProxy, notes: string[]) => Promise<T>,
  ): Promise<T> {
    const sessionId = session.sessionId;
    if (call.aborted) throw new LaneBrowserError('timed out');
    if (isClosed() || isEnded(entry)) throw new LaneBrowserError('the session ended');
    entry.idle?.cancel();
    entry.idle = null;
    const notes: string[] = [];
    try {
      if (entry.running !== null && !entry.running.driver.isConnected()) {
        entry.carry.push(STOPPED);
        await shutBrowser(entry, sessionId, 'the browser stopped');
      }
      if (entry.running === null) {
        entry.running = await launchBrowser(entry, session);
        if (!entry.launchedBefore) {
          entry.launchedBefore = true;
          notes.push(FRESH_BROWSER);
        }
      }
      notes.push(...entry.carry);
      entry.carry = [];
      // A session that ended while the browser launched finds it closed by the shut queued behind.
      if (isEnded(entry)) throw new LaneBrowserError('the session ended');
      const running = entry.running;
      try {
        return await fn(boundTo(running.driver, call), running.proxy, notes);
      } catch (error) {
        if (error instanceof BrowserStuckError) {
          entry.carry.push(RESTARTED);
          await shutBrowser(entry, sessionId, 'a stuck page');
        }
        throw error;
      }
    } finally {
      if (entry.running !== null && !isClosed() && !isEnded(entry)) armIdle(entry, sessionId);
    }
  }

  function asLaneError(error: unknown): LaneBrowserError {
    if (error instanceof LaneBrowserError) return error;
    if (error instanceof DeadlineError) return new LaneBrowserError('timed out');
    return new LaneBrowserError(message(error));
  }

  return {
    async use(session, signal, fn) {
      const sessionId = session.sessionId;
      if (closed) throw new LaneBrowserError('the browser is shut down');
      if (ended.has(sessionId)) throw new LaneBrowserError('the session ended');
      if (deps.ledgers === null) throw new LaneBrowserError(NO_LEDGER_PROBLEM);
      let entry = entries.get(sessionId);
      if (entry === undefined) {
        entry = {
          queue: Promise.resolve(),
          running: null,
          idle: null,
          end: new AbortController(),
          launchedBefore: false,
          carry: [],
        };
        entries.set(sessionId, entry);
      }
      const own = entry;
      own.idle?.cancel();
      own.idle = null;
      const call = new AbortController();
      const joined = AbortSignal.any([signal, own.end.signal]);
      let settled = false;
      const isSettled = (): boolean => settled;
      const job = enqueue(own, () => work(own, session, call.signal, fn));
      const done = (): void => {
        settled = true;
      };
      job.then(done, done);
      try {
        return await withDeadline(
          deps.clock,
          CALL_DEADLINE_MS,
          () => job,
          () => {
            call.abort(new LaneBrowserError('timed out'));
          },
          joined,
        );
      } catch (error) {
        // A call that won't stop (its page would not close) closes the browser out from under it.
        if (!isSettled()) {
          deps.clock.setTimeout(() => {
            if (isSettled()) return;
            own.carry.push(RESTARTED);
            void shutBrowser(own, sessionId, 'a call that would not stop');
          }, BROWSER_CLOSE_MS);
        }
        throw asLaneError(error);
      }
    },
    async end(sessionId) {
      ended.add(sessionId);
      const entry = entries.get(sessionId);
      if (entry === undefined) return;
      entry.end.abort(new LaneBrowserError('the session ended'));
      await enqueue(entry, async () => {
        await shutEntry(entry, sessionId, 'the session ended');
        entries.delete(sessionId);
      });
    },
    async close() {
      closed = true;
      await Promise.all(
        [...entries].map(async ([sessionId, entry]) => {
          entry.end.abort(new LaneBrowserError('the browser is shut down'));
          await enqueue(entry, async () => {
            await shutEntry(entry, sessionId, 'the daemon stopped');
            entries.delete(sessionId);
          });
        }),
      );
    },
  };
}
