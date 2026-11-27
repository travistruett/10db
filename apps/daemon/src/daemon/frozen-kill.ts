import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * The marker the app's shell writes beside `daemon.lock` just before it kills a daemon that stopped
 * answering /health, or that never finished starting. The name and shape match `FROZEN_KILL_FILE` in
 * `apps/desktop/src-tauri/src/supervisor.rs`.
 */
export const FROZEN_KILL_FILE = 'daemon.frozen-kill';

const FrozenKill = z.object({
  /** The daemon the shell killed. */
  pid: z.number().int().positive(),
  /** When, in Unix milliseconds. */
  at: z.number().int(),
  /** How long it had been silent on /health, or starting, when it was killed. */
  frozenAfterMs: z.number().int().positive(),
});
export type FrozenKill = z.infer<typeof FrozenKill>;

/**
 * The shell's freeze-kill marker, read once and removed, so it speaks only for the restart right after
 * the kill. A missing or malformed marker is null: the restart counts as a crash.
 */
export function takeFrozenKill(dataDir: string): FrozenKill | null {
  const path = join(dataDir, FROZEN_KILL_FILE);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  rmSync(path, { force: true });
  try {
    // The file comes from another process: a boundary, so parse it.
    const parsed = FrozenKill.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
