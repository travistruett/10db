import { existsSync, renameSync, rmSync, statSync } from 'node:fs';
import pino, { type DestinationStream } from 'pino';

/** Rotates `path` to `path.1` … `path.<keep>` when it is larger than `maxBytes`. */
export function rotateLogFile(path: string, maxBytes = 10 * 1024 * 1024, keep = 5): void {
  if (!existsSync(path) || statSync(path).size <= maxBytes) return;
  rmSync(`${path}.${String(keep)}`, { force: true });
  for (let i = keep - 1; i >= 1; i -= 1) {
    if (existsSync(`${path}.${String(i)}`)) {
      renameSync(`${path}.${String(i)}`, `${path}.${String(i + 1)}`);
    }
  }
  renameSync(path, `${path}.1`);
}

/** An asynchronous pino destination that creates the log directory when missing. */
export function fileDestination(path: string): DestinationStream {
  return pino.destination({ dest: path, mkdir: true, sync: false });
}
