import { NotFoundError, WorkstreamState, type TaskId } from '@10db/contracts';
import {
  activeClaims,
  getProject,
  getTask,
  getWorkstreamRow,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import { fileDefect } from '../defects';
import { flagCard } from '../inbox';
import { stallOutOfMovesCard, StallOutOfMovesReason, type StallOutOfMovesParts } from './card';
import { markDefect, readRestart, type StallRestart } from './restart-record';
import { STALL_STOP_DEADLINE_MS, StallFault } from './restart-rule';
import type { Stall } from './rules';

const ACTIVE_STATES: ReadonlySet<string> = new Set([
  WorkstreamState.Starting,
  WorkstreamState.Running,
  WorkstreamState.Verifying,
]);

/** What a defect task says of each fault: its title and what 10db's part did. */
const DEFECT_WORDS: Readonly<Record<StallFault, { title: string; what: string }>> = {
  [StallFault.NoLane]: {
    title: 'A run stalled with no lane to run in',
    what: 'The run was recorded as running, but no lane was running it.',
  },
  [StallFault.GatePastLimit]: {
    title: "A run's gate ran past its limit",
    what: "The run's gate was still running after the limit 10db gives it, and the run showed no activity.",
  },
  [StallFault.NeverStarted]: {
    title: 'A run never started its session',
    what: 'The run stayed in Starting and its session wrote nothing.',
  },
  [StallFault.StopHung]: {
    title: `A run's stop did not finish in ${String(STALL_STOP_DEADLINE_MS / 60_000)} minutes`,
    what: "10db stopped the run's session to restart it, and the stop did not finish in time.",
  },
};

/** What a stalled run's Out of Moves card says, read from the database. */
export interface StallOutOfMovesPlan {
  /** `defect` is null while the defect is still to be filed. */
  readonly parts: StallOutOfMovesParts;
  readonly needsFiling: boolean;
  readonly state: WorkstreamState;
}

interface StallOutOfMovesInput {
  readonly stall: Stall;
  readonly fault: StallFault | null;
  /** `stallMove` found 10db's own part at fault. */
  readonly fileDefect: boolean;
  /** The run has a live lane. */
  readonly lane: boolean;
}

function reasonOf(record: StallRestart | null): StallOutOfMovesReason {
  if (record !== null && record.stopHungAt !== null) return StallOutOfMovesReason.StopHung;
  if (record !== null && record.restartedAt !== null) return StallOutOfMovesReason.Again;
  return StallOutOfMovesReason.NoAttempts;
}

/** What the run holds, as text fixed when the card is raised: its lane, its claims and a gate slot. */
function holdsOf(
  db: DbReader,
  input: { readonly stall: Stall; readonly lane: boolean; readonly gate: boolean },
): string {
  const held: string[] = [];
  if (input.lane) held.push('its lane');
  const id = input.stall.workstreamId;
  const claims =
    id === null ? [] : [...new Set(activeClaims(db, id).map((claim) => claim.name))].sort();
  if (claims.length > 0) held.push(`its claims (${claims.join(', ')})`);
  if (input.gate) held.push('a gate slot');
  const last = held.pop();
  if (last === undefined) return 'It holds nothing.';
  return `It holds ${held.length === 0 ? last : `${held.join(', ')} and ${last}`}.`;
}

function titleOf(db: DbReader, taskId: TaskId | null): string | null {
  if (taskId === null) return null;
  try {
    return getTask(db, taskId).title;
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

/**
 * What the card says now, or null when the run is no longer active. A defect still to be filed reads as
 * not filed, which is also what the card says when the filing finds no project or a task already open.
 */
export function planStallOutOfMoves(
  db: DbReader,
  input: StallOutOfMovesInput,
): StallOutOfMovesPlan | null {
  const id = input.stall.workstreamId;
  if (id === null) return null;
  const row = getWorkstreamRow(db, id);
  if (!ACTIVE_STATES.has(row.state)) return null;
  const record = readRestart(db, id);
  const filed = record?.defectTaskId ?? null;
  return {
    parts: {
      reason: reasonOf(record),
      fault: input.fileDefect ? input.fault : null,
      defect: titleOf(db, filed),
      holds: holdsOf(db, { stall: input.stall, lane: input.lane, gate: row.gatePid !== null }),
    },
    needsFiling: input.fileDefect && input.fault !== null && filed === null,
    state: row.state,
  };
}

/** The defect task for a fault, filed in 10db's project. Null when none could be filed. */
function fileFaultDefect(
  w: WriteContext,
  stall: Stall,
  fault: StallFault,
  state: WorkstreamState,
): TaskId | null {
  const words = DEFECT_WORDS[fault];
  const record = stall.workstreamId === null ? null : readRestart(w.tx, stall.workstreamId);
  return fileDefect(w, {
    signature: `stall:${fault}:${state.toLowerCase()}`,
    title: words.title,
    description: [
      `Project: ${getProject(w.tx, stall.projectId).name}`,
      `Task: ${stall.title}`,
      `State: ${state}`,
      `No activity since: ${stall.since}`,
      `Restarted at: ${record?.restartedAt ?? 'not restarted'}`,
      `Stop hung at: ${record?.stopHungAt ?? 'did not hang'}`,
      `Fault: ${fault}`,
      '',
      words.what,
    ].join('\n'),
  });
}

/**
 * Raises the stall's Out of Moves card in the caller's write, filing the 10db defect first when 10db's
 * own part stalled. The card is raised whatever the filing answers: it names the defect task, or says
 * the report could not be filed. A run no longer active gets none.
 */
export function raiseStallOutOfMoves(w: WriteContext, input: StallOutOfMovesInput): void {
  const plan = planStallOutOfMoves(w.tx, input);
  const id = input.stall.workstreamId;
  if (plan === null || id === null) return;
  let parts = plan.parts;
  if (plan.needsFiling && input.fault !== null) {
    const taskId = fileFaultDefect(w, input.stall, input.fault, plan.state);
    if (taskId !== null) {
      markDefect(w, { id, state: plan.state, taskId });
      parts = { ...parts, defect: DEFECT_WORDS[input.fault].title };
    }
  }
  flagCard(w, stallOutOfMovesCard(input.stall, parts));
}
