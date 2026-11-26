import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { inFlightHosts, onInFlightChange } from '../outbound';
import {
  BEAT_MS,
  BEATS_BYTES,
  BeatLayout,
  SAMPLE_PREFIX,
  SAMPLE_SUFFIX,
  SAMPLES_KEPT,
  writeHosts,
} from './beats';

// The main loop can't watch itself: a worker thread does. The main thread adds to a shared counter
// each second; when the counter stands still, the worker logs the stall, samples the process and
// kills it, and the desktop shell's supervisor starts the daemon again.

export interface WatchdogOptions {
  /** The daemon's log file, which the stall line is appended to. */
  readonly logPath: string;
  /** Where a stall's sample is saved. */
  readonly sampleDir: string;
}

/** The built daemon carries the worker as its own bundle beside itself; from source it is the .ts file. */
const workerUrl = (): URL =>
  new URL(
    import.meta.url.endsWith('.ts') ? './worker.ts' : './watchdog-worker.mjs',
    import.meta.url,
  );

/** Removes all but the newest stall samples; their names sort by time. */
function pruneSamples(dir: string): void {
  try {
    const samples = readdirSync(dir)
      .filter((name) => name.startsWith(SAMPLE_PREFIX) && name.endsWith(SAMPLE_SUFFIX))
      .sort();
    for (const name of samples.slice(0, Math.max(samples.length - SAMPLES_KEPT, 0)))
      rmSync(join(dir, name), { force: true });
  } catch {
    // Old samples are only clutter: a directory that can't be read is left as it is.
  }
}

/** Starts watching the main thread; `stop` ends it, before a shutdown that may itself take long. */
export function startWatchdog(options: WatchdogOptions): { stop(): void } {
  pruneSamples(options.sampleDir);
  const beats = new SharedArrayBuffer(BEATS_BYTES);
  const slots = new Int32Array(beats, 0, 2);
  writeHosts(beats, inFlightHosts());
  const unsubscribe = onInFlightChange((hosts) => {
    writeHosts(beats, hosts);
  });
  const beat = setInterval(() => {
    Atomics.add(slots, BeatLayout.CounterIndex, 1);
  }, BEAT_MS);
  beat.unref();
  const worker = new Worker(workerUrl(), {
    workerData: {
      beats,
      pid: process.pid,
      logPath: options.logPath,
      sampleDir: options.sampleDir,
    },
  });
  // A watchdog that fails must not take the daemon with it; the daemon runs on unwatched.
  worker.on('error', (error) => {
    console.error('10db daemon: the watchdog stopped', error);
  });
  worker.unref();
  return {
    stop() {
      clearInterval(beat);
      unsubscribe();
      void worker.terminate();
    },
  };
}
