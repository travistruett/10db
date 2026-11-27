import { existsSync, renameSync, rmSync, statSync } from 'node:fs';
import pino, { type DestinationStream } from 'pino';

/** Rotates `path` to `path.1` … `path.<keep>` when it is larger than `maxBytes`; true when it did. */
export function rotateLogFile(path: string, maxBytes = 10 * 1024 * 1024, keep = 5): boolean {
  if (!existsSync(path) || statSync(path).size <= maxBytes) return false;
  rmSync(`${path}.${String(keep)}`, { force: true });
  for (let i = keep - 1; i >= 1; i -= 1) {
    if (existsSync(`${path}.${String(i)}`)) {
      renameSync(`${path}.${String(i)}`, `${path}.${String(i + 1)}`);
    }
  }
  renameSync(path, `${path}.1`);
  return true;
}

const ROTATION_CHECK_MS = 60 * 60 * 1000;

/** The daemon's log file: a write after it ended or failed is dropped, never thrown. */
export interface LogFile {
  /** What the logger writes to. */
  readonly destination: DestinationStream;
  /** Checks the log's size every hour on `clock`, rotating it and reopening the stream when it is over. */
  keepRotated(clock: { setTimeout(fn: () => void, ms: number): { cancel(): void } }): void;
  /** Stops the size check, ends the stream and resolves once its descriptor is closed. */
  close(): Promise<void>;
}

/**
 * An asynchronous pino destination that creates the log directory when missing. SonicBoom throws on a
 * write after it ended and on an `error` nobody listens for; a logger call from a handler that outlives
 * shutdown would turn either into an unhandled rejection.
 */
export function openLogFile(path: string): LogFile {
  const sonic = pino.destination({ dest: path, mkdir: true, sync: false });
  let usable = true;
  // Set by the first error. A stream whose open failed never emits `close` or `ready`, so `end()` would wait for
  // good; close resolves at once for it instead.
  let failed = false;
  let opened = false;
  sonic.once('ready', () => {
    opened = true;
  });
  let timer: { cancel(): void } | null = null;
  let closing: Promise<void> | null = null;
  sonic.on('error', (error: unknown) => {
    usable = false;
    // pino's own listener emits the first error again; it is reported once.
    if (failed) return;
    failed = true;
    // A stream that never opened would throw from pino's flush at exit; pino quiets a broken pipe the same way.
    if (!opened) {
      sonic.flushSync = () => undefined;
    }
    process.stderr.write(`10db: the daemon log failed: ${String(error)}\n`);
  });
  const destination: DestinationStream = {
    write(line) {
      if (!usable) return;
      try {
        sonic.write(line);
      } catch {
        usable = false;
      }
    },
  };
  return {
    destination,
    keepRotated(clock) {
      const tick = (): void => {
        timer = clock.setTimeout(() => {
          if (usable) {
            try {
              if (rotateLogFile(path)) sonic.reopen();
            } catch (error) {
              process.stderr.write(`10db: the daemon log could not rotate: ${String(error)}\n`);
            }
          }
          tick();
        }, ROTATION_CHECK_MS);
      };
      tick();
    },
    close() {
      timer?.cancel();
      usable = false;
      closing ??= new Promise<void>((resolve) => {
        // Only a stream that never opened has no descriptor to close; one that failed later still ends.
        if (failed && !opened) {
          resolve();
          return;
        }
        sonic.once('close', () => {
          resolve();
        });
        sonic.once('error', () => {
          resolve();
        });
        sonic.end();
      });
      return closing;
    },
  };
}
