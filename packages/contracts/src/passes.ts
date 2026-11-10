import { z } from 'zod';
import { BatchDto, FailingCheckDto } from './batches';
import { NextActionKind, Title } from './entities';
import {
  BatchId,
  GoalId,
  ClaimId,
  InboxItemId,
  PassId,
  PassTurnId,
  ProjectId,
  SessionId,
  TaskId,
  TaskMessageId,
  WorkstreamId,
} from './ids';
import { PassTurnActivity } from './pass-activity';
import { GitObjectName } from './git-names';
import { PassHoldDto, PassSharedChangeDto } from './pass-shared';
import { PullRequestState, WorkstreamState } from './states';
import { PageRoute } from './task-screens';
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
/** The same line once the pass has closed and waits for its pull request to merge (D22). */
export const PASS_PR_WAIT_LINE = "Waits for the Workbench pass's pull request to merge";

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

/**
 * Where a page is in its sign-off (spec §9.2): not asked, landing now, waiting for another page's hold
 * to close, or signed off and landed.
 */
export const PassSignOff = {
  None: 'none',
  SigningOff: 'signing_off',
  Waiting: 'waiting',
  Done: 'done',
} as const;
export type PassSignOff = (typeof PassSignOff)[keyof typeof PassSignOff];

/**
 * Whether the pass's preview loaded cleanly last (spec §8.2): `clean`, `broken`, or null before any
 * page load of the pass was judged.
 */
export const PassPreview = { Clean: 'clean', Broken: 'broken' } as const;
export type PassPreview = (typeof PassPreview)[keyof typeof PassPreview];

/** The preview a page broke (spec §8.2): its route, what the error overlay said, since when, and on how many turns running. */
export const PassPagePreview = z.object({
  route: PageRoute,
  /** The dev server's error overlay's text; null when the document itself failed to load. */
  overlay: z.string().nullable(),
  since: Timestamp,
  turns: z.int().min(1),
});
export type PassPagePreview = z.infer<typeof PassPagePreview>;

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
      /** What the agent is doing now, while the turn works; null before it reports a tool. */
      activity: PassTurnActivity.nullable(),
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
  /** The page whose turn a waiting sign-off waits for; null unless `signOff` is `waiting`. */
  waitsFor: z.object({ taskId: TaskId, title: z.string() }).nullable(),
  /** The preview this page's turns broke and have not mended; null when it broke none. */
  preview: PassPagePreview.nullable(),
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

/**
 * The last step of a pass's close that finished (spec §5.4), as `passes.close_step` records it, so a
 * restart goes on from the next: 1 the builder confirmed the lists; 2 the sign-offs, placements and
 * kept shared changes landed; 3 the gate in a scratch worktree; 4 the take-outs; 5 the gate in the
 * folder; 6 the push and the pull request made ready; 7 D8's fast-forward; 8 the pass closed.
 */
export const CloseStep = {
  Confirmed: 1,
  Landed: 2,
  ScratchGated: 3,
  TakenOut: 4,
  FolderGated: 5,
  Pushed: 6,
  FastForwarded: 7,
  Closed: 8,
} as const;
export type CloseStep = (typeof CloseStep)[keyof typeof CloseStep];

/** What a notice in the pass's header is about (spec §5.5, §8.3, D19, D21, D24). */
export const PassNoticeKind = {
  /** The pull request's checks fail. */
  Checks: 'checks',
  /** A review finding that names no page's files. */
  Finding: 'finding',
  /** The pass this one is stacked on closed without merging. */
  StackUnmerged: 'stack_unmerged',
  /** The pass this one is stacked on merged with drift: its commits show beside this one's. */
  StackMerged: 'stack_merged',
  /** The pass's pull request closed without merging while the pass was open. */
  PrClosed: 'pr_closed',
  /** The gate on the pushed tip failed, or could not run. */
  GateFailed: 'gate_failed',
  /**
   * Open Pull Request's push or pull request did not go through, or a close's pull request could not
   * be made ready or its follow-on opened.
   */
  PrNotOpened: 'pr_not_opened',
  /** The one review of the pull request could not run. */
  ReviewFailed: 'review_failed',
  /** The close stopped on an error, and goes on with Continue Close; nothing else has this kind. */
  Close: 'close',
  /** The changed-files check after a page's turn failed, or could not run (spec §8.1). */
  TurnCheck: 'turn_check',
  /** The preview is broken and no turn of the pass is named for it (spec §8.2). */
  Preview: 'preview',
} as const;
export type PassNoticeKind = (typeof PassNoticeKind)[keyof typeof PassNoticeKind];

