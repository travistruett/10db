import {
  ConflictError,
  SessionActivityData,
  type PassFileChange,
  type PassId,
  type PassTurnDto,
  type PassTurnId,
  type PassTurnWithFilesDto,
  type TaskId,
  type TurnActivityDto,
} from '@10db/contracts';
import {
  getBatch,
  getPassTurn,
  getProject,
  getTask,
  listTaskTurns,
  getWorkstreamRow,
  listTurnActivity,
  markPassTurnOpened,
  type DbReader,
} from '@10db/db';
import type { StateStore } from '../events';
import { GitError, type Git } from '../git';
import { pageMatcher } from './kept-work';

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
 * before it in the same run (its pass), or the pass branch tip it was kept on: only the task's page
 * files (`pageMatcher`), since each kept commit is the branch tip of its time with the page laid over
 * it, and another page or a shared change can land on the branch between two turns. A turn that kept
 * nothing new, or whose commit git no longer has, lists none. Reads only.
 */
export async function taskTurns(
  deps: PassTurnsDeps,
  taskId: TaskId,
): Promise<PassTurnWithFilesDto[]> {
  const task = getTask(deps.db, taskId);
  const project = getProject(deps.db, task.projectId);
  const turns = listTaskTurns(deps.db, taskId);
  const matchers = new Map<PassId, (path: string) => boolean>();
  const pageFileOf = (passId: PassId) => {
    const known = matchers.get(passId);
    if (known) return known;
    const mine = pageMatcher(deps.db, project, task, passId);
    matchers.set(passId, mine);
    return mine;
  };
  const listed: PassTurnWithFilesDto[] = [];
  for (const turn of turns) {
    const from = comparedWith(turns, turn);
    const passId = passOfRun(deps.db, turn);
    const files =
      turn.keptSha === null || from === null || from === turn.keptSha || passId === null
        ? []
        : (await deps.files(project.repoPath, from, turn.keptSha)).filter((f) =>
            pageFileOf(passId)(f.path),
          );
    listed.push({ ...turn, files });
  }
  return listed;
}

/** The pass a turn's run belongs to: a pass task runs only in its pass's batch. */
function passOfRun(db: DbReader, turn: PassTurnDto): PassId | null {
  const { batchId } = getWorkstreamRow(db, turn.workstreamId);
  return batchId === null ? null : (getBatch(db, batchId).passId ?? null);
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
