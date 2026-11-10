import {
  AreaRole,
  InboxKind,
  InboxState,
  passHeldAreas,
  PassSignOff,
  SessionActivityData,
  TaskMessageAuthor,
  WorkstreamState,
  type AreaDef,
  type PassDto,
  type PassId,
  type PassPageDto,
  type PassTurnActivity,
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
  latestTurnActivity,
  listPassTasks,
  listPassTurns,
  listSharedChanges,
  listSignOffWaits,
  listTaskThreadRows,
  openHolds,
  type DbReader,
} from '@10db/db';
import { signingOff } from './sign-off';

// Workbench spec §4.3, §4.5, §6.1: what the Workbench reads of a pass, built from its rows alone.

/** The page area a task works on: its first page, else the first area the pass holds for it. */
function pageOf(areas: readonly AreaDef[], task: TaskDto): AreaDef | undefined {
  const named = (name: string | undefined) => areas.find((a) => a.name === name);
  const page = task.areas.find((name) => named(name)?.role === AreaRole.Page);
  return named(page ?? passHeldAreas(areas, task)[0]);
}

/**
 * What a working turn is doing now: its newest activity row's tool and target, and the files the turn
 * has written so far; null once the turn has ended, or before it reported anything.
 */
function activityOf(db: DbReader, turn: PassTurnDto): PassTurnActivity | null {
  if (turn.endedAt !== null) return null;
  const latest = latestTurnActivity(db, turn);
  // A row the daemon wrote, read from disk: parsed before it is trusted.
  const parsed = SessionActivityData.safeParse(latest?.data);
  if (latest === undefined || !parsed.success) return null;
  return {
    tool: parsed.data.tool?.name ?? null,
    target: parsed.data.tool?.target ?? null,
    filesTouched: parsed.data.turn?.filesTouched ?? [],
    at: latest.at,
  };
}

/** The failed turn's flag the run waits on, whose Retry Turn sends the last message again; else null. */
function failureOf(db: DbReader, run: WorkstreamDto | null): PassPageDto['failure'] {
  if (run?.nextAction.kind !== 'pass_review') return null;
  const item = getInboxItem(db, run.nextAction.inboxId);
  if (item.kind !== InboxKind.Flag || item.state !== InboxState.Open) return null;
  return { failureKind: run.failureKind, retryItemId: item.id };
}

/**
 * Where the page is in its sign-off, as its rows say: waiting on another page's hold, signing off while
 * its Ready item is closed by its Sign Off, or done once its run is.
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
  if (run !== null && signingOff(db, run.id))
    return { signOff: PassSignOff.SigningOff, waitsFor: null };
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
            activity: activityOf(db, turn),
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
