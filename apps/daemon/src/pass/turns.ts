import {
  ConflictError,
  SessionActivityData,
  type PassFileChange,
  type PassTurnDto,
  type PassTurnId,
  type PassTurnWithFilesDto,
  type TaskId,
  type TurnActivityDto,
} from '@10db/contracts';
import {
  getPassTurn,
  getProject,
  getTask,
  listTaskTurns,
  listTurnActivity,
  markPassTurnOpened,
  type DbReader,
} from '@10db/db';
import type { StateStore } from '../events';
import { GitError, type Git } from '../git';

// Workbench spec §4.3, §11: a page's turns with the files each changed, a turn's log (Show Log), and
// when the builder first opened a Ready page, which the pass's timing reads.

/** The files `to` changed against `from`, kept by the pair: commits never change, so neither does it. */
export type TurnFiles = (repo: string, from: string, to: string) => Promise<PassFileChange[]>;

/** A `TurnFiles` over `git` that reads each pair of commits once; a pair git can't read changes nothing. */
export function createTurnFiles(git: Git): TurnFiles {
  const read = new Map<string, Promise<PassFileChange[]>>();
  return (repo, from, to) => {
    const key = `${repo}\0${from}\0${to}`;
    const known = read.get(key);
    if (known) return known;
    const files = git.diffSince(repo, from, to, 0).then(
      ({ files: changed }) =>
        changed.map((f) => ({ path: f.path, added: f.added ?? 0, removed: f.removed ?? 0 })),
      (error: unknown) => {
        // A kept commit a later take-out or close let go is gone: it shows no files, and is asked again.
        read.delete(key);
        if (error instanceof GitError) return [];
        throw error;
      },
    );
    read.set(key, files);
    return files;
  };
}

export interface PassTurnsDeps {
  readonly db: DbReader;
  readonly git: Git;
  readonly files: TurnFiles;
}

/** The commit a turn's work is compared with: the run's kept commit before it, else the tip it was kept on. */
function comparedWith(turns: readonly PassTurnDto[], turn: PassTurnDto): string | null {
  const before = turns
    .filter((t) => t.workstreamId === turn.workstreamId && t.seq < turn.seq && t.keptSha !== null)
    .at(-1);
  return before?.keptSha ?? turn.keptBaseSha;
}

/**
 * The task's turns, oldest first, each with the files its kept commit changed against the kept commit
 * before it in the same run (its pass), or the pass branch tip it was kept on. A turn that kept nothing
 * new, or whose commit git no longer has, lists none. Reads only.
 */
export async function taskTurns(
  deps: PassTurnsDeps,
  taskId: TaskId,
): Promise<PassTurnWithFilesDto[]> {
  const { repoPath } = getProject(deps.db, getTask(deps.db, taskId).projectId);
  const turns = listTaskTurns(deps.db, taskId);
  const listed: PassTurnWithFilesDto[] = [];
  for (const turn of turns) {
    const from = comparedWith(turns, turn);
    const files =
      turn.keptSha === null || from === null || from === turn.keptSha
        ? []
        : await deps.files(repoPath, from, turn.keptSha);
    listed.push({ ...turn, files });
  }
  return listed;
}

/** The turn's log, oldest first: what the agent said and each tool it called. */
export function turnLog(db: DbReader, turnId: PassTurnId): TurnActivityDto[] {
  return listTurnActivity(db, getPassTurn(db, turnId)).flatMap((row) => {
    // A row the daemon wrote, read from disk: parsed before it is trusted.
    const parsed = SessionActivityData.safeParse(row.data);
    return parsed.success
      ? [{ at: row.at, kind: parsed.data.kind, summary: parsed.data.summary }]
      : [];
  });
}

/**
 * Notes that the builder opened the task's Ready page for this turn, the first time only; a turn not
 * Ready is left as it is. Refused for a turn of another task.
 */
export function openTurn(state: StateStore, taskId: TaskId, turnId: PassTurnId): void {
  state.write((ctx) => {
    const turn = getPassTurn(ctx.tx, turnId);
    if (turn.taskId !== taskId)
      throw new ConflictError(`Turn ${String(turn.seq)} is another task's`);
    markPassTurnOpened(ctx, turnId);
  });
}
