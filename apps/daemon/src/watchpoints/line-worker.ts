import { parentPort } from 'node:worker_threads';
import { runChecks, type LineCheck } from './line-verdicts.ts';

// The line-pattern worker: one list of checks in, one list of verdicts out, then the main thread terminates it. A
// builder's pattern can backtrack for as long as a crafted line asks, and only a thread can be stopped from outside.

if (parentPort === null) throw new Error('line-worker runs as a worker thread');
const port = parentPort;

port.once('message', (checks: readonly LineCheck[]) => {
  port.postMessage([...runChecks(checks)]);
});
