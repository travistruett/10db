import { z } from 'zod';
import { BatchDto } from './batches';
import { NextActionKind, Title } from './entities';
import {
  BatchId,
  InboxItemId,
  PassId,
  PassTurnId,
  ProjectId,
  SessionId,
  TaskId,
  TaskMessageId,
  WorkstreamId,
} from './ids';
import { WorkstreamState } from './states';
import { TASK_MESSAGE_MAX_CHARS } from './task-thread';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §5, §11. A pass is the
// builder working through pages with the agents, live in Your folder, on a branch of its own.

const Timestamp = z.iso.datetime();

/**
 * Where a pass is. `CLOSED` means shipped and fast-forwarded; `SETTLED` means its work is in the base
 * or the builder moved the branch; a `local` project's pass goes straight to `SETTLED`.
 */
export const PassState = {
  Open: 'OPEN',
  Closing: 'CLOSING',
  Closed: 'CLOSED',
  Settled: 'SETTLED',
  Abandoning: 'ABANDONING',
  Abandoned: 'ABANDONED',
} as const;
export type PassState = (typeof PassState)[keyof typeof PassState];

/** A project has at most one pass in these states; the database's partial unique index lists the same three. */
export const OPEN_PASS_STATES: readonly PassState[] = [
  PassState.Open,
  PassState.Closing,
  PassState.Abandoning,
];

/**
 * Whether a pass still holds its tasks as pass tasks: while it is open, closing or abandoning. Its
 * close signs off or takes out every task before the pass is closed, and its Abandon takes out every
 * unsigned one, so a closed, settled or abandoned pass holds none: a task of one is ordinary work
 * again, whatever its `pass_id` still says.
 */
export function passHoldsTasks(state: PassState): boolean {
  return OPEN_PASS_STATES.includes(state);
}

/**
 * Whether a pass still holds Your folder (W9): until its work is in the base or it is abandoned, an
 * ordinary task that would run in the folder runs in a separate copy or waits.
 */
export function passHoldsFolder(state: PassState): boolean {
  return state !== PassState.Settled && state !== PassState.Abandoned;
}

/** How many pages a pass holds, and so how many of its lanes run, unless the builder says otherwise (W11). */
export const PASS_PAGE_CAP_DEFAULT = 4;
export const PASS_PAGE_CAP_MAX = 6;
export const PassPageCap = z.int().min(1).max(PASS_PAGE_CAP_MAX);

/** The line an ordinary task in Your folder shows while a pass holds the folder. */
export const PASS_FOLDER_WAIT_NOTICE_KEY = 'workbench-pass';
export const PASS_FOLDER_WAIT_LINE = 'Waits for the Workbench pass to close';

