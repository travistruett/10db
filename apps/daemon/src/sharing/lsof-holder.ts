import { execFile } from 'node:child_process';
import { z } from 'zod';

const LSOF_TIMEOUT_MS = 3_000;

/** lsof's output could not be read: malformed `-F` fields, a run that failed, or a timeout. */
export class LsofUnreadableError extends Error {
  override readonly name = 'LsofUnreadableError';
}

/** One `-Fpc` process record: `p` is the pid, `c` the command name. Other field ids are dropped. */
const LsofProcess = z.object({
  p: z.string().regex(/^[1-9]\d*$/),
  c: z.string().min(1),
});

/**
 * `"<command> (pid <n>)"` for the first process in `lsof -Fpc` output, or null when the output is empty (nothing
 * listens). Each line is a one-character field id followed by its value; a record runs from one `p` line to the next.
 */
export function holderFromLsof(stdout: string): string | null {
  const lines = stdout.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  const fields = new Map<string, string>();
  for (const line of lines) {
    const id = line.slice(0, 1);
    if (id === 'p' && fields.has('p')) break;
    if (!fields.has(id)) fields.set(id, line.slice(1));
  }
  const parsed = LsofProcess.safeParse(Object.fromEntries(fields));
  if (!parsed.success) {
    // Field names only: a value could be anything lsof printed.
    const failing = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ');
    throw new LsofUnreadableError(`lsof output is missing or malformed: ${failing}`);
  }
  return `${parsed.data.c} (pid ${parsed.data.p})`;
}

/**
 * The process listening on a loopback port, as {@link holderFromLsof} reads it. Rejects with LsofUnreadableError when
 * lsof can't run, times out, or prints something unreadable.
 */
export function lsofHolderOf(port: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(
      'lsof',
      ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-Fpc'],
      { timeout: LSOF_TIMEOUT_MS, env: { PATH: process.env['PATH'] ?? '' } },
      (error, stdout) => {
        // lsof exits 1 when nothing matches, with empty output; a numeric code means it ran.
        if (error !== null && (error.killed === true || typeof error.code !== 'number')) {
          reject(
            new LsofUnreadableError(
              error.killed === true
                ? 'lsof timed out'
                : `lsof could not run (${String(error.code)})`,
            ),
          );
          return;
        }
        try {
          resolve(holderFromLsof(stdout));
        } catch (parseError: unknown) {
          reject(
            parseError instanceof LsofUnreadableError
              ? parseError
              : new LsofUnreadableError(String(parseError)),
          );
        }
      },
    );
  });
}
