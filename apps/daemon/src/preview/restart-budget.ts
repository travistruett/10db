// Decision 2026-11-11-10db-runs-the-preview-while-a-pass-is-open: a preview that exits while it is
// wanted is started again, but a command that keeps dying is left stopped rather than spun.

/** How far back exits count against a preview. */
export const RESTART_WINDOW_MS = 10 * 60_000;
/** How many exits in the window are started again. */
export const RESTARTS_IN_WINDOW = 3;

/** Whether a preview whose exits (epoch ms, the latest included) are these is started again. */
export function restartsLeft(exits: readonly number[], now: number): boolean {
  return exits.filter((at) => now - at <= RESTART_WINDOW_MS).length <= RESTARTS_IN_WINDOW;
}
