import type { GateResult } from './gate-runner';

/** A gate that prints `10db-hold: <what to do>` and fails says its environment, not its code, is the cause. */
const HOLD_MARKER = /^\s*10db-hold:\s*(\S.*)$/m;
/** Ampsio's own gate says this when its dev stack lags the checkout and `make watch` is not running. */
const START_WATCH = /^.*\bstart `?make watch`?.*$/im;

/**
 * Why a failed gate should be held, not failed: the line it printed saying the environment must be
 * brought up first, or null for any other failure. A pass, a timeout and a stop are never held.
 */
export function gateHoldReason(result: GateResult): string | null {
  if (result.exitCode === 0 || result.timedOut || result.aborted) return null;
  const marked = HOLD_MARKER.exec(result.tail)?.[1];
  if (marked !== undefined) return marked.trim();
  const line = START_WATCH.exec(result.tail)?.[0];
  return line === undefined ? null : line.trim();
}
