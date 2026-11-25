import { passingGateDurations, type DbReader } from '@10db/db';
import type { ProjectId } from '@10db/contracts';

/** The most a gate may be given however long its passes have taken. */
export const GATE_TIMEOUT_CAP_MS = 120 * 60_000;
/** How many of a command's latest passing runs say how long it typically takes. */
const HISTORY_RUNS = 10;

/**
 * A gate's timeout: twice the typical (median) passing duration of the same command in the project,
 * never under `floorMs` and never over `GATE_TIMEOUT_CAP_MS`. With no passing run recorded it is
 * the floor. A suite that grows past the fixed limit then gets room, and one that hangs is still stopped.
 */
export function gateTimeoutMs(passingDurationsMs: readonly number[], floorMs: number): number {
  if (passingDurationsMs.length === 0) return floorMs;
  const sorted = [...passingDurationsMs].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const typical =
    sorted.length % 2 === 1
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return Math.max(floorMs, Math.min(GATE_TIMEOUT_CAP_MS, Math.round(2 * typical)));
}

/** `gateTimeoutMs` for a project's command, from the passing runs the event log holds. */
export function gateTimeoutFor(
  db: DbReader,
  projectId: ProjectId,
  command: string,
  floorMs: number,
): number {
  return gateTimeoutMs(passingGateDurations(db, projectId, command, HISTORY_RUNS), floorMs);
}
