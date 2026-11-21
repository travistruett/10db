import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { ExtractionError } from './extraction-error';

// PDF and office-document text is extracted in a worker thread, killed at a deadline: both parsers
// run synchronously for as long as a crafted file asks, which would freeze the daemon.

/** Longest an extraction may run. */
export const EXTRACT_DEADLINE_MS = 30_000;

export interface ExtractJob {
  readonly kind: 'pdf' | 'docx' | 'pptx';
  readonly bytes: Uint8Array;
}

const Answer = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), text: z.string().nullable() }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);

/** The built daemon carries the worker as its own bundle beside itself; from source it is the .ts file. */
const workerUrl = (): URL =>
  new URL(
    import.meta.url.endsWith('.ts') ? './extract-worker.ts' : './extract-worker.mjs',
    import.meta.url,
  );

/**
 * The job's text, or null when the document has none. Rejects with `ExtractionError` when the file can't
 * be read or `deadlineMs` passes, in which case the worker is terminated.
 */
export function extractText(
  job: ExtractJob,
  deadlineMs: number = EXTRACT_DEADLINE_MS,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl(), { resourceLimits: { maxOldGenerationSizeMb: 1024 } });
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      settle();
    };
    const timer = setTimeout(() => {
      finish(() => {
        reject(
          new ExtractionError(`reading the file took more than ${String(deadlineMs / 1000)} s`),
        );
      });
    }, deadlineMs);
    worker.once('message', (raw: unknown) => {
      finish(() => {
        const answer = Answer.safeParse(raw);
        if (!answer.success) reject(new ExtractionError('the file could not be read'));
        else if (answer.data.ok) resolve(answer.data.text);
        else reject(new ExtractionError(answer.data.message));
      });
    });
    worker.once('error', (error) => {
      finish(() => {
        reject(error instanceof Error ? error : new ExtractionError('the file could not be read'));
      });
    });
    worker.once('exit', () => {
      finish(() => {
        reject(new ExtractionError('the file could not be read'));
      });
    });
    worker.postMessage(job);
  });
}
