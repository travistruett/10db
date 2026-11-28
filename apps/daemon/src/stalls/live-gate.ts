import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkstreamId } from '@10db/contracts';
import { getProject, getWorkstreamRow, type DbReader } from '@10db/db';
import { gateTimeoutFor } from '../verify';
import type { LiveGate } from './rules';

/**
 * The run's gate as it is now: set while the lane's gate process is recorded as running, with the
 * start and last write of its newest log (a rerun of failing tests writes its own log). Null when no
 * gate process runs, or its log can't be read: the run then counts by its own activity alone.
 */
export function liveGateOf(
  db: DbReader,
  id: WorkstreamId,
  deps: { readonly dataDir: string; readonly gateTimeoutFloorMs: number },
): LiveGate | null {
  const row = getWorkstreamRow(db, id);
  if (row.gatePid === null) return null;
  const command = getProject(db, row.projectId).gateCommand;
  const dir = join(deps.dataDir, 'logs', 'gate');
  let newest: { startedAt: number; lastOutputAt: number } | null = null;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(`${id}-`)) continue;
      const { birthtimeMs, mtimeMs } = statSync(join(dir, name));
      if (newest === null || mtimeMs > newest.lastOutputAt)
        newest = { startedAt: birthtimeMs, lastOutputAt: mtimeMs };
    }
  } catch {
    return null;
  }
  if (newest === null) return null;
  return {
    startedAt: new Date(newest.startedAt).toISOString(),
    lastOutputAt: new Date(newest.lastOutputAt).toISOString(),
    // The limit the runner gave the gate, from the project's gate command's history. A step's own
    // check command may have had the floor instead; the runner kills the gate at its own limit, so
    // this one only matters for a gate that outlived it.
    timeoutMs:
      command === null
        ? deps.gateTimeoutFloorMs
        : gateTimeoutFor(db, row.projectId, command, deps.gateTimeoutFloorMs),
  };
}
