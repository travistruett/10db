import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import type { LineCheck, LineVerdicts } from './line-verdicts';

/** Longest the line patterns may run for one reading. */
export const LINE_DEADLINE_MS = 5000;

const Answer = z.array(z.tuple([z.string(), z.object({ matched: z.boolean(), cut: z.boolean() })]));

/** The built daemon carries the worker as its own bundle beside itself; from source it is the .ts file. */
const workerUrl = (): URL =>
  new URL(
    import.meta.url.endsWith('.ts') ? './line-worker.ts' : './line-worker.mjs',
    import.meta.url,
  );

/**
 * The verdicts of `checks`, computed in a worker thread killed at `deadlineMs`. Null when the worker dies, answers
 * badly or runs out of time: no line is then cleared.
 */
export function readLineVerdicts(
  checks: readonly LineCheck[],
  deadlineMs: number = LINE_DEADLINE_MS,
): Promise<LineVerdicts | null> {
  if (checks.length === 0) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    const worker = new Worker(workerUrl());
    let settled = false;
    const finish = (verdicts: LineVerdicts | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(verdicts);
    };
    const timer = setTimeout(() => {
      finish(null);
    }, deadlineMs);
    worker.once('message', (raw: unknown) => {
      const answer = Answer.safeParse(raw);
      finish(answer.success ? new Map(answer.data) : null);
    });
    worker.once('error', () => {
      finish(null);
    });
    worker.once('exit', () => {
      finish(null);
    });
    worker.postMessage(checks);
  });
}
