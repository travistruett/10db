import { execFileSync } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { workerData } from 'node:worker_threads';
import { z } from 'zod';
import {
  BEAT_MS,
  BeatLayout,
  readHosts,
  SAMPLE_PREFIX,
  SAMPLE_SUFFIX,
  SAMPLE_TIMEOUT_MS,
  STALL_MS,
} from './beats';

// Runs in the watchdog's worker thread. Everything here is synchronous and touches nothing the main
// thread owns: when it acts, the main thread is not running.

const SAMPLE = '/usr/bin/sample';
/** pino's number for `fatal`, so the line reads as the daemon's own. */
const FATAL = 60;

const Job = z.object({
  beats: z.instanceof(SharedArrayBuffer),
  pid: z.number().int().positive(),
  logPath: z.string().min(1),
  sampleDir: z.string().min(1),
});
const job = Job.parse(workerData);
const slots = new Int32Array(job.beats, 0, 2);

/** Appends one line to the daemon's log, in the shape of its other lines. Never throws. */
function log(fields: Record<string, unknown>, msg: string): void {
  try {
    const fd = openSync(job.logPath, 'a');
    try {
      writeSync(
        fd,
        `${JSON.stringify({ level: FATAL, time: Date.now(), pid: job.pid, component: 'watchdog', ...fields, msg })}\n`,
      );
    } finally {
      closeSync(fd);
    }
  } catch {
    // With no log to write to, the sample and the kill still go ahead.
  }
}

function stalled(stalledMs: number): void {
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const samplePath = join(job.sampleDir, `${SAMPLE_PREFIX}${stamp}${SAMPLE_SUFFIX}`);
  log(
    {
      stalledMs,
      rssBytes: process.memoryUsage.rss(),
      hosts: readHosts(job.beats),
      samplePath,
    },
    'The main thread stopped answering: sampling the process, then killing it so it is started again',
  );
  try {
    execFileSync(SAMPLE, [String(job.pid), '1', '-file', samplePath], {
      timeout: SAMPLE_TIMEOUT_MS,
      stdio: 'ignore',
    });
  } catch (error) {
    log(
      { samplePath, error: error instanceof Error ? error.message : String(error) },
      'No sample was taken',
    );
  }
  process.kill(job.pid, 'SIGKILL');
}

let lastCount = Atomics.load(slots, BeatLayout.CounterIndex);
let lastTick = Date.now();
let quietMs = 0;

setInterval(() => {
  const now = Date.now();
  const gap = now - lastTick;
  lastTick = now;
  const count = Atomics.load(slots, BeatLayout.CounterIndex);
  // A late tick means this thread was not running either (the Mac slept, or the process was
  // stopped), so the time says nothing about the main thread.
  if (count !== lastCount || gap > 3 * BEAT_MS) {
    lastCount = count;
    quietMs = 0;
    return;
  }
  quietMs += gap;
  if (quietMs >= STALL_MS) stalled(quietMs);
}, BEAT_MS);