export const PassDto = z.object({
  id: PassId,
  projectId: ProjectId,
  name: z.string(),
  state: z.enum(PassState),
  /** The pass's one batch; it carries the branch, the base commit and the pull request. */
  batchId: BatchId,
  pageCap: PassPageCap,
  /** The branch HEAD named when the pass opened, where its close returns the folder. */
  returnBranch: z.string(),
  /** The commit HEAD was at when the pass opened; its branch starts here. */
  startSha: z.string(),
  openedAt: Timestamp,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type PassDto = z.infer<typeof PassDto>;

/**
 * One path of the folder that differed from the pass's start when it opened, with the hash of its
 * content on disk; `blob` is null for a file deleted from the folder.
 */
export const PassDirtEntry = z.object({
  path: z.string().min(1),
  blob: z
    .string()
    .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/)
    .nullable(),
});
export type PassDirtEntry = z.infer<typeof PassDirtEntry>;

/** A git object name: what a kept commit, a pass's start or a branch tip is. */
const Sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

/** How a turn ended: Ready for the builder, stopped by the builder, or unable to go on. */
export const PassTurnEnding = { Ready: 'ready', Stopped: 'stopped', Failed: 'failed' } as const;
export type PassTurnEnding = (typeof PassTurnEnding)[keyof typeof PassTurnEnding];

/** What the turn's advice check found (spec §8.1); `none` until one has run. */
export const PassTurnCheck = { None: 'none', Passed: 'passed', Failed: 'failed' } as const;
export type PassTurnCheck = (typeof PassTurnCheck)[keyof typeof PassTurnCheck];

/**
 * One turn of a pass task (spec §6.2, §11): from the builder message that started it to the end of the
 * agent's work on it. `endedAt` and `ending` are written together; `settledAt` once the turn's end has
 * been carried through, so a restart between the two finishes it by `ending`.
 */
export const PassTurnDto = z.object({
  id: PassTurnId,
  taskId: TaskId,
  workstreamId: WorkstreamId,
  sessionId: SessionId.nullable(),
  /** The task's turn number, from 1. */
  seq: z.int().min(1),
  /** The builder message the turn started from; null for a turn no message started. */
  messageId: TaskMessageId.nullable(),
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
  ending: z.enum(PassTurnEnding).nullable(),
  settledAt: Timestamp.nullable(),
  /** The task's kept commit after this turn; null while the task has never changed a page file. */
  keptSha: Sha.nullable(),
  /** The pass branch tip the turn's work was compared with; null until the work is kept. */
  keptBaseSha: Sha.nullable(),
  /** The highest shared-change number granted in the pass when the turn ended; null with none. */
  sharedSeq: z.int().min(0).nullable(),
  check: z.enum(PassTurnCheck),
  readyAt: Timestamp.nullable(),
  /** When the builder first opened the Ready page. */
  openedAt: Timestamp.nullable(),
  /** When the builder first wrote after the page was Ready. */
  answeredAt: Timestamp.nullable(),
});
export type PassTurnDto = z.infer<typeof PassTurnDto>;

/** A file a turn or a page changed, with its lines added and removed. */
export const PassFileChange = z.object({
  path: z.string().min(1),
  added: z.int().min(0),
  removed: z.int().min(0),
});
export type PassFileChange = z.infer<typeof PassFileChange>;

/**
 * The detail of a Ready page's `check` item: the pass it belongs to (the Inbox folds a pass's items on
 * `passId`), the turn, and that turn's kept commit with the files it changed and the page's files
 * against the pass's branch.
 */
export const PassCheckDetail = z.object({
  passId: PassId,
  taskId: TaskId,
  workstreamId: WorkstreamId,
  turnId: PassTurnId,
  keptSha: Sha.nullable(),
  keptBaseSha: Sha,
  turnFiles: z.array(PassFileChange),
  pageFiles: z.array(PassFileChange),
});
export type PassCheckDetail = z.infer<typeof PassCheckDetail>;

/** The one option of a Ready page's `check` item. */
export const PASS_SIGN_OFF_CHOICE = 'sign_off';
/** The one option of a failed turn's `flag`: the builder's last message goes to the agent again. */
export const PASS_RETRY_TURN_CHOICE = 'retry_turn';

/** What a take-out or an Abandon does with a shared change of the page that has not landed (spec §7.2). */
export const SharedChoiceKind = { Keep: 'keep', Drop: 'drop' } as const;
export type SharedChoiceKind = (typeof SharedChoiceKind)[keyof typeof SharedChoiceKind];
export const SharedChoice = z.object({
  /** The shared change's number in the pass's chain. */
  seq: z.int().min(0),
  choice: z.enum(SharedChoiceKind),
});
export type SharedChoice = z.infer<typeof SharedChoice>;

/**
 * The last step of a take-out that finished (spec §5.4), as its `pass_take_outs` row records it, so a
 * restart goes on from the next. `Written` means none has.
 */
export const TakeOutStep = {
  Written: -1,
  Stopped: 0,
  HandEditsFolded: 1,
  Kept: 2,
  Checked: 3,
  PutBack: 4,
  Done: 5,
} as const;
export type TakeOutStep = (typeof TakeOutStep)[keyof typeof TakeOutStep];

/** The last step of a pass's Abandon that finished (spec §5.4), as `passes.abandon_step` records it. */
export const AbandonStep = {
  Abandoning: 1,
  ShipAborted: 2,
  SessionsStopped: 3,
  SharedDropped: 4,
  PagesTakenOut: 5,
  SignedOffKept: 6,
  Abandoned: 7,
  IndexRefreshed: 8,
} as const;
export type AbandonStep = (typeof AbandonStep)[keyof typeof AbandonStep];

/** Where a page is in its sign-off; the slice that lands sign-off adds its states. */
export const PassSignOff = { None: 'none' } as const;
export type PassSignOff = (typeof PassSignOff)[keyof typeof PassSignOff];

/** One page of a pass as the Workbench's queue shows it. */
export const PassPageDto = z.object({
  taskId: TaskId,
  title: z.string(),
  /** The page area the task works on. */
  area: z.string(),
  /** The page's path in the app, or null when its area names none. */
  route: z.string().nullable(),
  /** The task's run, its state and its next action; null before it has one. */
  workstreamId: WorkstreamId.nullable(),
  state: z.enum(WorkstreamState).nullable(),
  nextActionKind: NextActionKind.nullable(),
  /** Whether the builder has written to the page since the pass opened. */
  spokenTo: z.boolean(),
  /** The task's latest turn in the pass, or null before its first. */
  turn: z
    .object({
      id: PassTurnId,
      seq: z.int().min(1),
      startedAt: Timestamp,
      endedAt: Timestamp.nullable(),
      readyAt: Timestamp.nullable(),
      /** What the agent is doing now; filled by the slice that streams it. */
      activity: z.null(),
    })
    .nullable(),
  /** When a usage pause ends, while the run is paused for one. */
  pausedUntil: Timestamp.nullable(),
  /** The failed turn's flag, whose Retry Turn sends the last message again; null unless the turn failed. */
  failure: z
    .object({
      failureKind: z.string().nullable(),
      retryItemId: InboxItemId,
    })
    .nullable(),
  signOff: z.enum(PassSignOff),
});
export type PassPageDto = z.infer<typeof PassPageDto>;

/** When one turn of the pass started, ended, was Ready, opened and answered: what its timing reads. */
export const PassTurnTimingDto = z.object({
  taskId: TaskId,
  seq: z.int().min(1),
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
  readyAt: Timestamp.nullable(),
  openedAt: Timestamp.nullable(),
  answeredAt: Timestamp.nullable(),
});
export type PassTurnTimingDto = z.infer<typeof PassTurnTimingDto>;

/** `GET /passes/:passId`: the pass, a row per page it holds, and every turn of the pass. */
export const PassViewDto = z.object({
  pass: PassDto,
  pages: z.array(PassPageDto),
  turns: z.array(PassTurnTimingDto),
});
export type PassViewDto = z.infer<typeof PassViewDto>;

/** `POST /projects/:projectId/passes`. */
export const PassOpenRequest = z.object({
  name: Title,
  taskIds: z.array(TaskId).min(1).max(PASS_PAGE_CAP_MAX),
  pageCap: PassPageCap.optional(),
  /** Sent to every page as its first message; without it a task with a description starts from that. */
  firstMessage: z.string().min(1).max(TASK_MESSAGE_MAX_CHARS).optional(),
});
export type PassOpenRequest = z.infer<typeof PassOpenRequest>;

/** A task whose page another task held when the pass opened: it waits for it. */
export const PassPageWaitDto = z.object({ taskId: TaskId, area: z.string(), heldBy: TaskId });
export type PassPageWaitDto = z.infer<typeof PassPageWaitDto>;

/** What opening a pass made. */
export const PassOpenedDto = z.object({
  pass: PassDto,
  batch: BatchDto,
  /** The folder's dirt when it opened, which stays as it was. */
  dirt: z.array(PassDirtEntry),
  /** The commits HEAD had that the project's base lacks; null with no base to compare with. */
  aheadOfBase: z.int().min(0).nullable(),
  waiting: z.array(PassPageWaitDto),
});
export type PassOpenedDto = z.infer<typeof PassOpenedDto>;

/** What a take-out did (spec §5.4). */
export const TakeOutResultDto = z.object({
  taskId: TaskId,
  passId: PassId,
  /**
   * False when a take-out asked for alone stopped because the page's files kept changing: the task
   * stays in the pass, and `stillChanging` names the files.
   */
  tookOut: z.boolean(),
  /** The task's kept commit, now at its kept ref; null when it never changed a page file. */
  keptSha: Sha.nullable(),
  stillChanging: z.array(z.string()),
  /** The files the put-back left as they are, because they changed after they were checked. */
  left: z.array(z.string()),
});
export type TakeOutResultDto = z.infer<typeof TakeOutResultDto>;

/** What a pass's Abandon did (spec §5.4). */
export const PassAbandonedDto = z.object({
  /** The unsigned pages put back to their state before the pass; their work is kept with their tasks. */
  reverted: z.array(TaskId),
  /** The signed-off pages, which stay as landed. */
  stays: z.array(TaskId),
  /** Files left as they are because they kept changing, each with its page. */
  left: z.array(z.object({ path: z.string(), page: z.string() })),
  /** The branch the folder is on now, and whether it is the branch the pass returned to. */
  folder: z.object({ branch: z.string(), returned: z.boolean() }),
  /** Shared changes that had not landed and were dropped, newest first. */
  droppedShared: z.array(z.object({ seq: z.int().min(0), paths: z.array(z.string()) })),
  /** The pass's pull request, which stays open and is no longer watched; null when it had none. */
  pullRequestLeftOpen: z.string().nullable(),
});
export type PassAbandonedDto = z.infer<typeof PassAbandonedDto>;
