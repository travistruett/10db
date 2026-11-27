import {
  ConflictError,
  ConversationItemAuthor,
  ConversationItemKind,
  ConversationState,
  harnessOf,
  InvalidError,
  LinearEventKind,
  LinearWithheldPattern,
  type AccountId,
  type ConversationId,
  type LinearPostDto,
  type LinearPostId,
  type LinearIssueStatuses,
  type LinearReporterSettings,
  type LinearSignInRowDto,
  type LinearSignInsDto,
  type ProjectId,
  parseItemBody,
  type ReportLinearPostInput,
  type SessionId,
  type TaskId,
  type ToolCallView,
  type UploadLinearPictureInput,
} from '@10db/contracts';
import {
  attachLinearCommentId,
  attachLinearStatusSet,
  dropPendingLinearPosts,
  failLinearPosts,
  getAccount,
  getProject,
  getTask,
  holdLinearPosts,
  insertItem,
  lastConversationSessions,
  lastItems,
  listLinearPosts,
  listItems,
  noteLinearPostError,
  pendingLinearPosts,
  recordLinearPosts,
  reopenLinearPost,
  setAppSetting,
  takeLinearPosts,
  wakeHeldLinearPosts,
  type ConversationRow,
} from '@10db/db';
import type { Clock, Timer } from '../clock';
import { BUSY, type ExploreEngine, type TurnEnd } from '../conversation';
import type { StateStore } from '../events';
import type { InboxService } from '../inbox';
import type { Logger } from '../log';
import { outboundFetch } from '../outbound';
import type { ShapeToolRequest, ShapeVerdict } from '../sessions';
import { reporterBlockedBy } from './reporter-events';
import type { PicturesOutlook } from '../pictures';
import {
  awaitsResultOf,
  beginAgentUpload,
  closeUploadStep,
  nameNextPicture,
  takeUploadResult,
  toolResultText,
  uploadedOf,
  type AgentUpload,
} from './reporter-agent-upload';
import {
  attachmentOf,
  carriesPictures,
  picturesFor,
  picturesText,
  picturesToShow,
} from './reporter-pictures';
import { refreshReporterCard } from './reporter-inbox';
import { LinearWriteError, type LinearCommentWriter } from './reporter-writer';
import {
  cleanBody,
  commentText,
  MIN_BODY_CHARS,
  parseWrittenLines,
  saysSignedOut,
} from './reporter-comment';
import { judgeReporterCall, secretIn, type ReporterRun } from './reporter-guard';
import { nothingToReport } from './reporter-needs';
import { accountRunStart, checkSaysSignedOut, reachOutcome } from './reporter-reach';
import { appliedStatuses, lastStatusSet, pickStatusMove, statusAimOf } from './reporter-status';
import { reporterSettings, reporterSettingsKey } from './reporter-settings';
import { noLinearCall, signInNeeded } from './sign-in-needed';
import {
  SNAPSHOT_FIRST_LINE,
  SNAPSHOT_MAX_READS,
  SNAPSHOT_STARTER,
  type LinearSnapshot,
} from './snapshot';
import { linearLinkOf } from './task-link';

// The Linear reporter's run: one timer per task, one short session per run,
// and the in-memory run the session's tools and guard answer from. A run is a Reporter conversation's
// session; its rows are `linear_posts`, which are the only state that outlives the daemon.

/** How long a run may take before it is stopped and its rows fail. */
export const RUN_DEADLINE_MS = 15 * 60_000;
/** How long a snapshot may take: a lane waits on it before it starts. */
export const SNAPSHOT_DEADLINE_MS = 3 * 60_000;
/** A failed row is due again after `first` times two to the number of earlier failures, at most `max`. */
export const BACKOFF_MS = { first: 5 * 60_000, max: 6 * 60 * 60_000 } as const;
/** A row that fails this many times is failed for good, unless it is one of a run's last updates. */
export const MAX_TRIES = 5;
/**
 * A run's last updates: retried at the backoff cap until they post or the builder dismisses them, since they are
 * what a reader of the issue needs most.
 */
const LASTING: ReadonlySet<LinearEventKind> = new Set([
  LinearEventKind.Verdict,
  LinearEventKind.Ended,
]);
const maxTriesOf = (event: LinearEventKind): number =>
  LASTING.has(event) ? Number.POSITIVE_INFINITY : MAX_TRIES;
/**
 * How long a row held for a Linear sign-in waits before it is tried again, and how long an account a run found
 * signed out is taken as signed out. A wake (a move, a sign-in, Linear switched on) ends the wait at once.
 */
export const HOLD_RETRY_MS = 30 * 60_000;

/** How often a task's due rows look again for the capture of its after picture, and how long they wait for it. */
export const PICTURES_POLL_MS = 15_000;
export const PICTURES_WAIT_MS = 5 * 60_000;

/** The line that starts a run; only a trigger, the brief carries what to do. */
export const REPORTER_STARTER = 'Report the pending Linear updates.';

/** How many of the conversation's newest items a settle reads for the run's and the earlier Linear calls. */
const CALLS_READ = 200;
/** How many of the conversation's newest sessions a settle reads for where its account's own run began. */
const SESSIONS_READ = 50;

const ALLOWED_BY_RULE = "10db's reporter rule allows this call.";
const SESSION_OVER = 'This reporter run is over; nothing it calls is recorded.';
const STATUS_NEEDED =
  "This update moves the issue's status, so 10db needs what Linear shows: give status with current, the issue's status name from get_issue, and statuses, every status of its team from list_issue_statuses (each with its name and type). Then call report_linear_post again.";

/**
 * Said with every picture step. Linear's own description of `prepare_file_upload` tells the caller to PUT the
 * bytes, which the reporter's agent has neither the file nor the network for, so without this it gives up.
 */
const UPLOAD_STEP_NOTE =
  "10db holds this picture and sends its bytes to Linear itself the moment Linear answers. You have no file to provide and nothing to upload: call prepare_file_upload with exactly these arguments, ignore Linear's upload instructions, then call report_linear_post with the post id.";

/** A call 10db dictates to the reporter's agent, made with these arguments unchanged. */
export type LinearCall =
  | {
      /** Linear signs an upload address for the one file 10db named; 10db sends the file itself. */
      readonly tool: 'prepare_file_upload';
      readonly arguments: {
        readonly filename: string;
        readonly contentType: string;
        readonly size: number;
      };
    }
  | {
      /** Back to 10db once Linear answered the upload request: it names the next file, or the comment. */
      readonly tool: 'report_linear_post';
      readonly arguments: { readonly postId: LinearPostId };
    }
  | {
      readonly tool: 'save_comment';
      readonly arguments: { readonly issueId: string; readonly body: string };
    }
  | {
      readonly tool: 'save_issue';
      readonly arguments: { readonly id: string; readonly state: string };
    };

