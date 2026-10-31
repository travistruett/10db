import type { Clock, Timer } from '../clock';
import type { Logger } from '../log';

/** The load average (one minute) and the number of cores it is measured against. */
export interface LoadReading {
  readonly load: number;
  readonly cores: number;
}

/** What a busy process belongs to, as far as 10db can tell. */
export type Owner =
  /** A lane session, or something its tools started. `label` names the task. */
  | { readonly kind: 'lane'; readonly workstreamId: string; readonly label: string }
  /** A gate, a task's or a batch's. `label` names which. */
  | { readonly kind: 'gate'; readonly label: string }
  /** 10db's own daemon, or something it started that is no lane or gate. */
  | { readonly kind: 'daemon' }
  /** Something in the temp dir of a lane session that has ended, so it was left behind. */
  | { readonly kind: 'ended-lane' }
  /** Nothing 10db started that it can find. */
  | { readonly kind: 'other' };

/** A process using the CPU. */
export interface Culprit {
  readonly pid: number;
  /** ps's CPU percentage: 100 is one core. */
  readonly cpu: number;
  /** The command, shortened for a card. */
  readonly command: string;
  readonly owner: Owner;
}

/** What `onOverloaded` is told, at the start of an overload and at every sample after it. */
export interface OverloadReport {
  readonly load: number;
  readonly cores: number;
  /** When the overload was declared. */
  readonly since: Date;
  /** The processes using the most CPU now; empty when they could not be read. */
  readonly culprits: readonly Culprit[];
}

/** What a gate that failed during an overload says about it. */
export interface OverloadNote {
  readonly peakLoad: number;
  readonly cores: number;
}

export interface LoadGuard {
  /** True from the moment an overload is declared until the load has fallen. */
  readonly overloaded: boolean;
  /**
   * Resolves true at once when the Mac is not overloaded, or once it is no longer. Resolves false when
   * `signal` aborts first. Shutdown (`stop`) releases every waiter with true.
   */
  untilClear(signal?: AbortSignal): Promise<boolean>;
  /** The overload that was on at any time since `since`, or null. */
  overloadedSince(since: Date): OverloadNote | null;
  /** Reads the load once and acts on it. The loop calls it; tests call it too. */
  sample(): Promise<void>;
  start(): void;
  stop(): void;
}

export interface LoadGuardOptions {
  readonly clock: Clock;
  readonly logger: Logger;
  read(): LoadReading;
  /** The top CPU users and what each belongs to; asked only while overloaded. */
  culprits(): Promise<readonly Culprit[]>;
  /** An overload was declared, and again at each sample while it lasts. */
  onOverloaded(report: OverloadReport): void;
  /** The load fell and work may start again. */
  onCleared(): void;
  /** How often the load is read. */
  readonly sampleMs?: number;
  /** Overloaded means the load stays above this many times the core count... */
  readonly overloadFactor?: number;
  /** ...for this long. */
  readonly sustainedMs?: number;
  /** An overload ends when the load is below this many times the core count. */
  readonly clearFactor?: number;
}

export const DEFAULT_SAMPLE_MS = 30_000;
/** Well past what a full set of lanes and gates can ask of a Mac: the night's load was 15 to 20 times. */
export const DEFAULT_OVERLOAD_FACTOR = 4;
export const DEFAULT_SUSTAINED_MS = 5 * 60_000;
/** Lower than the level that starts an overload, so a load hovering at the edge doesn't flap. */
export const DEFAULT_CLEAR_FACTOR = 2;

interface Episode {
  readonly cores: number;
  peak: number;
  /** When it was declared, as the clock read. */
  readonly since: Date;
  /** Null while it lasts. */
  ended: Date | null;
}

export function createLoadGuard(opts: LoadGuardOptions): LoadGuard {
  const sampleMs = opts.sampleMs ?? DEFAULT_SAMPLE_MS;
  const overloadFactor = opts.overloadFactor ?? DEFAULT_OVERLOAD_FACTOR;
  const sustainedMs = opts.sustainedMs ?? DEFAULT_SUSTAINED_MS;
  const clearFactor = opts.clearFactor ?? DEFAULT_CLEAR_FACTOR;
  let timer: Timer | null = null;
  let started = false;
  let sampling: Promise<void> | null = null;
  // The first sample of the current stretch above the limit, and the highest load in it.
  let above: { readonly at: number; peak: number } | null = null;
  let current: Episode | null = null;
  let last: Episode | null = null;
  const waiters = new Set<() => void>();

  function release(): void {
    for (const resolve of [...waiters]) resolve();
  }

  async function culpritsNow(): Promise<readonly Culprit[]> {
    try {
      return await opts.culprits();
    } catch (error) {
      opts.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'could not read what is using the CPU',
      );
      return [];
    }
  }

  async function run(): Promise<void> {
    const { load, cores } = opts.read();
    const now = opts.clock.now();
    if (current === null) {
      if (load <= overloadFactor * cores) {
        above = null;
        return;
      }
      above = { at: above?.at ?? now.getTime(), peak: Math.max(above?.peak ?? 0, load) };
      if (now.getTime() - above.at < sustainedMs) return;
      current = { cores, peak: above.peak, since: now, ended: null };
      last = current;
      above = null;
      opts.logger.warn({ load, cores }, 'the Mac is overloaded: holding new lanes and gates');
    } else {
      if (load < clearFactor * cores) {
        current.ended = now;
        current = null;
        opts.logger.info({ load, cores }, 'the Mac is no longer overloaded');
        release();
        opts.onCleared();
        return;
      }
      current.peak = Math.max(current.peak, load);
    }
    const episode = current;
    const culprits = await culpritsNow();
    // The load may have fallen while ps ran; the report would name the wrong moment.
    if (current !== episode) return;
    opts.onOverloaded({ load, cores, since: episode.since, culprits });
  }

  function sample(): Promise<void> {
    sampling ??= run().finally(() => {
      sampling = null;
    });
    return sampling;
  }

  function loop(): void {
    void sample()
      .catch((error: unknown) => {
        opts.logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          'load sample failed',
        );
      })
      .finally(() => {
        if (started) timer = opts.clock.setTimeout(loop, sampleMs);
      });
  }

  return {
    get overloaded() {
      return current !== null;
    },
    untilClear(signal) {
      if (signal?.aborted) return Promise.resolve(false);
      if (current === null) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const done = (ok: boolean): void => {
          waiters.delete(open);
          signal?.removeEventListener('abort', onAbort);
          resolve(ok);
        };
        const open = (): void => {
          done(true);
        };
        const onAbort = (): void => {
          done(false);
        };
        waiters.add(open);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    overloadedSince(since) {
      const episode = current ?? last;
      if (episode === null) return null;
      if (episode.ended !== null && episode.ended.getTime() < since.getTime()) return null;
      return { peakLoad: episode.peak, cores: episode.cores };
    },
    sample,
    start() {
      started = true;
      timer ??= opts.clock.setTimeout(loop, sampleMs);
    },
    stop() {
      started = false;
      timer?.cancel();
      timer = null;
      release();
    },
  };
}
