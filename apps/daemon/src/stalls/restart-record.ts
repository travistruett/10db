import { isTerminal, NotFoundError, TaskId, WorkstreamId, WorkstreamState } from '@10db/contracts';
import {
  deleteAppSetting,
  getAppSetting,
  getWorkstreamRow,
  setAppSetting,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import { z } from 'zod';

/** The app setting that holds one record for each run a stall was acted on. */
export const STALL_RESTARTS_KEY = 'stall_restarts';

/** What 10db did about a run's stall, so a second stall of the same step is not restarted again. */
export const StallRestart = z.object({
  workstreamId: WorkstreamId,
  /** Null: no restart was made (the stop hung, or no attempts were left). */
  restartedAt: z.iso.datetime().nullable(),
  /** The state the run stalled in. */
  state: z.enum(WorkstreamState),
  stopHungAt: z.iso.datetime().nullable(),
  defectTaskId: TaskId.nullable(),
});
export type StallRestart = z.infer<typeof StallRestart>;

/** Unset or unreadable reads as no records. */
function readAll(db: DbReader): StallRestart[] {
  const parsed = z.array(StallRestart).safeParse(getAppSetting(db, STALL_RESTARTS_KEY));
  return parsed.success ? parsed.data : [];
}

function writeAll(w: WriteContext, records: readonly StallRestart[]): void {
  if (records.length === 0) {
    deleteAppSetting(w, STALL_RESTARTS_KEY);
    return;
  }
  setAppSetting(
    w,
    STALL_RESTARTS_KEY,
    records.map((record) => ({ ...record })),
  );
}

/** A run whose row is gone, with its deleted project, has ended too. */
function ended(db: DbReader, id: WorkstreamId): boolean {
  try {
    return isTerminal(getWorkstreamRow(db, id).state);
  } catch (error) {
    if (error instanceof NotFoundError) return true;
    throw error;
  }
}

export function readRestart(db: DbReader, id: WorkstreamId): StallRestart | null {
  return readAll(db).find((record) => record.workstreamId === id) ?? null;
}

function replace(w: WriteContext, record: StallRestart): void {
  writeAll(w, [...readAll(w.tx).filter((r) => r.workstreamId !== record.workstreamId), record]);
}

/** Replaces the run's record with a fresh one: `stopHungAt` and `defectTaskId` null. */
export function recordRestart(
  w: WriteContext,
  input: { id: WorkstreamId; state: WorkstreamState; at: string },
): void {
  replace(w, {
    workstreamId: input.id,
    restartedAt: input.at,
    state: input.state,
    stopHungAt: null,
    defectTaskId: null,
  });
}

function fresh(id: WorkstreamId, state: WorkstreamState): StallRestart {
  return { workstreamId: id, restartedAt: null, state, stopHungAt: null, defectTaskId: null };
}

/** Sets `stopHungAt`, and makes the record (`restartedAt` null) when the run has none. */
export function markHung(
  w: WriteContext,
  input: { id: WorkstreamId; state: WorkstreamState; at: string },
): void {
  const before = readAll(w.tx).find((r) => r.workstreamId === input.id);
  replace(w, { ...(before ?? fresh(input.id, input.state)), stopHungAt: input.at });
}

/** The restarted step finished: its record goes, so a later step's stall restarts once again. */
export function clearRestart(w: WriteContext, id: WorkstreamId): void {
  const records = readAll(w.tx);
  if (records.some((r) => r.workstreamId === id))
    writeAll(
      w,
      records.filter((r) => r.workstreamId !== id),
    );
}

/** Drops the records of runs that have ended. */
export function forgetEndedRestarts(w: WriteContext): void {
  const records = readAll(w.tx);
  const live = records.filter((r) => !ended(w.tx, r.workstreamId));
  if (live.length !== records.length) writeAll(w, live);
}
