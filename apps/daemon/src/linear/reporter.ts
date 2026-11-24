import {
  ConflictError,
  ConversationItemAuthor,
  ConversationItemKind,
  ConversationState,
  LinearVia,
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
} from '@10db/contracts';
import {
  dropPendingLinearPosts,
  failLinearPosts,
  getProject,
  getTask,
  insertItem,
  lastItems,
  listItems,
  pendingLinearPosts,
  recordLinearPosts,
  setAppSetting,
  takeLinearPosts,
  type ConversationRow,
} from '@10db/db';
import type { Clock, Timer } from '../clock';
import { BUSY, type ExploreEngine, type TurnEnd } from '../conversation';
import type { StateStore } from '../events';
import type { InboxService } from '../inbox';
import type { Logger } from '../log';
import type { ShapeToolRequest, ShapeVerdict } from '../sessions';
import { reporterBlockedBy } from './reporter-events';
import { refreshReporterCard } from './reporter-inbox';
import { taskPrUrl } from './reporter-brief';
import { judgeReporterCall, type ReporterRun } from './reporter-guard';
import { reporterSettings, reporterSettingsKey } from './reporter-settings';
import { SNAPSHOT_MAX_READS, SNAPSHOT_STARTER, type LinearSnapshot } from './snapshot';
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
/** A row that fails this many times is failed for good. */
export const MAX_TRIES = 5;

/** The line that starts a run; only a trigger, the brief carries what to do. */
export const REPORTER_STARTER = 'Report the pending Linear updates.';

const ALLOWED_BY_RULE = "10db's reporter rule allows this call.";
const SESSION_OVER = 'This reporter run is over; nothing it calls is recorded.';

export interface LinearReporter {
  /** Startup pickup: arms a timer per task with pending rows. */
  start(): void;
  /** Cancels timers; leaves rows as they are; never awaits the engine. */
  stop(): Promise<void>;
  /** A row was enqueued. */
  poke(taskId: TaskId): void;
  /** `report_linear_post`, from a reporter session only. */
  reportPost(sessionId: SessionId, input: ReportLinearPostInput): { ok: true };
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
    readonly linearPrefixes: readonly string[];
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
}

/** One run, from its trigger to its settle. */
interface Flight {
  readonly taskId: TaskId;
  readonly projectId: ProjectId;
  readonly conversationId: ConversationId;
  sessionId: SessionId | null;
  /** The rows due when the run was triggered: what fails when the session never takes any. */
  readonly due: ReadonlySet<LinearPostId>;
  taken: ReadonlySet<LinearPostId>;
  /** Rows the session reported failed; the settle leaves them be. */
  readonly failedByAgent: Set<LinearPostId>;
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
  const bySession = new Map<SessionId, Flight>();
  const byConversation = new Map<ConversationId, Flight>();
  /** The zero-delay timers that retire a settled run's conversation and re-arm its task. */
  const afters = new Set<Timer>();
  let stopped = false;
  /** Read again after an await, where the compiler has narrowed `stopped`. */
  const halted = (): boolean => stopped;

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
          MAX_TRIES,
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
    const timer = clock.setTimeout(
      () => {
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
      },
      Math.max(0, due - clock.now().getTime()),
    );
    timers.set(taskId, timer);
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
    // An unchecked row is a maybe (after a restart) and goes ahead.
    if (row?.via === LinearVia.None && !row.unchecked) {
      fail(
        due,
        row.note ??
          "This account's agent has no Linear. Connect Linear under Settings › Integrations.",
      );
      refreshCard(task.projectId);
      arm(taskId);
      return;
    }
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
      due: new Set(due.map((p) => p.id)),
      snapshot,
      reads: 0,
      taken: new Set(),
      failedByAgent: new Set(),
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
   * Ends the run once: its taken rows still pending become withheld when the guard withheld a write, and
   * fail otherwise. The conversation is retired, and the task re-armed, off the engine's effect chain.
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
      settleRows(flight, reason);
    }
    if (flight.sessionId !== null) bySession.delete(flight.sessionId);
    flights.delete(flight.taskId);
    byConversation.delete(flight.conversationId);
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
        if (text !== undefined) return { kind: 'read', text };
      } catch (error) {
        log.error({ err: error, taskId: flight.taskId }, 'a snapshot run could not be read back');
      }
      return { kind: 'missing', reason: 'the session answered with nothing' };
    }
    return { kind: 'missing', reason };
  };

  const settleRows = (flight: Flight, reason: string): void => {
    try {
      const guard = flight.guard;
      // What the session took; when it never got that far, what was due when the run was triggered.
      const owned = flight.taken.size > 0 ? flight.taken : flight.due;
      const open = pendingLinearPosts(state.db, { taskId: flight.taskId }).filter(
        (p) => owned.has(p.id) && !flight.failedByAgent.has(p.id),
      );
      const [pattern] = guard === null ? [] : [...guard.withheld];
      if (pattern !== undefined)
        state.write((ctx) => {
          recordLinearPosts(
            ctx,
            open.map((p) => p.id),
            { state: 'withheld', pattern },
          );
        });
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
          arm(flight.taskId);
        });
    }, 0);
    afters.add(after);
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
      return Promise.resolve();
    },

    poke: arm,

    async snapshot(taskId) {
      const link = linearLinkOf(state.db, taskId)?.link;
      if (link === undefined) return null;
      const missing = (reason: string): LinearSnapshot => ({ kind: 'missing', reason });
      try {
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
          prUrl: null,
          uploads: [],
          withheld: new Set(),
        };
        flight.sessionId = input.sessionId;
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
        prUrl: taskPrUrl(state.db, flight.taskId),
        uploads: [],
        withheld: new Set(),
      };
      flight.sessionId = input.sessionId;
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

    reportPost(sessionId, input) {
      const { flight, guard } = runOf(sessionId);
      const foreign = input.postIds.filter((id) => !flight.taken.has(id));
      if (foreign.length > 0)
        throw new ConflictError('Those updates were not given to this session.');
      if (input.outcome.state === 'withheld' && !guard.withheld.has(input.outcome.pattern))
        throw new ConflictError('No write of this run was refused for that pattern.');
      const { outcome } = input;
      // A row dropped meanwhile is skipped by the store: no error.
      if (outcome.state === 'failed') {
        // A row the agent already failed this run is not failed again, so a loop can't spend its tries.
        const rows = pendingLinearPosts(state.db, { taskId: flight.taskId }).filter(
          (p) => input.postIds.includes(p.id) && !flight.failedByAgent.has(p.id),
        );
        fail(rows, outcome.reason);
        for (const row of rows) flight.failedByAgent.add(row.id);
        refreshCard(flight.projectId);
        return { ok: true };
      }
      state.write((ctx) => {
        recordLinearPosts(ctx, input.postIds, outcome);
      });
      refreshCard(flight.projectId);
      return { ok: true };
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
      if (judged.withheld !== undefined) flight.guard.withheld.add(judged.withheld);
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
      refreshCard(projectId);
    },
  };
}
