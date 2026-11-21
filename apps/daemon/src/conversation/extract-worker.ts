import { parentPort } from 'node:worker_threads';
import { ExtractionError } from './extraction-error.ts';
import { officeText } from './office-text.ts';
import { pdfText } from './pdf-extract.ts';

// The extraction worker: one job in, one answer out, then the main thread terminates it. PDF.js and the
// unzipper run for as long as a hostile file lets them, and only a thread can be stopped from outside.

if (parentPort === null) throw new Error('extract-worker runs as a worker thread');
const port = parentPort;

port.once('message', (job: { kind: 'pdf' | 'docx' | 'pptx'; bytes: Uint8Array }) => {
  const done =
    job.kind === 'pdf' ? pdfText(job.bytes) : Promise.resolve(officeText(job.kind, job.bytes));
  done.then(
    (text) => {
      port.postMessage({ ok: true, text });
    },
    (error: unknown) => {
      port.postMessage({
        ok: false,
        message: error instanceof ExtractionError ? error.message : 'the file could not be read',
      });
    },
  );
});