/** What `report_linear_post` answers the agent. `next` is the calls left to make, in order. */
export type ReportedPost =
  | {
      readonly ok: true;
      readonly next: readonly LinearCall[];
      /** Set on a picture step: the agent only asks for the address; 10db holds the file and sends it. */
      readonly note?: string;
    }
  | {
      /** 10db wrote the comment itself, through the account's Linear server. */
      readonly ok: true;
      readonly written: true;
      readonly commentId: string | null;
      readonly next?: readonly LinearCall[];
    }
  | {
      /** 10db's write was refused; the update is owed again. */
      readonly ok: true;
      readonly written: false;
      readonly why: string;
    }
  | {
      /** Linear did not answer 10db's write; it may exist, so the update is never written again. */
      readonly ok: true;
      readonly written: 'unknown';
      readonly why: string;
      readonly next?: readonly LinearCall[];
    }
  | {
      readonly ok: true;
      readonly recorded: 'nothing to report';
      readonly next?: readonly LinearCall[];
    }
  | { readonly ok: true; readonly withheld: string; readonly why: string };

export interface LinearReporter {
  /** Startup pickup: arms a timer per task with pending rows. */
  start(): void;
  /** Cancels timers; leaves rows as they are; never awaits the engine. */
  stop(): Promise<void>;
  /** A row was enqueued. */
  poke(taskId: TaskId): void;
  /**
   * The project's way to Linear may have changed (it moved, its account signed in, Linear was switched on): its
   * held rows are due now and its account is no longer taken as signed out.
   */
  wake(projectId: ProjectId): void;
  /**
   * `report_linear_post`, from a reporter session only: the agent's body for one owed update (or that it has
   * nothing to report). 10db builds the comment and writes it through the account's Linear server when it can
   * sign in to it itself; otherwise it answers the exact `save_comment` arguments, the only comment the session's
   * guard lets through. An update that moves the issue's status by default needs the statuses the session read;
   * 10db picks the move from them and answers the `save_issue` that sets it, the only one the guard lets through.
   */
  reportPost(sessionId: SessionId, input: ReportLinearPostInput): Promise<ReportedPost>;
  /** `upload_linear_picture`: refused, 10db uploads the pictures itself. */
  uploadPicture(sessionId: SessionId, input: UploadLinearPictureInput): Promise<{ ok: true }>;
  /**
   * Reads the task's linked Linear issue, its comments and its named relations through the account's own Linear
   * sign-in, in a read-only run, for a lane's brief. Null for a task with no link; a run that can't read says why.
   * It never writes to Linear and never throws.
   */
  snapshot(taskId: TaskId): Promise<LinearSnapshot | null>;
  /** The reporter's preToolUse for its own session. */
  verdict(sessionId: SessionId, req: ShapeToolRequest): ShapeVerdict;
  /**
   * A call of the reporter's session returned, with its result (null when it failed). The result of the upload
   * request 10db named is where 10db sends that picture.
   */
  toolResult(
    sessionId: SessionId,
    result: { readonly toolName: string; readonly input: unknown; readonly response: unknown },
  ): void;
  settings(projectId: ProjectId): LinearReporterSettings & { blockedBy: string | null };
  /** Off drops the project's pending rows. */
  setSettings(projectId: ProjectId, input: LinearReporterSettings): void;
}

/** What the Reporter conversation's owner hooks drive the run with. */
export interface LinearReporterRuns {
  /**
   * The session exists: takes every row of the task due now, and opens the run the session's tools answer
   * from. Throws when no run is waiting for a session or nothing is owed.
   */
  begin(input: {
    readonly conversationId: ConversationId;
    readonly sessionId: SessionId;
    /** The account the session runs on: the one a run that reaches no Linear names. */
    readonly accountId: AccountId;
    readonly linearPrefixes: readonly string[];
    /** 10db's own way to write a comment, when the account's Linear server accepts 10db's sign-in; else null. */
    readonly writer: LinearCommentWriter | null;
  }): { readonly posts: readonly LinearPostDto[]; readonly run: Readonly<ReporterRun> };
  /** The session could not be made (its launch, sandbox or sign-in check threw): the run fails with this reason. */
  startFailed(conversationId: ConversationId, message: string): void;
  /** The conversation's turn ended. */
  turnEnded(conv: ConversationRow, end: TurnEnd): void;
  /** The conversation's state changed: settles a run whose session left without a turn end. */
  stateChanged(conv: ConversationRow, to: ConversationState): void;
}

export interface LinearReporterDeps {
  readonly state: StateStore;
  readonly clock: Clock;
  readonly log: Logger;
  readonly engine: Pick<ExploreEngine, 'queued' | 'retire' | 'unretire' | 'stop'>;
  /** The task's reporter conversation, made when it has none. */
  readonly conversations: { reporterOf(taskId: TaskId, projectId: ProjectId): ConversationId };
  readonly signIns: { list(): Promise<LinearSignInsDto> };
  readonly inbox: InboxService;
  /** Why a task that names a page has no pictures, or null; said once in its `ended` comment. */
  readonly picturesOutlook?: (taskId: TaskId) => PicturesOutlook;
  /** Sends a picture to Linear's storage; the platform's `fetch` when absent. */
  readonly send?: typeof fetch;
}

/** An owed update whose pictures go to Linear through the agent's sign-in: the upload, and what its comment needs after it. */
interface UploadingPost {
  readonly upload: AgentUpload;
  readonly body: string;
  readonly setStatus: readonly LinearCall[];
}

/** One run, from its trigger to its settle. */
interface Flight {
  readonly taskId: TaskId;
  readonly projectId: ProjectId;
  readonly conversationId: ConversationId;
  sessionId: SessionId | null;
  /** The account the session runs on, once it has begun. */
  accountId: AccountId | null;
  /** An allowed Linear call was made: the session's agent is signed in to Linear. */
  reachedLinear: boolean;
  /** 10db's own way to write this run's comments, when it has one. */
  writer: LinearCommentWriter | null;
  /** The account's Linear sign-in check, as the trigger read it; null when it has no row. */
  readonly signIn: LinearSignInRowDto | null;
  /** The rows due when the run was triggered: what fails when the session never takes any. */
  readonly due: ReadonlySet<LinearPostId>;
  taken: ReadonlySet<LinearPostId>;
  /** Rows whose comment the guard let out: recorded before the write, so a retry or a restart never repeats it. */
  readonly written: Set<LinearPostId>;
  /** The status 10db picked for each owed update (`report_linear_post`). */
  readonly picked: Map<LinearPostId, string>;
  /** Per owed update, its pictures on their way to Linear through the agent's sign-in, and the calls that follow them. */
  readonly uploads: Map<LinearPostId, UploadingPost>;
  /** The address each update's comment shows its first picture at, recorded on its row with the comment. */
  readonly attachments: Map<LinearPostId, string>;
  /** The run's newest pick, the furthest one: the only status its `save_issue` may set, and where its later updates start from. */
  runPick: string | null;
  /** Where the run's own conversation items begin: its closing message names the comment ids. */
  readonly afterSeq: number;
  /** A snapshot run's wait: what the lane's start is waiting on, and where the run's own items begin. */
  readonly snapshot: {
    readonly resolve: (result: LinearSnapshot) => void;
    readonly afterSeq: number;
  } | null;
  /** The Linear reads a snapshot run has made. */
  reads: number;
  /** The error that stopped the run, when it is known; the rows fail with it. */
  error: string | null;
  guard: ReporterRun | null;
  /** The conversation was seen in a turn state, so a later departure from it is the run's end. */
  busySeen: boolean;
  settled: boolean;
  deadline: Timer | null;
}

