import type { GateResult } from './gate-runner';

/** A gate that prints `10db-hold: <what to do>` and fails says its environment, not its code, is the cause. */
const HOLD_MARKER = /^\s*10db-hold:\s*(\S.*)$/m;
/** Ampsio's own gate says this when its dev stack lags the checkout and `make watch` is not running. */
const START_WATCH = /^.*\bstart `?make watch`?.*$/im;

/** A precondition fails at once; a failure that took longer ran real work, so it is a real failure. */
export const HOLD_MAX_DURATION_MS = 30_000;
/** Only the gate's own closing lines count, never output a test or a tool echoed earlier. */
const FINAL_LINES = 3;
const MAX_REASON = 200;

/**
 * Why a failed gate should be held, not failed: the line it printed saying the environment must be
 * brought up first, or null for any other failure. A pass, a timeout and a stop are never held.
 */
export function gateHoldReason(result: GateResult): string | null {
  if (result.exitCode === 0 || result.timedOut || result.aborted) return null;
  if (result.durationMs >= HOLD_MAX_DURATION_MS) return null;
  const tail = result.tail
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-FINAL_LINES)
    .join('\n');
  const marked = HOLD_MARKER.exec(tail)?.[1];
  if (marked !== undefined) return marked.trim().slice(0, MAX_REASON);
  const line = START_WATCH.exec(tail)?.[0];
  return line === undefined ? null : line.trim().slice(0, MAX_REASON);
}
