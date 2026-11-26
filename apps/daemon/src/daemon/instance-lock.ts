import { execFile } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { systemClock, type Clock } from '../clock';
import { readRuntimeInfo } from '../runtime-files';

const run = promisify(execFile);

/** How long a holder that runs but does not answer /health keeps the lock. */
const HOLDER_SILENCE_MS = 10_000;
/** The wait between two /health probes of the holder. */
const HEALTH_POLL_MS = 1_000;
/** How long one /health probe may take. */
const HEALTH_TIMEOUT_MS = 2_000;
/** How long a killed holder gets to leave the process table. */
const KILL_WAIT_MS = 5_000;
const KILL_POLL_MS = 100;
/** One for the lock as found, one after a dead holder's lock is removed. */
const ATTEMPTS = 2;
const LOCK_FILE = 'daemon.lock';
const HEALTH_PATH = '/health';

export class AlreadyRunningError extends Error {
  override readonly name = 'AlreadyRunningError';
  readonly pid: number;
  constructor(pid: number) {
    super(`Another 10db daemon is running (pid ${String(pid)})`);
    this.pid = pid;
  }
}

export interface InstanceLockOptions {
  /** How long the holder may stay silent on /health before it is killed and replaced. */
  readonly silenceMs?: number;
  readonly clock?: Clock;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, 'EPERM');
  }
}

const HolderState = z.object({ stat: z.string().min(1), lstart: z.string().min(1) });
type HolderState = z.infer<typeof HolderState>;

/**
 * The holder's process state and OS start time, or null when they can't be read: ps could not run
 * (it is setuid, and a sandbox refuses it), found no such pid, or printed something else. Null
 * means unknown, never dead.
 */
async function holderState(pid: number): Promise<HolderState | null> {
  try {
    // ps prints the start time as local time with no zone, and the caller parses it with `Date`, so
    // ps must print in the zone this process parses in: its `TZ` when set, the system's otherwise.
    const zone = process.env['TZ'];
    const { stdout } = await run('/bin/ps', ['-o', 'stat=', '-o', 'lstart=', '-p', String(pid)], {
      env: zone === undefined ? { LC_ALL: 'C' } : { LC_ALL: 'C', TZ: zone },
    });
    const row = stdout.trim();
    const split = row.search(/\s/);
    if (split < 0) return null;
    const parsed = HolderState.safeParse({
      stat: row.slice(0, split),
      lstart: row.slice(split).trim(),
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A zombie (`Z`) or a process that is exiting (`E`) holds nothing any more. */
function statMeansGone(stat: string): boolean {
  return stat.startsWith('Z') || stat.includes('E');
}

/** True only on proof: no such pid, or a state read from ps that says zombie or exiting. */
async function gone(pid: number): Promise<boolean> {
  if (!alive(pid)) return true;
  const state = await holderState(pid);
  return state !== null && statMeansGone(state.stat);
}

function runtimeInfo(dataDir: string): ReturnType<typeof readRuntimeInfo> | null {
  try {
    return readRuntimeInfo(dataDir);
  } catch {
    return null;
  }
}

async function healthAnswers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}${HEALTH_PATH}`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => {
    clock.setTimeout(resolve, ms);
  });
}

/**
 * Decides whether the process holding the lock still counts. Returns when the lock may be taken
 * over; throws `AlreadyRunningError` when the holder keeps it.
 *
 * A holder is killed only when all of this holds: `daemon.json` names its pid, its /health stayed
 * silent for `silenceMs`, and ps shows it started no later than `daemon.json` says the daemon did,
 * so it is that daemon and not a stranger that reused the pid. Anything unreadable leaves it alone.
 */
async function settleHolder(
  dataDir: string,
  holder: number,
  silenceMs: number,
  clock: Clock,
): Promise<void> {
  if (holder === process.pid) throw new AlreadyRunningError(holder);
  if (await gone(holder)) return;
  // daemon.json exists only while the holder's server listens: without it there is nothing to probe.
  const info = runtimeInfo(dataDir);
  if (info?.pid !== holder) throw new AlreadyRunningError(holder);

  const deadline = clock.now().getTime() + silenceMs;
  for (;;) {
    if (await healthAnswers(info.port)) throw new AlreadyRunningError(holder);
    if (clock.now().getTime() >= deadline) break;
    await sleep(clock, HEALTH_POLL_MS);
  }

  if (!alive(holder)) return;
  const state = await holderState(holder);
  if (state === null) throw new AlreadyRunningError(holder);
  if (statMeansGone(state.stat)) return;
  const startedMs = new Date(state.lstart).getTime();
  if (Number.isNaN(startedMs)) throw new AlreadyRunningError(holder);
  // ps reports whole seconds. A process that started after the daemon wrote daemon.json is not it.
  const daemonStartedMs = Math.floor(new Date(info.startedAt).getTime() / 1000) * 1000;
  if (startedMs > daemonStartedMs) return;

  try {
    process.kill(holder, 'SIGKILL');
  } catch (error) {
    if (hasCode(error, 'ESRCH')) return;
    throw new AlreadyRunningError(holder);
  }
  const killDeadline = clock.now().getTime() + KILL_WAIT_MS;
  while (clock.now().getTime() < killDeadline) {
    if (await gone(holder)) return;
    await sleep(clock, KILL_POLL_MS);
  }
  throw new AlreadyRunningError(holder);
}

/**
 * One daemon per data directory. The lock of a holder that is dead, a zombie or exiting is taken
 * over, and a holder that runs but no longer answers /health is killed first.
 */
export async function acquireInstanceLock(
  dataDir: string,
  options: InstanceLockOptions = {},
): Promise<{ release(): void }> {
  const silenceMs = options.silenceMs ?? HOLDER_SILENCE_MS;
  const clock = options.clock ?? systemClock;
  const path = join(dataDir, LOCK_FILE);
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx' });
      return {
        release() {
          try {
            if (readFileSync(path, 'utf8') === String(process.pid)) rmSync(path, { force: true });
          } catch {
            // Already gone.
          }
        },
      };
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
      const holder = Number(readFileSync(path, 'utf8'));
      if (Number.isInteger(holder) && holder > 0)
        await settleHolder(dataDir, holder, silenceMs, clock);
      rmSync(path, { force: true });
    }
  }
  throw new Error(`Could not take the daemon lock at ${path}`);
}