const backoffMs = (tries: number): number =>
  Math.min(BACKOFF_MS.first * 2 ** tries, BACKOFF_MS.max);

const dueAtMs = (row: LinearPostDto): number =>
  row.dueAt === null ? Number.NEGATIVE_INFINITY : Date.parse(row.dueAt);

export function createLinearReporter(
  deps: LinearReporterDeps,
): LinearReporter & LinearReporterRuns {
  const { state, clock, log, engine } = deps;
  const timers = new Map<TaskId, Timer>();
  const flights = new Map<TaskId, Flight>();
  /** When each task's due rows first waited for its pictures: the wait ends `PICTURES_WAIT_MS` after. */
  const pictureWaits = new Map<TaskId, number>();
  const bySession = new Map<SessionId, Flight>();
  const byConversation = new Map<ConversationId, Flight>();
  /** The zero-delay timers that retire a settled run's conversation and re-arm its task. */
  const afters = new Set<Timer>();
  /** Snapshots waiting for a task's run to finish; each is woken with whether the task went idle. */
  const idleWaiters = new Map<TaskId, Set<(idle: boolean) => void>>();
  /** Accounts a run found signed out of Linear: their rows are held without a session until `until`. */
  const signedOut = new Map<AccountId, { readonly reason: string; readonly until: number }>();
  let stopped = false;
  /** Read again after an await, where the compiler has narrowed `stopped`. */
  const halted = (): boolean => stopped;

  /** The line naming the account that needs a Linear sign-in, and how. */
  const signInReason = (accountId: AccountId): string => {
    const account = getAccount(state.db, accountId);
    return signInNeeded(account.label, harnessOf(account));
  };

  /** Holds rows whose account can't reach Linear: no try is spent, and they are due again at `until`. */
  const hold = (
    rows: readonly LinearPostDto[],
    found: { readonly reason: string; readonly until: number },
  ): void => {
    if (rows.length === 0) return;
    state.write((ctx) => {
      holdLinearPosts(
        ctx,
        rows.map((p) => p.id),
        found.reason,
        new Date(found.until).toISOString(),
      );
    });
  };

  /**
   * The account was found signed out of Linear: it is taken as signed out for the hold, so the other tasks on it
   * hold without a session of their own until the next one finds out again.
   */
  const foundSignedOut = (accountId: AccountId): { reason: string; until: number } => {
    const found = {
      reason: signInReason(accountId),
      until: clock.now().getTime() + HOLD_RETRY_MS,
    };
    signedOut.set(accountId, found);
    return found;
  };

  const fail = (rows: readonly LinearPostDto[], error: string): void => {
    const now = clock.now().getTime();
    state.write((ctx) => {
      // Each row's backoff follows its own tries.
      for (const row of rows)
        failLinearPosts(
          ctx,
          [row.id],
          error,
          new Date(now + backoffMs(row.tries)).toISOString(),
          maxTriesOf(row.event),
        );
    });
  };

  /** Arms the task's timer at its earliest pending due time; a task in flight is re-armed by its settle. */
  const arm = (taskId: TaskId): void => {
    if (stopped) return;
    timers.get(taskId)?.cancel();
    timers.delete(taskId);
    if (flights.has(taskId)) return;
    const rows = pendingLinearPosts(state.db, { taskId });
    if (rows.length === 0) return;
    const due = Math.min(...rows.map(dueAtMs));
    timers.set(taskId, pickupAt(taskId, Math.max(0, due - clock.now().getTime())));
  };

  /** A timer that picks the task up after `delayMs`; a pickup that throws fails its due rows and arms the task again. */
  const pickupAt = (taskId: TaskId, delayMs: number): Timer =>
    clock.setTimeout(() => {
      timers.delete(taskId);
      pickup(taskId).catch((error: unknown) => {
        log.error({ err: error, taskId }, 'the Linear reporter could not pick up a task');
        // Its due rows fail with the error and back off, and the task is armed again.
        try {
          const now = clock.now().getTime();
          fail(
            pendingLinearPosts(state.db, { taskId }).filter((p) => dueAtMs(p) <= now),
            error instanceof Error ? error.message : String(error),
          );
        } catch (failure) {
          log.error({ err: failure, taskId }, 'the Linear reporter could not fail its rows');
        }
        arm(taskId);
      });
    }, delayMs);

  /**
   * Whether the task's due rows should wait a little longer for its pictures: one of them is an update that
   * shows them and a capture of the after is still running. The wait is bounded, and spends no try.
   */
  const waitingForPictures = (
    taskId: TaskId,
    due: readonly LinearPostDto[],
    now: number,
  ): boolean => {
    if (deps.picturesOutlook === undefined || !due.some((p) => carriesPictures(p.event))) {
      pictureWaits.delete(taskId);
      return false;
    }
    if (deps.picturesOutlook(taskId).kind !== 'wait') {
      pictureWaits.delete(taskId);
      return false;
    }
    const since = pictureWaits.get(taskId) ?? now;
    pictureWaits.set(taskId, since);
    if (now - since >= PICTURES_WAIT_MS) {
      pictureWaits.delete(taskId);
      return false;
    }
    return true;
  };

  const refreshCard = (projectId: ProjectId): void => {
    try {
      refreshReporterCard({ state, inbox: deps.inbox }, projectId);
    } catch (error) {
      log.error({ err: error, projectId }, 'the Linear reporter could not refresh its Inbox card');
    }
  };

  const dropProject = (projectId: ProjectId): void => {
    state.write((ctx) => {
      dropPendingLinearPosts(ctx, { projectId });
    });
    refreshCard(projectId);
  };

  const pickup = async (taskId: TaskId): Promise<void> => {
    if (stopped || flights.has(taskId)) return;
    if (pendingLinearPosts(state.db, { taskId }).length === 0) return;
    const task = getTask(state.db, taskId);
    // An archived project's owed posts wait: no session starts for it.
    if (getProject(state.db, task.projectId).archivedAt !== null) return;
    const blocked = reporterBlockedBy(state.db, task.projectId);
    if (blocked !== null) {
      dropProject(task.projectId);
      return;
    }
    const accountId = getProject(state.db, task.projectId).accountId;
    const row = (await deps.signIns.list()).rows.find((r) => r.accountId === accountId);
    if (halted() || flights.has(taskId)) return;
    const now = clock.now().getTime();
    const owed = pendingLinearPosts(state.db, { taskId }).filter((p) => dueAtMs(p) <= now);
    // A row with nothing to report is withheld here, seen at once: no session, no hold and no card.
    const empty = owed.filter(nothingToReport);
    if (empty.length > 0) {
      state.write((ctx) => {
        recordLinearPosts(
          ctx,
          empty.map((p) => p.id),
          { state: 'withheld', pattern: LinearWithheldPattern.NothingToReport },
          { dismissed: true },
        );
      });
      log.info(
        { taskId, events: empty.map((p) => p.event) },
        'Linear updates with nothing to report were withheld',
      );
      refreshCard(task.projectId);
    }
    const due = owed.filter((p) => !nothingToReport(p));
    if (due.length === 0) {
      arm(taskId);
      return;
    }
    // A check that says signed in outweighs what an earlier run found.
    if (row?.signedIn === true) signedOut.delete(accountId);
    // An account a run lately found signed out holds without a session, as does one whose check says signed out;
    // an unchecked or unread row is a maybe (after a restart) and goes ahead.
    const known = signedOut.get(accountId);
    const found =
      known !== undefined && known.until > now
        ? known
        : checkSaysSignedOut(row)
          ? foundSignedOut(accountId)
          : null;
    if (found !== null) {
      hold(due, found);
      refreshCard(task.projectId);
      arm(taskId);
      return;
    }
    if (waitingForPictures(taskId, due, now)) {
      timers.set(taskId, pickupAt(taskId, PICTURES_POLL_MS));
      return;
    }
    pictureWaits.delete(taskId);
    trigger(taskId, task.projectId, due, null, row ?? null);
  };

  const trigger = (
    taskId: TaskId,
    projectId: ProjectId,
    due: readonly LinearPostDto[],
    snapshot: Flight['snapshot'],
    signIn: LinearSignInRowDto | null,
  ): void => {
    const conversationId = deps.conversations.reporterOf(taskId, projectId);
    const flight: Flight = {
      taskId,
      projectId,
      conversationId,
      sessionId: null,
      accountId: null,
      reachedLinear: false,
      writer: null,
      signIn,
      due: new Set(due.map((p) => p.id)),
      snapshot,
      reads: 0,
      taken: new Set(),
      written: new Set(),
      picked: new Map(),
      uploads: new Map(),
      attachments: new Map(),
      runPick: null,
      afterSeq: lastItems(state.db, conversationId, 1)[0]?.seq ?? -1,
      error: null,
      guard: null,
      busySeen: false,
      settled: false,
      deadline: null,
    };
    flights.set(taskId, flight);
    byConversation.set(conversationId, flight);
    flight.deadline = clock.setTimeout(
      () => {
        timeOut(flight);
      },
      snapshot === null ? RUN_DEADLINE_MS : SNAPSHOT_DEADLINE_MS,
    );
    try {
      engine.unretire(conversationId);
      state.write((ctx) => {
        insertItem(ctx, conversationId, {
          author: ConversationItemAuthor.Builder,
          kind: ConversationItemKind.Message,
          body: { text: snapshot === null ? REPORTER_STARTER : SNAPSHOT_STARTER },
        });
      });
      engine.queued(conversationId);
    } catch (error) {
      settle(flight, error instanceof Error ? error.message : String(error));
    }
  };

  const timeOut = (flight: Flight): void => {
    const done = (): void => {
      settle(
        flight,
        flight.snapshot === null
          ? 'the run did not finish within 15 minutes'
          : 'reading the issue took too long',
      );
    };
    // The conversation is stopped first, so what it still sends reaches a run that is over.
    engine.stop(flight.conversationId).then(done, (error: unknown) => {
      log.warn({ err: error, taskId: flight.taskId }, 'a timed-out reporter run did not stop');
      done();
    });
  };

  /**
   * Ends the run once: its taken rows still pending are held when a completed session found no Linear sign-in,
   * and fail otherwise (a row the guard withheld is already settled). The conversation is retired, and the task
   * re-armed, off the engine's effect chain.
   */
  const settle = (flight: Flight, reason: string, complete = false): void => {
    // A stopped reporter leaves every row as it is, for the next start to pick up.
    if (flight.settled || stopped) return;
    flight.settled = true;
    flight.deadline?.cancel();
    if (flight.snapshot !== null) {
      flight.snapshot.resolve(
        snapshotOf(flight, flight.snapshot, flight.error ?? reason, complete),
      );
    } else {
      settleRows(flight, reason, complete);
    }
    if (flight.sessionId !== null) bySession.delete(flight.sessionId);
    // The task stays in flight until its conversation is retired, so nothing starts on a conversation still closing.
    retireAfter(flight);
  };

  /** What a snapshot run made: the last thing its session said when its turn completed, else why not. */
  const snapshotOf = (
    flight: Flight,
    snapshot: NonNullable<Flight['snapshot']>,
    reason: string,
    complete: boolean,
  ): LinearSnapshot => {
    if (complete) {
      try {
        const said = listItems(state.db, flight.conversationId, { afterSeq: snapshot.afterSeq })
          .filter((item) => item.kind === ConversationItemKind.AgentMessage)
          .map((item) => parseItemBody(ConversationItemKind.AgentMessage, item.body).text.trim())
          .filter((text) => text !== '');
        const text = said.at(-1);
        if (text?.startsWith(SNAPSHOT_FIRST_LINE) === true)
          return { kind: 'read', text: text.slice(SNAPSHOT_FIRST_LINE.length).trim() };
        if (text !== undefined)
          return { kind: 'missing', reason: 'the session did not return the issue' };
      } catch (error) {
        log.error({ err: error, taskId: flight.taskId }, 'a snapshot run could not be read back');
      }
      return { kind: 'missing', reason: 'the session answered with nothing' };
    }
    return { kind: 'missing', reason };
  };

  /** The agent's own closing message says Linear answered that it is not signed in (`SIGNED_OUT_LINE`). */
  const saidSignedOut = (flight: Flight): boolean =>
    listItems(state.db, flight.conversationId, { afterSeq: flight.afterSeq })
      .filter((item) => item.kind === ConversationItemKind.AgentMessage)
      .some((item) =>
        saysSignedOut(parseItemBody(ConversationItemKind.AgentMessage, item.body).text),
      );

  /**
   * What the run's closing message says of the comments the guard let out: the id Linear gave each, which is
   * recorded on its row, or why the write failed, which is kept on the row. Either way the row stays recorded:
   * the agent can't tell a refusal from a write Linear took without answering, so a comment the guard let out is
   * never written again.
   */
  const settleWritten = (flight: Flight): void => {
    // 10db's own writes name their ids from Linear's answer; only the agent's carry a closing message.
    if (flight.written.size === 0 || flight.guard?.direct === true) return;
    const said = listItems(state.db, flight.conversationId, { afterSeq: flight.afterSeq })
      .filter((item) => item.kind === ConversationItemKind.AgentMessage)
      .map((item) => parseItemBody(ConversationItemKind.AgentMessage, item.body).text);
    const lines = said.flatMap(parseWrittenLines).filter((l) => flight.written.has(l.postId));
    state.write((ctx) => {
      for (const line of lines) {
        if ('commentId' in line) attachLinearCommentId(ctx, line.postId, line.commentId);
        else noteLinearPostError(ctx, line.postId, line.failure);
      }
    });
    const failed = lines.filter((l) => !('commentId' in l)).map((l) => l.postId);
    if (failed.length > 0)
      log.warn(
        { taskId: flight.taskId, posts: failed },
        'a reporter run says comments failed that Linear may have written',
      );
    const unnamed = [...flight.written].filter((id) => !lines.some((l) => l.postId === id));
    if (unnamed.length > 0)
      log.warn(
        { taskId: flight.taskId, posts: unnamed },
        'a reporter run wrote comments it gave no id for',
      );
  };

  /**
   * Records the statuses Linear took on the rows 10db picked them for. A `save_issue` the guard allowed says
   * nothing by itself: only one that came back done moved the issue, and a row that claimed a status Linear
   * never applied would read every later status as the builder's own move.
   */
  const settleStatuses = (flight: Flight): void => {
    if (flight.picked.size === 0 || flight.guard === null) return;
    const runCalls = lastItems(state.db, flight.conversationId, CALLS_READ).flatMap((item) => {
      if (item.kind !== ConversationItemKind.ToolCall || item.seq <= flight.afterSeq) return [];
      try {
        return [parseItemBody(ConversationItemKind.ToolCall, item.body)];
      } catch {
        // A body that isn't a call's shows no status.
        return [];
      }
    });
    const applied = appliedStatuses(runCalls, flight.guard.linearPrefixes);
    const set = [...flight.picked].filter(([, name]) => applied.has(name));
    if (set.length === 0) return;
    state.write((ctx) => {
      for (const [id, name] of set) attachLinearStatusSet(ctx, id, name);
    });
  };

  /**
   * The tool calls of the conversation's newest items: the run's own, and those before its starter that sessions
   * on the run's account made. The conversation outlives a move, so another account's answers are left out.
   */
  const callsOf = (
    flight: Flight & { accountId: AccountId },
  ): { runCalls: ToolCallView[]; earlierCalls: ToolCallView[] } => {
    const runCalls: ToolCallView[] = [];
    const earlierCalls: ToolCallView[] = [];
    const since = accountRunStart(
      lastConversationSessions(state.db, flight.conversationId, SESSIONS_READ),
      flight.accountId,
    );
    for (const item of lastItems(state.db, flight.conversationId, CALLS_READ)) {
      if (item.kind !== ConversationItemKind.ToolCall) continue;
      const own = item.seq > flight.afterSeq;
      // Items and sessions are stamped by the store's one clock, in the same form.
      if (!own && (since === null || item.createdAt < since)) continue;
      try {
        const call = parseItemBody(ConversationItemKind.ToolCall, item.body);
        (own ? runCalls : earlierCalls).push(call);
      } catch {
        // A body that isn't a call's shows nothing either way.
      }
    }
    return { runCalls, earlierCalls };
  };

  /**
   * Settles rows a begun run left open without recording them: held for a sign-in only on evidence that the
   * account's Linear needs one (`reachOutcome`), failed with `reason` when the run reached Linear, and failed with
   * why it isn't a sign-in when the account's Linear works but the run never called it. That last one never takes
   * the account as signed out, so the other tasks on it still run.
   */
  const settleUnreported = (
    flight: Flight & { accountId: AccountId; guard: ReporterRun },
    rows: readonly LinearPostDto[],
    reason: string,
  ): void => {
    const reach = reachOutcome({
      reachedLinear: flight.reachedLinear,
      linearPrefixes: flight.guard.linearPrefixes,
      signIn: flight.signIn,
      ...callsOf(flight),
    });
    switch (reach.kind) {
      case 'sign_in':
        hold(rows, foundSignedOut(flight.accountId));
        return;
      case 'retry': {
        const why = noLinearCall(getAccount(state.db, flight.accountId).label, reach.evidence);
        fail(rows, why);
        return;
      }
      case 'reached':
        fail(rows, reason);
        return;
    }
  };

  /** The run's session began: it has an account and a guard. */
  const begun = (flight: Flight): flight is Flight & { accountId: AccountId; guard: ReporterRun } =>
    flight.guard !== null && flight.accountId !== null;

  const settleRows = (flight: Flight, reason: string, complete: boolean): void => {
    try {
      settleWritten(flight);
    } catch (error) {
      log.error(
        { err: error, taskId: flight.taskId },
        'a reporter run could not record its comments',
      );
    }
    try {
      settleStatuses(flight);
    } catch (error) {
      log.error(
        { err: error, taskId: flight.taskId },
        'a reporter run could not record its statuses',
      );
    }
    try {
      // What the session took; when it never got that far, what was due when the run was triggered.
      const owned = flight.taken.size > 0 ? flight.taken : flight.due;
      const open = pendingLinearPosts(state.db, { taskId: flight.taskId }).filter(
        (p) => owned.has(p.id) && !flight.written.has(p.id),
      );
      // A completed turn that left rows open is held only on evidence of a missing sign-in: the agent said Linear
      // asked it to sign in, or `reachOutcome` finds it. A run 10db writes for makes no Linear call of its own, so
      // it shows nothing about the sign-in. A run that left no row open (it recorded them all) shows nothing
      // about the account either.
      if (complete && open.length > 0 && begun(flight) && !flight.guard.direct) {
        if (saidSignedOut(flight)) hold(open, foundSignedOut(flight.accountId));
        else settleUnreported(flight, open, flight.error ?? reason);
      } else fail(open, flight.error ?? reason);
      refreshCard(flight.projectId);
    } catch (error) {
      log.error({ err: error, taskId: flight.taskId }, 'a reporter run could not be settled');
    }
  };

  const retireAfter = (flight: Flight): void => {
    const after = clock.setTimeout(() => {
      afters.delete(after);
      engine
        .retire(flight.conversationId)
        .catch((error: unknown) => {
          log.warn(
            { err: error, taskId: flight.taskId },
            'a reporter conversation was not retired',
          );
        })
        .finally(() => {
          flights.delete(flight.taskId);
          byConversation.delete(flight.conversationId);
          for (const wake of idleWaiters.get(flight.taskId) ?? []) wake(true);
          idleWaiters.delete(flight.taskId);
          arm(flight.taskId);
        });
    }, 0);
    afters.add(after);
  };

  /** Waits for the task's run to finish and its conversation to retire, for at most the snapshot deadline. */
  const untilIdle = (taskId: TaskId): Promise<boolean> =>
    new Promise((resolve) => {
      const waiters = idleWaiters.get(taskId) ?? new Set();
      idleWaiters.set(taskId, waiters);
      const wake = (idle: boolean): void => {
        timer.cancel();
        waiters.delete(wake);
        resolve(idle);
      };
      const timer = clock.setTimeout(() => {
        wake(false);
      }, SNAPSHOT_DEADLINE_MS);
      waiters.add(wake);
    });

  /** The project's held rows are due now, its account is no longer taken as signed out, and its tasks re-arm. */
  const wake = (projectId: ProjectId): void => {
    if (stopped) return;
    signedOut.delete(getProject(state.db, projectId).accountId);
    const now = clock.now().toISOString();
    state.write((ctx) => {
      wakeHeldLinearPosts(ctx, projectId, now);
    });
    const tasks = new Set(pendingLinearPosts(state.db, { projectId }).map((p) => p.taskId));
    for (const taskId of tasks) arm(taskId);
    // A Retry closed the card; what is still owed or withheld brings it back.
    refreshCard(projectId);
  };

  const runOf = (sessionId: SessionId): { flight: Flight; guard: ReporterRun } => {
    const flight = bySession.get(sessionId);
    if (flight === undefined || flight.settled || flight.guard === null)
      throw new ConflictError(SESSION_OVER);
    return { flight, guard: flight.guard };
  };

  /**
   * The status an owed update moves the issue to, picked by 10db from what the session read of the issue's
   * statuses, and allowed for the run's `save_issue`; null when it moves none. An update with a default move
   * and no steering note needs the statuses, so a session that skips the reads can't skip the move.
   */
  const statusMoveOf = (
    flight: Flight,
    guard: ReporterRun,
    post: LinearPostDto,
    read: LinearIssueStatuses | undefined,
  ): string | null => {
    if (guard.noteSteers || statusAimOf(post.event) === null) return null;
    // An update handed over again keeps its pick, unless a later update of the run moved the issue past it.
    const earlier = flight.picked.get(post.id);
    if (earlier !== undefined) return earlier === flight.runPick ? earlier : null;
    if (read === undefined) throw new InvalidError(STATUS_NEEDED);
    const lower = read.current.toLowerCase();
    const current =
      read.statuses.find((s) => s.name === read.current) ??
      read.statuses.find((s) => s.name.toLowerCase() === lower);
    if (current === undefined)
      throw new InvalidError(
        "status.current is not one of status.statuses. Give the issue's status name from get_issue and every status of its team from list_issue_statuses.",
      );
    const linked = linearLinkOf(state.db, flight.taskId);
    // A follow-up's issue is its chain's, so what 10db set there includes every earlier task's rows.
    const history = [...(linked?.chain ?? [])]
      .concat(flight.taskId)
      .flatMap((id) => listLinearPosts(state.db, id));
    const picked = pickStatusMove({
      event: post.event,
      current,
      statuses: read.statuses,
      // A row records its status when the run settles, so these are the sets of earlier runs.
      lastSet: lastStatusSet(history),
      runPick: flight.runPick,
    });
    if (picked === null) return null;
    // One status per run, the furthest: an earlier pick the session has not set yet is no longer allowed, so
    // the issue never goes back to it.
    guard.pickedStatuses.clear();
    guard.pickedStatuses.add(picked.name);
    flight.picked.set(post.id, picked.name);
    flight.runPick = picked.name;
    return picked.name;
  };

  /**
   * What `report_linear_post` answers while an update's pictures go to Linear through the agent's sign-in: the
   * upload request for the next file and the call back to 10db, or, once none is left, the comment with the
   * pictures that reached Linear. A picture that failed leaves the comment going out without it.
   */
  const uploadAnswer = async (
    flight: Flight,
    guard: ReporterRun,
    post: LinearPostDto,
    uploading: UploadingPost,
  ): Promise<ReportedPost> => {
    const { upload } = uploading;
    const comment = (text: string): ReportedPost => ({
      ok: true,
      next: [
        { tool: 'save_comment', arguments: { issueId: guard.link.issueId, body: text } },
        ...uploading.setStatus,
      ],
    });
    // The comment is already built: the same calls again, and no picture is sent twice.
    const built = guard.comments.get(post.id);
    if (built !== undefined) return comment(built.text);
    let named: Awaited<ReturnType<typeof nameNextPicture>> = null;
    try {
      named = await nameNextPicture(state.db, upload);
    } catch (error) {
      log.warn(
        { err: error, taskId: flight.taskId },
        'a picture for a Linear comment was not named',
      );
    }
    if (named !== null) {
      guard.uploads.set(post.id, named);
      return {
        ok: true,
        next: [
          {
            tool: 'prepare_file_upload',
            arguments: {
              filename: named.filename,
              contentType: named.contentType,
              size: named.size,
            },
          },
          { tool: 'report_linear_post', arguments: { postId: post.id } },
        ],
        note: UPLOAD_STEP_NOTE,
      };
    }
    guard.uploads.delete(post.id);
    const uploaded = uploadedOf(upload);
    const attachment = attachmentOf(uploaded);
    if (attachment !== null) flight.attachments.set(post.id, attachment);
    const text = commentText(
      uploading.body,
      post,
      picturesText({ uploaded, more: upload.more, offered: upload.offered }),
    );
    guard.comments.set(post.id, { text, written: false });
    return comment(text);
  };

  return {
    start() {
      const tasks = new Set(pendingLinearPosts(state.db).map((p) => p.taskId));
      for (const taskId of tasks) arm(taskId);
    },

    stop() {
      stopped = true;
      for (const timer of timers.values()) timer.cancel();
      timers.clear();
      for (const timer of afters) timer.cancel();
      afters.clear();
      for (const flight of flights.values()) {
        flight.deadline?.cancel();
        flight.deadline = null;
        flight.snapshot?.resolve({ kind: 'missing', reason: '10db is shutting down.' });
      }
      for (const waiters of idleWaiters.values()) for (const wake of [...waiters]) wake(false);
      idleWaiters.clear();
      return Promise.resolve();
    },

    poke: arm,

    wake,

    async snapshot(taskId) {
      const missing = (reason: string): LinearSnapshot => ({ kind: 'missing', reason });
      try {
        if (linearLinkOf(state.db, taskId) === null) return null;
        if (stopped) return missing('10db is shutting down.');
        const task = getTask(state.db, taskId);
        const blocked = reporterBlockedBy(state.db, task.projectId);
        if (blocked !== null) return missing(blocked);
        const accountId = getProject(state.db, task.projectId).accountId;
        const row = (await deps.signIns.list()).rows.find((r) => r.accountId === accountId);
        // An unchecked row is a maybe and goes ahead.
        if (row !== undefined && checkSaysSignedOut(row))
          return missing(
            row.note ??
              "This account's agent has no Linear. Connect Linear under Settings › Integrations.",
          );
        if (halted()) return missing('10db is shutting down.');
        if (flights.has(taskId) && !(await untilIdle(taskId)))
          return missing('A Linear update for this task was still running.');
        if (halted()) return missing('10db is shutting down.');
        if (flights.has(taskId)) return missing('A Linear update for this task was running.');
        const conversationId = deps.conversations.reporterOf(taskId, task.projectId);
        const afterSeq = lastItems(state.db, conversationId, 1)[0]?.seq ?? -1;
        return await new Promise<LinearSnapshot>((resolve) => {
          trigger(taskId, task.projectId, [], { resolve, afterSeq }, row ?? null);
        });
      } catch (error) {
        log.warn({ err: error, taskId }, 'the Linear snapshot could not be read');
        return missing(error instanceof Error ? error.message : String(error));
      }
    },

    begin(input) {
      const flight = byConversation.get(input.conversationId);
      if (flight === undefined || flight.settled)
        throw new ConflictError('No Linear update waits for this session.');
      const link = linearLinkOf(state.db, flight.taskId)?.link;
      if (link === undefined) throw new ConflictError('The task is not linked to a Linear issue.');
      if (flight.snapshot !== null) {
        const guard: ReporterRun = {
          readOnly: true,
          linearPrefixes: input.linearPrefixes,
          link,
          direct: false,
          comments: new Map(),
          noteSteers: false,
          uploads: new Map(),
          pickedStatuses: new Set(),
        };
        flight.sessionId = input.sessionId;
        flight.accountId = input.accountId;
        flight.guard = guard;
        bySession.set(input.sessionId, flight);
        return { posts: [], run: guard };
      }
      const now = clock.now().getTime();
      const posts = pendingLinearPosts(state.db, { taskId: flight.taskId }).filter(
        (p) => dueAtMs(p) <= now,
      );
      if (posts.length === 0) throw new ConflictError('No Linear update is owed any more.');
      state.write((ctx) => {
        takeLinearPosts(
          ctx,
          posts.map((p) => p.id),
          input.sessionId,
        );
      });
      const guard: ReporterRun = {
        readOnly: false,
        linearPrefixes: input.linearPrefixes,
        link,
        direct: input.writer !== null,
        comments: new Map(),
        noteSteers: reporterSettings(state.db, flight.projectId).note.trim() !== '',
        uploads: new Map(),
        pickedStatuses: new Set(),
      };
      flight.sessionId = input.sessionId;
      flight.accountId = input.accountId;
      flight.writer = input.writer;
      flight.taken = new Set(posts.map((p) => p.id));
      flight.guard = guard;
      bySession.set(input.sessionId, flight);
      return { posts, run: guard };
    },

    startFailed(conversationId, message) {
      const flight = byConversation.get(conversationId);
      if (flight !== undefined) flight.error = message;
    },

    turnEnded(conv, end) {
      const flight = byConversation.get(conv.id);
      if (flight === undefined) return;
      settle(
        flight,
        end.how === 'failed'
          ? 'the session ended in error'
          : end.how === 'stopped'
            ? 'the session was stopped'
            : 'the session ended without recording',
        end.how === 'complete',
      );
    },

    stateChanged(conv, to) {
      const flight = byConversation.get(conv.id);
      if (flight === undefined) return;
      if (BUSY.has(to)) {
        flight.busySeen = true;
        return;
      }
      // A turn's end is its own hook; a conversation that left a turn any other way is the run's end.
      if (!flight.busySeen || to === ConversationState.IdleWarm) return;
      settle(
        flight,
        to === ConversationState.PausedAccount
          ? 'the account is paused for its usage limit'
          : to === ConversationState.EndedError
            ? 'the session ended in error'
            : 'the session ended without recording',
      );
    },

    async reportPost(sessionId, input) {
      const { flight, guard } = runOf(sessionId);
      if (guard.readOnly) throw new ConflictError('A snapshot run reports nothing.');
      if (!flight.taken.has(input.postId))
        throw new ConflictError('That update was not given to this session.');
      // The row is the record: one already recorded, withheld or written is never made again.
      const post = pendingLinearPosts(state.db, { taskId: flight.taskId }).find(
        (p) => p.id === input.postId,
      );
      if (post === undefined || flight.written.has(post.id))
        throw new ConflictError('That update is already recorded; nothing more is written for it.');
      // The update's pictures are on their way: this call is the step after an upload request.
      const uploading = flight.uploads.get(post.id);
      if (uploading !== undefined) {
        await closeUploadStep(uploading.upload, clock);
        return await uploadAnswer(flight, guard, post, uploading);
      }
      const nothing = input.nothingToReport === true;
      if (nothing === (input.body !== undefined))
        throw new InvalidError('Give the comment body, or nothingToReport true, and not both.');
      const issueId = guard.link.issueId;
      const move = statusMoveOf(flight, guard, post, input.status);
      const setStatus: LinearCall[] =
        move === null ? [] : [{ tool: 'save_issue', arguments: { id: issueId, state: move } }];
      const withMove = setStatus.length === 0 ? {} : { next: setStatus };
      if (input.body === undefined) {
        state.write((ctx) => {
          recordLinearPosts(ctx, [post.id], {
            state: 'recorded',
            commentIds: [],
            statusSet: null,
            attachmentUrl: null,
          });
        });
        refreshCard(flight.projectId);
        return { ok: true, recorded: 'nothing to report', ...withMove };
      }
      const body = cleanBody(input.body);
      if (body.length < MIN_BODY_CHARS)
        throw new InvalidError(
          `The comment is ${String(body.length)} characters; write what the update says (at least ${String(MIN_BODY_CHARS)}), or report nothingToReport.`,
        );
      const secret = secretIn(body);
      if (secret !== null) {
        // 10db found it, so 10db withholds the row and names the pattern; the agent has none to invent.
        state.write((ctx) => {
          recordLinearPosts(ctx, [post.id], { state: 'withheld', pattern: secret });
        });
        refreshCard(flight.projectId);
        return {
          ok: true,
          withheld: secret,
          why: `The body matches ${secret}, so nothing is written for this update.`,
        };
      }
      const writer = flight.writer;
      const outlook = deps.picturesOutlook ?? (() => ({ kind: 'none' }));
      if (writer === null) {
        // The agent holds the Linear sign-in: it asks Linear for each upload address, a file at a time, and 10db
        // sends the bytes. The comment is built once the last picture is sent.
        let said = '';
        try {
          const show = picturesToShow({ db: state.db, post, outlook });
          if ('pictures' in show) {
            const uploading = {
              upload: beginAgentUpload(show.pictures, show.more),
              body,
              setStatus,
            };
            flight.uploads.set(post.id, uploading);
            return await uploadAnswer(flight, guard, post, uploading);
          }
          said = show.text;
        } catch (error) {
          // The pictures never hold the comment back: whatever goes wrong with them, the words still go out.
          flight.uploads.delete(post.id);
          log.warn(
            { err: error, taskId: flight.taskId },
            'the pictures for a Linear comment failed',
          );
        }
        const text = commentText(body, post, said);
        guard.comments.set(post.id, { text, written: false });
        return {
          ok: true,
          next: [{ tool: 'save_comment', arguments: { issueId, body: text } }, ...setStatus],
        };
      }
      // The pictures never hold the comment back: whatever goes wrong with them, the words still go out.
      let pictures: Awaited<ReturnType<typeof picturesFor>> = { text: '', attachmentUrl: null };
      try {
        pictures = await picturesFor({
          db: state.db,
          post,
          uploader: writer,
          outlook,
          send: deps.send ?? outboundFetch,
        });
      } catch (error) {
        log.warn({ err: error, taskId: flight.taskId }, 'the pictures for a Linear comment failed');
      }
      const text = commentText(body, post, pictures.text);
      // 10db's own write. The row is recorded first, so a crash or a retry never writes the comment twice; the
      // id is added when Linear answers. Only a certain refusal reopens the row with a try spent; a write Linear
      // may have taken without answering stays recorded.
      state.write((ctx) => {
        recordLinearPosts(ctx, [post.id], {
          state: 'recorded',
          commentIds: [],
          statusSet: null,
          attachmentUrl: pictures.attachmentUrl,
        });
      });
      flight.written.add(post.id);
      refreshCard(flight.projectId);
      try {
        const commentId = await writer.postComment({ issueId, body: text });
        if (commentId !== null)
          state.write((ctx) => {
            attachLinearCommentId(ctx, post.id, commentId);
          });
        refreshCard(flight.projectId);
        return { ok: true, written: true, commentId, ...withMove };
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        if (error instanceof LinearWriteError && error.refused) {
          log.warn({ err: error, taskId: flight.taskId }, 'Linear refused a reporter comment');
          if (error.signedOut && flight.accountId !== null) {
            // Linear turned the sign-in away: the row is held, with no try spent, until the account signs in.
            const found = foundSignedOut(flight.accountId);
            state.write((ctx) => {
              reopenLinearPost(
                ctx,
                post.id,
                found.reason,
                new Date(found.until).toISOString(),
                null,
              );
            });
            refreshCard(flight.projectId);
            return { ok: true, written: false, why: found.reason };
          }
          const due = new Date(clock.now().getTime() + backoffMs(post.tries)).toISOString();
          state.write((ctx) => {
            reopenLinearPost(ctx, post.id, why, due, maxTriesOf(post.event));
          });
          refreshCard(flight.projectId);
          return { ok: true, written: false, why };
        }
        // Linear may have written it without answering: the row stays recorded, so it is never written twice.
        log.warn(
          { err: error, taskId: flight.taskId, postId: post.id },
          'a reporter comment may have been written; Linear did not answer',
        );
        state.write((ctx) => {
          noteLinearPostError(ctx, post.id, why);
        });
        refreshCard(flight.projectId);
        return { ok: true, written: 'unknown', why, ...withMove };
      }
    },

    uploadPicture() {
      return Promise.reject(
        new ConflictError('10db uploads the pictures itself; the reporter uploads none.'),
      );
    },

    toolResult(sessionId, result) {
      const flight = bySession.get(sessionId);
      if (flight === undefined || flight.settled || flight.guard === null) return;
      const prefix = flight.guard.linearPrefixes.find((p) => result.toolName.startsWith(p));
      if (prefix === undefined || result.toolName.slice(prefix.length) !== 'prepare_file_upload')
        return;
      const waiting = [...flight.uploads.values()].find(({ upload }) =>
        awaitsResultOf(upload, result.input),
      );
      if (waiting === undefined) return;
      // The signed address lasts a minute, so the picture is sent as soon as its result is read.
      void takeUploadResult(
        waiting.upload,
        result.response === null ? null : toolResultText(result.response),
        deps.send ?? outboundFetch,
      );
    },

    verdict(sessionId, req) {
      const flight = bySession.get(sessionId);
      if (flight === undefined || flight.settled || flight.guard === null)
        return { decision: 'deny', reason: SESSION_OVER };
      // The project may have switched the reporter off while the session ran.
      const blocked = reporterBlockedBy(state.db, flight.projectId);
      if (blocked !== null) return { decision: 'deny', reason: blocked };
      if (flight.snapshot !== null && req.toolName !== 'ToolSearch') {
        flight.reads += 1;
        if (flight.reads > SNAPSHOT_MAX_READS)
          return { decision: 'deny', reason: 'A snapshot run has read as much as it may.' };
      }
      const judged = judgeReporterCall(flight.guard, { toolName: req.toolName, input: req.input });
      const withheld = judged.withheld;
      if (withheld !== undefined) {
        // Only the post whose comment carried the secret is withheld; the run's other rows go on.
        state.write((ctx) => {
          recordLinearPosts(ctx, [withheld.postId], {
            state: 'withheld',
            pattern: withheld.pattern,
          });
        });
        refreshCard(flight.projectId);
        return judged.verdict;
      }
      const wrote = judged.wrote;
      if (wrote !== undefined) {
        // The row records the comment before Linear gets it: a crash after this leaves a row with no id, never a
        // comment with no row, and nothing writes it twice. A row no longer pending (dropped, or recorded) is
        // not written for.
        const stillOwed = pendingLinearPosts(state.db, { taskId: flight.taskId }).some(
          (p) => p.id === wrote,
        );
        if (!stillOwed)
          return {
            decision: 'deny',
            reason: 'That update is no longer owed, so nothing is written for it.',
          };
        try {
          state.write((ctx) => {
            recordLinearPosts(ctx, [wrote], {
              state: 'recorded',
              commentIds: [],
              statusSet: null,
              attachmentUrl: flight.attachments.get(wrote) ?? null,
            });
          });
        } catch (error) {
          log.error(
            { err: error, taskId: flight.taskId },
            'a reporter comment could not be recorded',
          );
          return {
            decision: 'deny',
            reason: '10db could not record this update, so nothing is written. Try the call again.',
          };
        }
        const staged = flight.guard.comments.get(wrote);
        if (staged !== undefined) staged.written = true;
        flight.written.add(wrote);
        refreshCard(flight.projectId);
      }
      const named =
        judged.prepares === undefined ? undefined : flight.guard.uploads.get(judged.prepares);
      if (named !== undefined) named.asked = true;
      // Only a call the rule allows counts: a signed-out server's sign-in tool is refused, so it does not.
      if (
        judged.verdict.decision === 'allow' &&
        flight.guard.linearPrefixes.some((prefix) => req.toolName.startsWith(prefix))
      ) {
        flight.reachedLinear = true;
        // The account reached Linear: an earlier finding that it was signed out no longer holds its other tasks.
        if (flight.accountId !== null) signedOut.delete(flight.accountId);
      }
      // An allowed call is an explicit allow, so neither auto mode's classifier nor a judge sees it.
      return judged.verdict.decision === 'allow'
        ? { decision: 'allow', settled: ALLOWED_BY_RULE }
        : judged.verdict;
    },

    settings(projectId) {
      return {
        ...reporterSettings(state.db, projectId),
        blockedBy: reporterBlockedBy(state.db, projectId),
      };
    },

    setSettings(projectId, input) {
      state.write((ctx) => {
        setAppSetting(ctx, reporterSettingsKey(projectId), input);
        if (!input.on) dropPendingLinearPosts(ctx, { projectId });
      });
      // Linear switched on, Connect Linear among the ways, may have signed the account in.
      if (input.on) wake(projectId);
      refreshCard(projectId);
    },
  };
}
