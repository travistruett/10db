import {
  ConflictError,
  ConversationItemAuthor,
  ConversationItemKind,
  ConversationState,
  harnessOf,
  InvalidError,
  LinearEventKind,
  LinearVia,
  type AccountId,
  type ConversationId,
  type LinearPostDto,
  type LinearPostId,
  type LinearReporterSettings,
  type LinearSignInsDto,
  type ProjectId,
  parseItemBody,
  type ReportLinearPostInput,
  type SessionId,
  type TaskId,
  type UploadLinearPictureInput,
} from '@10db/contracts';
import {
  attachLinearCommentId,
  dropPendingLinearPosts,
  failLinearPosts,
  getAccount,
  getProject,
  getTask,
  holdLinearPosts,
  insertItem,
  lastItems,
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
import type { ShapeToolRequest, ShapeVerdict } from '../sessions';
import { reporterBlockedBy } from './reporter-events';
import type { PicturesOutlook } from '../pictures';
import { carriesPictures, picturesFor } from './reporter-pictures';
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
import { reporterSettings, reporterSettingsKey } from './reporter-settings';
import { signInNeeded } from './sign-in-needed';
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

const ALLOWED_BY_RULE = "10db's reporter rule allows this call.";
const SESSION_OVER = 'This reporter run is over; nothing it calls is recorded.';

/** What `report_linear_post` answers the agent. */
export type ReportedPost =
  | {
      readonly ok: true;
      /** The one Linear write to make, with these arguments unchanged. */
      readonly next: {
        readonly tool: 'save_comment';
        readonly arguments: { readonly issueId: string; readonly body: string };
      };
    }
  | {
      /** 10db wrote the comment itself, through the account's Linear server. */
      readonly ok: true;
      readonly written: true;
      readonly commentId: string | null;
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
    }
  | { readonly ok: true; readonly recorded: 'nothing to report' }
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
   * guard lets through.
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
  /** The rows due when the run was triggered: what fails when the session never takes any. */
  readonly due: ReadonlySet<LinearPostId>;
  taken: ReadonlySet<LinearPostId>;
  /** Rows whose comment the guard let out: recorded before the write, so a retry or a restart never repeats it. */
  readonly written: Set<LinearPostId>;
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
    const due = pendingLinearPosts(state.db, { taskId }).filter((p) => dueAtMs(p) <= now);
    if (due.length === 0) {
      arm(taskId);
      return;
    }
    // An account a run lately found signed out holds without a session; an unchecked row is a maybe (after a
    // restart) and goes ahead.
    const known = signedOut.get(accountId);
    const found =
      known !== undefined && known.until > now
        ? known
        : row?.via === LinearVia.None && !row.unchecked
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
    trigger(taskId, task.projectId, due, null);
  };

  const trigger = (
    taskId: TaskId,
    projectId: ProjectId,
    due: readonly LinearPostDto[],
    snapshot: Flight['snapshot'],
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
      due: new Set(due.map((p) => p.id)),
      snapshot,
      reads: 0,
      taken: new Set(),
      written: new Set(),
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

  /**
   * The run's agent is taken as not signed in to Linear: it never reached Linear, or it said Linear answered that
   * it is not signed in (`SIGNED_OUT_LINE`). A wrong claim costs a hold, never a try.
   */
  const signedOutRun = (flight: Flight): flight is Flight & { accountId: AccountId } => {
    if (
      flight.guard === null ||
      // A run 10db writes for makes no Linear call of its own: it shows nothing about the agent's sign-in.
      flight.guard.direct ||
      flight.accountId === null
    )
      return false;
    if (!flight.reachedLinear) return true;
    return listItems(state.db, flight.conversationId, { afterSeq: flight.afterSeq })
      .filter((item) => item.kind === ConversationItemKind.AgentMessage)
      .some((item) =>
        saysSignedOut(parseItemBody(ConversationItemKind.AgentMessage, item.body).text),
      );
  };

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
      // What the session took; when it never got that far, what was due when the run was triggered.
      const owned = flight.taken.size > 0 ? flight.taken : flight.due;
      const open = pendingLinearPosts(state.db, { taskId: flight.taskId }).filter(
        (p) => owned.has(p.id) && !flight.written.has(p.id),
      );
      // A session whose turn completed without Linear (no allowed call, or Linear said it is not signed in): a
      // sign-in, not a retry, fixes it. A run that left no row open (it recorded them all) shows nothing about
      // the account.
      if (complete && open.length > 0 && signedOutRun(flight))
        hold(open, foundSignedOut(flight.accountId));
      else fail(open, flight.error ?? reason);
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
        if (row?.via === LinearVia.None && !row.unchecked)
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
          trigger(taskId, task.projectId, [], { resolve, afterSeq });
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
      const nothing = input.nothingToReport === true;
      if (nothing === (input.body !== undefined))
        throw new InvalidError('Give the comment body, or nothingToReport true, and not both.');
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
        return { ok: true, recorded: 'nothing to report' };
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
      const issueId = guard.link.issueId;
      const writer = flight.writer;
      // The pictures never hold the comment back: whatever goes wrong with them, the words still go out.
      let pictures: Awaited<ReturnType<typeof picturesFor>> = { text: '', attachmentUrl: null };
      try {
        pictures = await picturesFor({
          db: state.db,
          post,
          uploader: writer,
          outlook: deps.picturesOutlook ?? (() => ({ kind: 'none' })),
          send: deps.send ?? fetch,
        });
      } catch (error) {
        log.warn({ err: error, taskId: flight.taskId }, 'the pictures for a Linear comment failed');
      }
      const text = commentText(body, post, pictures.text);
      if (writer === null) {
        guard.comments.set(post.id, { text, written: false });
        return { ok: true, next: { tool: 'save_comment', arguments: { issueId, body: text } } };
      }
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
        return { ok: true, written: true, commentId };
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
        return { ok: true, written: 'unknown', why };
      }
    },

    uploadPicture() {
      return Promise.reject(
        new ConflictError('10db uploads the pictures itself; the reporter uploads none.'),
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
              attachmentUrl: null,
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
      // Only a call the rule allows counts: a signed-out server's sign-in tool is refused, so it does not.
      if (
        judged.verdict.decision === 'allow' &&
        flight.guard.linearPrefixes.some((prefix) => req.toolName.startsWith(prefix))
      )
        flight.reachedLinear = true;
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
