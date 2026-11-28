import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { z } from 'zod';
import { equalOrUnder } from '../git';

const execFileAsync = promisify(execFile);

/** How long `lsof` may take to list every process's working directory. */
const LSOF_TIMEOUT_MS = 30_000;

/** The most output read from `lsof`: one short block per process. */
const LSOF_MAX_BYTES = 32 * 1024 * 1024;

/**
 * One line of `lsof -F`: a field letter and its value. A process set opens with `p<pid>`, then `f` names
 * the descriptor (`cwd`) and `n` its path.
 */
const LsofLine = z.union([
  z.object({ field: z.literal('p'), value: z.string().regex(/^\d+$/) }),
  z.object({ field: z.literal('f'), value: z.string() }),
  z.object({ field: z.literal('n'), value: z.string() }),
]);

/** Splits `lsof -Fn` output into lines; null when one is not a field line this reads. */
function parseLines(out: string): z.infer<typeof LsofLine>[] | null {
  const lines: z.infer<typeof LsofLine>[] = [];
  for (const raw of out.split('\n')) {
    if (raw === '') continue;
    const parsed = LsofLine.safeParse({ field: raw.slice(0, 1), value: raw.slice(1) });
    if (!parsed.success) return null;
    lines.push(parsed.data);
  }
  return lines;
}

/**
 * How many processes have `path` or a directory under it as their working directory, read from
 * `lsof -a -d cwd -Fn`. `lsof` exits 1 when nothing matches, so exit 0 or 1 is read, and 1 with no output
 * is no process. Null when `lsof` can't be started, exits with another code, times out or prints
 * a line that can't be read: the answer is unknown, and a caller treats unknown as in use.
 */
export async function processesIn(path: string): Promise<number | null> {
  let root: string;
  try {
    root = realpathSync(path);
  } catch {
    return null;
  }
  let out: string;
  try {
    out = (
      await execFileAsync('lsof', ['-a', '-d', 'cwd', '-Fn'], {
        timeout: LSOF_TIMEOUT_MS,
        maxBuffer: LSOF_MAX_BYTES,
        encoding: 'utf8',
      })
    ).stdout;
  } catch (error) {
    // The exit code and output of a child process are not typed: read them as a boundary.
    const exited = z.object({ code: z.literal(1), stdout: z.string() }).safeParse(error);
    if (!exited.success) return null;
    out = exited.data.stdout;
  }
  const lines = parseLines(out);
  if (lines === null) return null;
  const inside = new Set<string>();
  let pid: string | null = null;
  for (const { field, value } of lines) {
    if (field === 'p') pid = value;
    else if (field === 'n' && pid !== null && equalOrUnder(value, root)) inside.add(pid);
  }
  return inside.size;
}