/**
 * A notice in the pass's header. `sendable` offers Send to Agent, which sends `text` to the page the
 * builder picks; `cardId` names the Inbox card that acts on it, such as Retarget.
 */
export const PassNotice = z.object({
  /** A later notice with the same id replaces it. */
  id: z.string().min(1).max(200),
  kind: z.enum(PassNoticeKind),
  text: z.string().min(1),
  sendable: z.boolean(),
  cardId: InboxItemId.nullable(),
  at: Timestamp,
});
export type PassNotice = z.infer<typeof PassNotice>;

/** A sign-off that waits for another page's hold to close (spec §9.2 step 0). */
export const PassSignOffWaitDto = z.object({
  taskId: TaskId,
  passId: PassId,
  /** The hold it waits for, and the task holding it. */
  waitsFor: ClaimId,
  waitsForTaskId: TaskId,
  askedAt: Timestamp,
});
export type PassSignOffWaitDto = z.infer<typeof PassSignOffWaitDto>;

/** The pass's pull request as the daemon last made or read it. `draft` and `state` are null until read. */
export const PassPullRequestView = z.object({
  url: z.string(),
  draft: z.boolean().nullable(),
  state: z.enum(PullRequestState).nullable(),
  failingChecks: z.array(FailingCheckDto),
});
export type PassPullRequestView = z.infer<typeof PassPullRequestView>;

/** Where the pass's gate on its pushed tip is. */
export const PassGateState = {
  NotRun: 'not_run',
  Running: 'running',
  Passed: 'passed',
  Failed: 'failed',
} as const;
export type PassGateState = (typeof PassGateState)[keyof typeof PassGateState];

/** The checks of what the pass's pull request holds (spec §8.3, D21): its gate and its one review. */
export const PassChecksView = z.object({
  gate: z.object({ state: z.enum(PassGateState), logPath: z.string().nullable() }),
  /** The tip the review last read; a review of an unchanged tip is not run again. */
  review: z.object({ reviewedSha: GitObjectName.nullable() }),
});
export type PassChecksView = z.infer<typeof PassChecksView>;

/**
 * `GET /passes/:passId`: the pass, a row per page it holds, every turn of the pass, and what its close
 * reads: its open shared holds, its shared chain, its waiting sign-offs, its pull request and checks,
 * the close's last step, the pass it is stacked on and its header's notices.
 */
export const PassViewDto = z.object({
  pass: PassDto,
  pages: z.array(PassPageDto),
  /** How the pass's preview loaded last; while it is broken, a working page reads "changing". */
  preview: z.enum(PassPreview).nullable(),
  turns: z.array(PassTurnTimingDto),
  holds: z.array(PassHoldDto),
  sharedChanges: z.array(PassSharedChangeDto),
  signOffWaits: z.array(PassSignOffWaitDto),
  pullRequest: PassPullRequestView.nullable(),
  checks: PassChecksView,
  closeStep: z.enum(CloseStep).nullable(),
  stackedOn: PassId.nullable(),
  notices: z.array(PassNotice),
});
export type PassViewDto = z.infer<typeof PassViewDto>;

/**
 * `POST /projects/:projectId/passes`: open tasks to join and page areas to make a new task for, one
 * or more of them together and at most the cap.
 */
export const PassOpenRequest = z
  .object({
    name: Title,
    taskIds: z.array(TaskId).max(PASS_PAGE_CAP_MAX),
    /** Page areas each made a new task, "<Page>: UI work", in the open's write. */
    pages: z.array(z.string().min(1)).max(PASS_PAGE_CAP_MAX).optional(),
    /** The goal the new tasks join (Work on This in Factory). */
    goalId: GoalId.nullable().optional(),
    pageCap: PassPageCap.optional(),
    /** Sent to every page as its first message; without it a task with a description starts from that. */
    firstMessage: z.string().min(1).max(TASK_MESSAGE_MAX_CHARS).optional(),
  })
  .refine(
    (open) => {
      const pages = open.taskIds.length + (open.pages?.length ?? 0);
      return pages > 0 && pages <= PASS_PAGE_CAP_MAX;
    },
    { message: `A pass holds 1 to ${String(PASS_PAGE_CAP_MAX)} pages` },
  );
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
