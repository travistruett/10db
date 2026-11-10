import {
  AreaRole,
  InboxKind,
  InboxState,
  passHeldAreas,
  PassSignOff,
  TaskMessageAuthor,
  WorkstreamState,
  type AreaDef,
  type PassDto,
  type PassId,
  type PassPageDto,
  type PassSignOffWaitDto,
  type PassTurnDto,
  type PassViewDto,
  type TaskDto,
  type WorkstreamDto,
} from '@10db/contracts';
import {
  getInboxItem,
  getPass,
  getPassChecks,
  getPassProgress,
  getPassPullRequest,
  getProject,
  getTask,
  getWorkstream,
  listPassTasks,
  listPassTurns,
  listSharedChanges,
  listSignOffWaits,
  listTaskThreadRows,
  openHolds,
  type DbReader,
} from '@10db/db';

// Workbench spec §4.3, §4.5, §6.1: what the Workbench reads of a pass, built from its rows alone.

/** The page area a task works on: its first page, else the first area the pass holds for it. */
function pageOf(areas: readonly AreaDef[], task: TaskDto): AreaDef | undefined {
  const named = (name: string | undefined) => areas.find((a) => a.name === name);
  const page = task.areas.find((name) => named(name)?.role === AreaRole.Page);
  return named(page ?? passHeldAreas(areas, task)[0]);
}

/** The failed turn's flag the run waits on, whose Retry Turn sends the last message again; else null. */
function failureOf(db: DbReader, run: WorkstreamDto | null): PassPageDto['failure'] {
  if (run?.nextAction.kind !== 'pass_review') return null;
  const item = getInboxItem(db, run.nextAction.inboxId);
  if (item.kind !== InboxKind.Flag || item.state !== InboxState.Open) return null;
  return { failureKind: run.failureKind, retryItemId: item.id };
}

/**
 * Where the page is in its sign-off, as its rows say: waiting on another page's hold, or done once its
 * run is. A sign-off landing now is a job's, not a row's, so the view never reads it as such.
 */
function signOffOf(
  db: DbReader,
  run: WorkstreamDto | null,
  wait: PassSignOffWaitDto | undefined,
): Pick<PassPageDto, 'signOff' | 'waitsFor'> {
  if (wait !== undefined)
    return {
      signOff: PassSignOff.Waiting,
      waitsFor: { taskId: wait.waitsForTaskId, title: getTask(db, wait.waitsForTaskId).title },
    };
  return {
    signOff: run?.state === WorkstreamState.Done ? PassSignOff.Done : PassSignOff.None,
    waitsFor: null,
  };
}

function pageView(
  db: DbReader,
  pass: PassDto,
  areas: readonly AreaDef[],
  turns: readonly PassTurnDto[],
  waits: readonly PassSignOffWaitDto[],
  task: TaskDto,
): PassPageDto {
  const area = pageOf(areas, task);
  const run = task.workstreamId === null ? null : getWorkstream(db, task.workstreamId);
  const turn = turns.filter((t) => t.taskId === task.id).at(-1);
  const spokenTo = listTaskThreadRows(db, task.id).some(
    (m) => m.author === TaskMessageAuthor.Builder && m.createdAt >= pass.openedAt,
  );
  return {
    taskId: task.id,
    title: task.title,
    area: area?.name ?? task.areas[0] ?? '',
    route: area?.route ?? null,
    workstreamId: run?.id ?? null,
    state: run?.state ?? null,
    nextActionKind: run?.nextAction.kind ?? null,
    spokenTo,
    turn:
      turn === undefined
        ? null
        : {
            id: turn.id,
            seq: turn.seq,
            startedAt: turn.startedAt,
            endedAt: turn.endedAt,
            readyAt: turn.readyAt,
            activity: null,
          },
    pausedUntil: run?.state === WorkstreamState.PausedLimit ? run.pausedUntil : null,
    failure: failureOf(db, run),
    ...signOffOf(
      db,
      run,
      waits.find((w) => w.taskId === task.id),
    ),
  };
}

/**
 * The pass, a page for each task in it now with its latest turn in this pass, the timing of every turn
 * of the pass, a task taken out of it included, and what its close reads. Reads only.
 */
export function passView(db: DbReader, passId: PassId): PassViewDto {
  const pass = getPass(db, passId);
  const { areas } = getProject(db, pass.projectId);
  const turns = listPassTurns(db, passId);
  const waits = listSignOffWaits(db, passId);
  const progress = getPassProgress(db, passId);
  return {
    pass,
    pages: listPassTasks(db, passId).map((task) => pageView(db, pass, areas, turns, waits, task)),
    turns: turns.map((t) => ({
      taskId: t.taskId,
      seq: t.seq,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      readyAt: t.readyAt,
      openedAt: t.openedAt,
      answeredAt: t.answeredAt,
    })),
    holds: openHolds(db, passId),
    sharedChanges: listSharedChanges(db, passId),
    signOffWaits: waits,
    pullRequest: getPassPullRequest(db, passId),
    checks: getPassChecks(db, passId),
    closeStep: progress.closeStep,
    stackedOn: progress.stackedOn,
    notices: [...progress.notices],
  };
}
