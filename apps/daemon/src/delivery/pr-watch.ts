import {
  EventType,
  PullRequestChecks,
  PullRequestMergeBlocked,
  PullRequestState,
  type BatchDto,
  type BatchId,
  type ProjectId,
  type PullRequestStatusDto,
  type RequiredCheckJobDto,
  type RequiredChecksDto,
} from '@10db/contracts';
import {
  clearBatchNotice,
  findOpenByFoldKey,
  getBatch,
  listProjects,
  listWatchedPullRequests,
  patchBatch,
  recordPullRequestStatus,
  setBatchNotice,
  type BatchPatch,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import type { Clock, Timer } from '../clock';
import type { EventBus } from '../events';
import {
  GhError,
  GhFailure,
  MergeBlocked,
  PrMergeable,
  PrState,
  type PullRequestStatus,
  type RequiredChecks,
} from '../github';
import { prCardKey, prCards, detailOf } from './cards';
import { startCiFix } from './ci-fix';
import { clearCiStop, endFixesOfEndedPullRequests, type FixEnds } from './ci-stop';
import { ghCall, raiseIn, rewriteIn, withdrawIn, type DeliveryContext } from './context';
import {
  baseNotices,
  cancelledNotices,
  ciNotices,
  NOTICE_KEY,
  rerunNoticeHead,
  rerunNotices,
  type CancelledWhy,
} from './notices';

/** How often the watch reads every followed pull request. */
const PR_WATCH_INTERVAL_MS = 2 * 60_000;

/**
 * How long a head may have no check, while GitHub waits for a required one, before 10db takes the
 * runs for lost. A workflow starts within seconds of a push, so this leaves room for a busy queue.
 */
const CHECKS_START_MS = 10 * 60_000;
/** GitHub's refusal of `gh run rerun` on a run still in progress ("This workflow is already running"). */
const RUN_STILL_RUNNING = /already running/i;

/** Longest reason kept on a batch: it is shown in the UI. */
const MAX_REASON = 500;

/**
 * Failures of gh itself rather than of one pull request's read: every later read in the round would
 * fail the same way, or wait as long (a connection that times out takes as long for each). One ends
 * the round, so offline costs one wait, not one per pull request. Any other failure (`failed`: an
 * error GitHub answered with, about this pull request or for this read) leaves only its own pull
 * request unknown, and the round goes on.
 */
const GH_DOWN: ReadonlySet<GhFailure> = new Set([
  GhFailure.SignedOut,
  GhFailure.NotInstalled,
  GhFailure.Timeout,
  GhFailure.Unreachable,
  GhFailure.Aborted,
]);

export const ghDown = (error: unknown): boolean =>
  error instanceof GhError && GH_DOWN.has(error.kind);

export interface PrWatch {
  /** Reads every followed pull request now, then every interval. */
  start(): void;
  /** Reads again soon, such as right after a batch shipped. A poke during a round queues one more. */
  poke(): void;
  /**
   * The gh card's Check again: pokes, and the next round that finds gh down raises a fresh gh card
   * if none is open, though every pull request it reads was unknown already. The answered card has
   * closed by then, and without this nothing would say gh still fails.
   */
  recheck(): void;
  /** Stops the timer, aborts the gh call in flight and waits for the round to end. */
  stop(): Promise<void>;
  /** Settles once no round is running. */
  idle(): Promise<void>;
}

export interface RetryMergeOptions {
  readonly catchUpCardWasOpen?: boolean;
}

/** What the watch asks of the shipper for a pull request that merges by itself (`Shipper`). */
export interface PullRequestLanding {
  /** The open pull request conflicts with its base. */
  catchUp(batchId: BatchId): void;
  /**
   * The open pull request's head has had minutes to get its required checks and has none at all:
   * merges the base into the pull request and pushes it, so GitHub starts its workflows on a new head.
   * Pushes nothing when checks have appeared since.
   */
  restartCi(batchId: BatchId): void;
  /**
   * The open pull request is clean: a merge GitHub refused, or one 10db just pushed to, is asked again.
   * `catchUpCardWasOpen`: this round withdrew the card for a catch-up that stopped, so a merge is due.
   */
  retryMerge(batchId: BatchId, opts?: RetryMergeOptions): void;
}

const STATE_OF: Record<PrState, PullRequestState> = {
  [PrState.Open]: PullRequestState.Open,
  [PrState.Merged]: PullRequestState.Merged,
  [PrState.Closed]: PullRequestState.Closed,
};

/** A read gh gave no answer to; it is stored at the round's end, together with the gh card. */
interface Unanswered {
  readonly batch: BatchDto;
  readonly next: PullRequestStatusDto;
}

/**
 * The shipped batches that share one pull request: the batch that opened it (the root, which has no
 * `ciFixOf`) and the fix batches made for its failing checks. One read of the pull request serves
 * them all; the required checks and merge state are stored on the root alone.
 */
interface PullRequestGroup {
  readonly root: BatchDto;
  readonly members: readonly BatchDto[];
}

/** The watched batches grouped by pull request, in the order each pull request's first batch appears. */
function groupByPullRequest(batches: readonly BatchDto[]): PullRequestGroup[] {
  const byUrl = new Map<string, BatchDto[]>();
  for (const batch of batches) {
    const key = batch.prUrl ?? batch.id;
    byUrl.set(key, [...(byUrl.get(key) ?? []), batch]);
  }
  return [...byUrl.values()].flatMap((members) => {
    const root = members.find((member) => member.ciFixOf === null) ?? members[0];
    return root ? [{ root, members }] : [];
  });
}

/** The groups in watch order, starting after the one holding `after` while it is still watched. */
function startingAfter(
  groups: readonly PullRequestGroup[],
  after: BatchId | null,
): PullRequestGroup[] {
  const at =
    after === null ? -1 : groups.findIndex((g) => g.members.some((batch) => batch.id === after));
  return [...groups.slice(at + 1), ...groups.slice(0, at + 1)];
}

/** What the watch stores of a pull request's required checks. */
function requiredOf(read: RequiredChecks): RequiredChecksDto {
  const dto = (job: RequiredChecks['failing'][number]): RequiredCheckJobDto => ({
    name: job.name,
    link: job.link,
    jobId: job.jobId,
    runId: job.runId,
    description: job.description,
  });
  return {
    state: read.state,
    failing: read.failing.map(dto),
    pending: read.pending.map(dto),
    cancelled: read.cancelled.map(dto),
  };
}

/**
 * Where a pull request's cancelled required check stands, for one head. In memory: a restart starts
 * from the stored rerun notice (the head 10db ran again) and the stored cancelled notice instead.
 */
interface CancelledRun {
  readonly head: string | null;
  /** Reads in a row that listed a cancelled check, before 10db ran it again. */
  streak: number;
  /** 10db ran the cancelled check(s) again, and when. */
  asked: boolean;
  askedAt: number;
  /** A read after the rerun listed no cancelled check: the rerun took, so a cancellation now is a second one. */
  active: boolean;
  /** The notice is shown. */
  notified: boolean;
}

/**
 * Follows the pull request of every shipped batch (decision `2026-10-29-pull-request-watch`): one
 * gh call at a time, on the injected clock, outside the delivery job queues so that ship and cut
 * never wait on it. It records each read on the batch and raises a card only when the stored status
 * changes, in the same write, so a restart or a dismissed card never raises again and a status is
 * never stored without its card. It never rejects.
 */
export function createPrWatch(input: {
  readonly ctx: DeliveryContext;
  readonly clock: Clock;
  readonly intervalMs?: number;
  /**
   * Runs at the end of every round, also one that read nothing: the work that follows what the round
   * learned, such as deleting the branch of a pull request that merged. A rejection is logged.
   */
  readonly afterRound?: (signal: AbortSignal) => Promise<void>;
  /**
   * Starts a fix when a pull request's required check fails, saving the failing job's full log under
   * `dataDir`. Without it the watch only reads and records.
   */
  readonly ciFix?: { readonly dataDir: string };
  /**
   * Ends a fix whose pull request merged or closed while it was OPEN or FAILED: cancels each live
   * member through the runner, then abandons the batch through the shipper. Without it a fix runs on.
   */
  readonly endFixes?: FixEnds;
  /**
   * Lands the pull requests of batches that merge by themselves: brings the base into one that
   * conflicts with it, and merges one again that GitHub refused earlier. Without it a conflict is a
   * notice for the builder to resolve on GitHub.
   */
  readonly landing?: PullRequestLanding;
}): PrWatch {
  const { ctx, clock, afterRound, ciFix, endFixes, landing } = input;
  const intervalMs = input.intervalMs ?? PR_WATCH_INTERVAL_MS;
  const logger = ctx.logger.child({ module: 'pr-watch' });
  const controller = new AbortController();
  let timer: Timer | null = null;
  let current: Promise<void> | null = null;
  let again = false;
  let started = false;
  let stopped = false;
  /**
   * The batch whose read ended the last round, which the next round reads last: a pull request
   * whose read always ends a round (one that always times out) can't keep the others unread.
   */
  let resumeAfter: BatchId | null = null;
  /**
   * Each pull request whose head has no check while GitHub waits for a required one: the head, when
   * the watch first saw it so, and whether the shipper was asked to start CI again. In memory: a
   * restart counts the minutes again.
   */
  const awaitingRuns = new Map<BatchId, { head: string | null; since: number; asked: boolean }>();
  /** Each open pull request with a cancelled required check, by its root batch. */
  const cancelledRuns = new Map<BatchId, CancelledRun>();
  /**
   * The head each pull request was in the merge queue at, by root batch. A queue that lets go of a
   * pull request still at that head, with the pull request open, has removed it; one that lets go of
   * a pull request at another head was pushed over. In memory: the stored `queued` mark is what a
   * restart reads, and it has no head, so a pull request with no entry counts as unpushed.
   */
  const queuedAt = new Map<BatchId, string | null>();
  /** The head each pull request the queue removed failed at, by root batch: it reads as a failed required check. */
  const removedAt = new Map<BatchId, string | null>();
  /** Set by `recheck`; the next round to start takes it, so a round already running leaves it. */
  let recheckDue = false;

  const now = (): string => clock.now().toISOString();

  /**
   * A read that could not say where the pull request stands. The last known checks are kept, so a
   * failed read is not a transition: a dismissed failing-checks card stays dismissed when gh
   * answers again with the same checks.
   */
  function unknown(batch: BatchDto, reason: string): PullRequestStatusDto {
    return {
      state: PullRequestState.Unknown,
      checks: batch.pr?.checks ?? PullRequestChecks.Unknown,
      failingChecks: batch.pr?.failingChecks ?? [],
      checkedAt: now(),
      unknownReason: reason.slice(0, MAX_REASON),
    };
  }

  function answer(batch: BatchDto, read: PullRequestStatus | null): PullRequestStatusDto {
    if (read === null)
      return unknown(
        batch,
        `GitHub has no pull request at ${batch.prUrl ?? '(none)'} that gh can see. It, or its repository, may be deleted or closed to gh's account.`,
      );
    return {
      state: STATE_OF[read.state],
      checks: read.checks,
      failingChecks: read.failingChecks,
      checkedAt: now(),
      unknownReason: null,
    };
  }

  /**
   * Stores `next` and acts on the change from what was stored before, in the caller's write. A
   * batch that shares its pull request with its root passes `cards: false`: the root raises the
   * cards, so none is raised twice.
   */
  function record(
    write: WriteContext,
    batch: BatchDto,
    next: PullRequestStatusDto,
    cards = true,
  ): void {
    recordPullRequestStatus(write, batch.id, next);
    if (!cards) return;
    const wasChecks = batch.pr?.checks ?? null;
    const wasState = batch.pr?.state ?? null;
    if (next.state === PullRequestState.Open && next.checks === PullRequestChecks.Failing) {
      const card = prCards.checksFailed(batch, next.failingChecks);
      if (wasChecks !== PullRequestChecks.Failing) raiseIn(write, batch.projectId, card);
      // An open card names the checks that fail now and links their latest runs, however they
      // changed since it was raised; a dismissed one stays dismissed.
      rewriteIn(write, batch.projectId, card);
    } else if (
      // An unknown read keeps the last known checks, so it says nothing new about them.
      next.state !== PullRequestState.Unknown &&
      (next.state === PullRequestState.Merged ||
        next.state === PullRequestState.Closed ||
        next.checks === PullRequestChecks.Passing ||
        // Right after a push GitHub can list no checks until the new runs appear, so one read of
        // none is not enough to say the failing checks are gone.
        (next.checks === PullRequestChecks.None && wasChecks === PullRequestChecks.None))
    ) {
      withdrawIn(write, batch.projectId, [prCardKey.checks(batch.id)]);
    }
    if (next.state === PullRequestState.Closed && wasState !== PullRequestState.Closed)
      raiseIn(write, batch.projectId, prCards.closed(batch));
  }

  /**
   * Keeps the batch's conflict notice in step with what GitHub says of the open pull request, in the
   * caller's write: a pull request that merges cleanly has no conflict to show (the builder resolved
   * it, or Update branch did), and one that conflicts says so on its tasks, without a card. A notice
   * the gate wrote already is kept, and GitHub still working it out changes nothing.
   */
  function followConflict(
    write: WriteContext,
    batch: BatchDto,
    read: PullRequestStatus | null,
  ): void {
    if (read?.state !== PrState.Open) return;
    if (read.mergeable === PrMergeable.Mergeable)
      clearBatchNotice(write, batch.id, NOTICE_KEY.baseConflict);
    else if (read.mergeable === PrMergeable.Conflicting) {
      const now = getBatch(write.tx, batch.id);
      // 10db brings the base in itself: it says so, or raises its one card, instead of this notice.
      if (landing !== undefined && now.autoMerge && now.ciFixOf === null) return;
      if (!now.notices.some((n) => n.key === NOTICE_KEY.baseConflict))
        setBatchNotice(write, batch.id, baseNotices.shippedConflict(now));
    }
  }

  /**
   * The projects with an open gh card. It is one card per daemon, but fold keys are per project
   * and the card's project can drop out of the watch (its last pull request merged) while the card
   * is open, so look in every project, not only the ones this round read.
   */
  function ghCardProjects(db: DbReader): ProjectId[] {
    return listProjects(db)
      .map((project) => project.id)
      .filter((id) => findOpenByFoldKey(db, id, prCardKey.ghUnavailable) !== undefined);
  }

  /**
   * Stores the reads gh gave no answer to with what they say about gh, in one write. gh is down
   * when a failure of gh itself ended the round, or when no read in it answered: then an open gh
   * card says how gh fails now, or one is raised in the project of the first pull request this
   * round turned unknown. A round gh answered with nothing down withdraws the card. `recheck`: the
   * builder answered the gh card's Check again, so the first pull request gh gave no answer to raises
   * the card, though it was unknown already.
   */
  function settle(
    unanswered: readonly Unanswered[],
    down: { readonly error: unknown } | null,
    answered: boolean,
    recheck: boolean,
  ): void {
    if (unanswered.length === 0 && (!answered || ghCardProjects(ctx.state.db).length === 0)) return;
    ctx.state.write((write) => {
      for (const { batch, next } of unanswered) record(write, batch, next);
      const open = ghCardProjects(write.tx);
      if (down !== null) {
        for (const id of open) rewriteIn(write, id, prCards.ghUnavailableText(down.error));
        const first = recheck
          ? unanswered[0]
          : unanswered.find(({ batch }) => batch.pr?.state !== PullRequestState.Unknown);
        if (open.length === 0 && first !== undefined)
          raiseIn(write, first.batch.projectId, prCards.ghUnavailable(first.batch, down.error));
      } else if (answered) {
        for (const id of open) withdrawIn(write, id, [prCardKey.ghUnavailable]);
      }
    });
  }

  /**
   * Stores what the round read of an open pull request's required checks and of why GitHub will not
   * merge it, on the root batch only and only when that changes what the root holds. A merged or closed
   * pull request has no merge to block; its stored required checks stay, for "Merged · CI passed".
   * A required read gh could not answer (`required` null) leaves the stored checks as they were.
   * `queue`: whether the pull request is in the merge queue, null when that read gave no answer
   * (the stored mark then stays). A queued pull request is stored as `queued`, whatever else
   * GitHub says of its merge state.
   */
  function storeRequired(
    write: WriteContext,
    root: BatchDto,
    read: PullRequestStatus,
    required: RequiredChecks | null,
    queue: boolean | null,
  ): void {
    const now = getBatch(write.tx, root.id);
    let blocked: PullRequestMergeBlocked | null = null;
    if (read.state === PrState.Open) {
      const queued =
        queue === true || (queue === null && now.prMergeBlocked === PullRequestMergeBlocked.Queued);
      blocked = queued ? PullRequestMergeBlocked.Queued : read.mergeBlocked;
    }
    const nextRequired = required === null ? now.prRequired : requiredOf(required);
    const patch: BatchPatch = {
      ...(JSON.stringify(nextRequired) === JSON.stringify(now.prRequired)
        ? {}
        : { prRequired: nextRequired }),
      ...(blocked === now.prMergeBlocked ? {} : { prMergeBlocked: blocked }),
    };
    if (Object.keys(patch).length > 0) patchBatch(write, root.id, patch);
    // A stop ends when the checks pass or run again (a rerun, or a commit someone pushed), or when
    // the pull request merges or closes. The same write closes its card.
    if (
      now.ciStopped !== null &&
      (read.state !== PrState.Open ||
        required?.state === 'passing' ||
        required?.state === 'pending')
    )
      clearCiStop(write, root.id);
  }

  /**
   * Follows an open pull request through its base's merge queue, and returns the required checks the
   * round goes on with. A pull request in the queue is left alone (the caller pushes and starts
   * nothing for it). One the queue let go of while it is open and still at the head it was queued at has
   * been removed, as when its merge group failed: that reads as a failed required check, `Merge queue`,
   * with no job log to read (so 10db stops fixing with its card, and the task is Blocked), for as long
   * as the head is the one that failed. A new head, pushed by anyone, is read as its own checks say.
   * `queue` null: the read gave no answer, and nothing changes.
   */
  function followQueue(
    root: BatchDto,
    read: PullRequestStatus | null,
    required: RequiredChecks | null,
    queue: boolean | null,
  ): RequiredChecks | null {
    if (read?.state !== PrState.Open) {
      queuedAt.delete(root.id);
      removedAt.delete(root.id);
      return required;
    }
    if (queue === null) return required;
    if (queue) {
      queuedAt.set(root.id, read.headSha);
      removedAt.delete(root.id);
      return required;
    }
    const was = root.prMergeBlocked === PullRequestMergeBlocked.Queued || queuedAt.has(root.id);
    const head = queuedAt.has(root.id) ? queuedAt.get(root.id) : read.headSha;
    queuedAt.delete(root.id);
    if (was && head === read.headSha) removedAt.set(root.id, read.headSha);
    else if (removedAt.has(root.id) && removedAt.get(root.id) !== read.headSha)
      removedAt.delete(root.id);
    if (required === null || required.state === 'failing' || !removedAt.has(root.id))
      return required;
    const removal: RequiredChecks['failing'][number] = {
      name: 'Merge queue',
      link: root.prUrl,
      jobId: null,
      runId: null,
      description:
        'GitHub removed the pull request from the merge queue, as when the queue’s merge group failed',
    };
    return { ...required, state: 'failing', failing: [removal] };
  }

  /**
   * Follows a pull request whose head has no check at all while GitHub holds it for a required one:
   * its workflows never started, as when GitHub could not build the merge ref at push time and so
   * skipped them. The minutes a head gets for its runs to appear count from when the watch first saw
   * it so. Then it asks the shipper once to start CI again (a merge of the base pushed onto the pull
   * request) and gives the head that comes of it the same minutes; a head still without checks then,
   * or one the shipper may not push to, shows a notice on the batch. A pull request with any check on
   * its head is never asked for anything, and the notice goes when one appears.
   */
  function followMissingRuns(
    root: BatchDto,
    read: PullRequestStatus | null,
    required: RequiredChecks | null,
    queue: boolean | null,
  ): void {
    // A read that gave no answer says nothing: the count and the notice stay as they are.
    if (read === null) return;
    // The count and the notice end only when a check appears on the head, the pull request is no
    // longer open, or it conflicts (the catch-up for conflicts takes over). Or it is in the merge
    // queue (BLOCKED with its checks pending is the queue's waiting, not a head whose runs never
    // started, and a push would take it out of the queue), or the queue read gave no answer.
    const over =
      queue !== false ||
      read.state !== PrState.Open ||
      root.ciFixOf !== null ||
      read.checks !== PullRequestChecks.None ||
      (required !== null && required.state !== 'none') ||
      read.mergeBlocked === MergeBlocked.Conflicts ||
      read.mergeable === PrMergeable.Conflicting;
    // Any other read that is not BLOCKED on checks is ambiguous: GitHub reports UNKNOWN for a while
    // after each push and whenever the base moves. It neither counts nor resets.
    const missing =
      !over && required !== null && read.blockedOnChecks && read.mergeBlocked === null;
    if (!over && !missing) return;
    if (over) {
      awaitingRuns.delete(root.id);
      if (
        getBatch(ctx.state.db, root.id).notices.some((n) => n.key === NOTICE_KEY.checksNeverStarted)
      )
        ctx.state.write((write) => clearBatchNotice(write, root.id, NOTICE_KEY.checksNeverStarted));
      return;
    }
    const at = clock.now().getTime();
    const seen = awaitingRuns.get(root.id);
    const waiting = (seen?.head === read.headSha ? seen : undefined) ?? {
      head: read.headSha,
      since: at,
      asked: seen?.asked ?? false,
    };
    awaitingRuns.set(root.id, waiting);
    if (at - waiting.since < CHECKS_START_MS) return;
    if (!waiting.asked && landing !== undefined && root.autoMerge) {
      waiting.asked = true;
      waiting.since = at;
      landing.restartCi(root.id);
      return;
    }
    ctx.state.write((write) => {
      const now = getBatch(write.tx, root.id);
      if (!now.notices.some((n) => n.key === NOTICE_KEY.checksNeverStarted))
        setBatchNotice(write, root.id, ciNotices.neverStarted(now));
    });
  }

  /** Shows the cancelled-check notice on the batch, naming each check with its link. */
  function noticeCancelled(root: BatchDto, checks: RequiredChecks['cancelled'], why: CancelledWhy) {
    ctx.state.write((write) => {
      const now = getBatch(write.tx, root.id);
      setBatchNotice(write, root.id, cancelledNotices.stuck(now, checks, why));
    });
  }

  function clearCancelledNotice(rootId: BatchId): void {
    if (getBatch(ctx.state.db, rootId).notices.some((n) => n.key === NOTICE_KEY.checksCancelled))
      ctx.state.write((write) => clearBatchNotice(write, rootId, NOTICE_KEY.checksCancelled));
  }

  /**
   * Takes off the batch the notices that say 10db ran a cancelled check again, except the one for
   * `keepHead`. They are the stored record of a rerun, read back after a restart.
   */
  function clearRerunNotices(rootId: BatchId, keepHead: string | null): void {
    const stale = getBatch(ctx.state.db, rootId).notices.filter((n) => {
      const head = rerunNoticeHead(n.key);
      return head !== null && head !== keepHead;
    });
    if (stale.length === 0) return;
    ctx.state.write((write) => {
      for (const n of stale) clearBatchNotice(write, rootId, n.key);
    });
  }

  /**
   * Follows an open pull request's cancelled required checks (a runner problem, say, or a run
   * GitHub stopped). A cancelled check is its own state, never pending: nothing runs for it, and the
   * pull request cannot merge. The second read in a row that lists one (a newer push's run replaces
   * a superseded one within minutes, and rerunning that old run could cancel the new one) runs its
   * Actions run again, once for the head. While another job of that run is still running, GitHub
   * refuses the rerun, so 10db waits for the run to finish before it counts a read. It is never run a second time: a check cancelled again after it ran
   * (or still cancelled 10 minutes after the rerun) shows a notice naming the check and its link, as
   * does a check with no Actions run to start. The notice goes when no check is cancelled. A failing
   * required check, a conflict and a pull request that is no longer open leave all of it alone.
   * Throws gh's failure only when gh itself is down, so the next round asks again.
   */
  async function followCancelled(
    root: BatchDto,
    read: PullRequestStatus | null,
    required: RequiredChecks | null,
    queue: boolean | null,
    signal: AbortSignal,
  ): Promise<void> {
    if (read === null || required === null) return;
    if (
      read.state !== PrState.Open ||
      root.ciFixOf !== null ||
      read.mergeBlocked === MergeBlocked.Conflicts ||
      read.mergeable === PrMergeable.Conflicting
    ) {
      cancelledRuns.delete(root.id);
      clearCancelledNotice(root.id);
      clearRerunNotices(root.id, null);
      return;
    }
    // A pull request in the merge queue (or one whose queue read gave no answer) is left as it is: a
    // rerun would start a run on its head while the queue holds it. The count resumes after the queue.
    if (queue !== false) return;
    // A failing check starts a fix, which pushes a new head: the cancelled one is not the question.
    if (required.state === 'failing') return;
    const cancelled = required.cancelled;
    const storedNotices = getBatch(ctx.state.db, root.id).notices;
    // The rerun is stored on the batch, so a daemon that restarted after it reads the head as asked.
    clearRerunNotices(root.id, read.headSha);
    let seen = cancelledRuns.get(root.id);
    if (
      seen === undefined &&
      read.headSha !== null &&
      storedNotices.some((n) => rerunNoticeHead(n.key) === read.headSha)
    ) {
      seen = {
        head: read.headSha,
        streak: 0,
        asked: true,
        // The time of the rerun isn't stored: the minutes a run gets to start count from this read.
        askedAt: clock.now().getTime(),
        active: false,
        notified: storedNotices.some((n) => n.key === NOTICE_KEY.checksCancelled),
      };
      cancelledRuns.set(root.id, seen);
    }
    const sameHead = seen?.head === read.headSha;
    if (cancelled.length === 0) {
      if (seen !== undefined && sameHead) {
        // Rerun: it took. Not rerun: the cancellation went away by itself (a newer run).
        if (seen.asked) seen.active = true;
        else seen.streak = 0;
        seen.notified = false;
      } else cancelledRuns.delete(root.id);
      clearCancelledNotice(root.id);
      return;
    }
    const stored = getBatch(ctx.state.db, root.id).notices.some(
      (n) => n.key === NOTICE_KEY.checksCancelled,
    );
    let track: CancelledRun;
    if (seen !== undefined && sameHead) track = seen;
    else {
      // A new head starts over. After a restart the stored notice says 10db is done with this head.
      if (seen !== undefined) clearCancelledNotice(root.id);
      const restarted = seen === undefined && stored;
      track = {
        head: read.headSha,
        streak: 0,
        asked: restarted,
        askedAt: 0,
        active: false,
        notified: restarted,
      };
    }
    cancelledRuns.set(root.id, track);
    if (track.notified) return;
    const at = clock.now().getTime();
    if (track.asked) {
      if (track.active || at - track.askedAt >= CHECKS_START_MS) {
        track.notified = true;
        noticeCancelled(root, cancelled, { kind: 'again' });
      }
      return;
    }
    const runs = [...new Set(cancelled.flatMap((job) => (job.runId === null ? [] : [job.runId])))];
    // GitHub refuses to rerun a run that is still in progress (another of its jobs is running), so
    // the cancelled one waits for its run to finish: no read counts, nothing is rerun or shown.
    if (required.pending.some((job) => job.runId !== null && runs.includes(job.runId))) return;
    track.streak += 1;
    if (track.streak < 2) return;
    const repo = root.repo;
    // A check with no Actions run (a commit status from another CI) has nothing 10db can run.
    if (repo === null || cancelled.some((job) => job.runId === null)) {
      track.notified = true;
      noticeCancelled(root, cancelled, { kind: 'no_run' });
      return;
    }
    try {
      for (const runId of runs) await ctx.gh.rerunFailed({ repo, runId }, ghCall(ctx, signal));
    } catch (error) {
      if (controller.signal.aborted || ghDown(error)) throw error;
      // The run is still going (a job gh doesn't list as required, say): ask again next round.
      if (RUN_STILL_RUNNING.test(detailOf(error))) return;
      logger.warn(
        { batchId: root.id, err: detailOf(error) },
        'could not run a cancelled check again',
      );
      track.notified = true;
      noticeCancelled(root, cancelled, { kind: 'refused', detail: detailOf(error) });
      return;
    }
    track.asked = true;
    track.askedAt = at;
    track.active = false;
    // Stored right after the rerun: a restart before any notice must not run this head a second time.
    if (read.headSha !== null) {
      const headSha = read.headSha;
      ctx.state.write((write) => {
        setBatchNotice(write, root.id, rerunNotices.ran(headSha, cancelled));
      });
    }
  }

  async function round(signal: AbortSignal): Promise<void> {
    await readAll(signal);
    // After the reads, so a merge or close this round recorded ends its fixes in the same round.
    if (endFixes !== undefined && !signal.aborted)
      await endFixesOfEndedPullRequests(ctx, endFixes, signal);
  }

  async function readAll(signal: AbortSignal): Promise<void> {
    const recheck = recheckDue;
    recheckDue = false;
    const groups = startingAfter(
      groupByPullRequest(listWatchedPullRequests(ctx.state.db)),
      resumeAfter,
    );
    if (groups.length === 0) return;
    const unanswered: Unanswered[] = [];
    let ended: { readonly error: unknown; readonly at: BatchId } | null = null;
    let failed: { readonly error: unknown } | null = null;
    let answered = false;
    // One pull request is read once, whoever shares it: a root batch and its fix batches.
    for (const { root, members } of groups) {
      if (signal.aborted) return;
      if (ended !== null) {
        for (const batch of members)
          unanswered.push({ batch, next: unknown(batch, detailOf(ended.error)) });
        continue;
      }
      const repo = members.find((batch) => batch.repo !== null)?.repo ?? null;
      if (repo === null || root.prUrl === null) {
        ctx.state.write((write) => {
          for (const batch of members)
            record(
              write,
              batch,
              unknown(batch, `10db has no repository recorded for "${batch.title}"`),
              batch.id === root.id,
            );
        });
        continue;
      }
      let read: PullRequestStatus | null;
      try {
        read = await ctx.gh.prStatus({ repo, ref: root.prUrl }, ghCall(ctx, signal));
      } catch (error) {
        // Stopped: record nothing, the next daemon asks again.
        if (controller.signal.aborted) return;
        logger.warn({ batchId: root.id, err: detailOf(error) }, 'gh pr view failed');
        if (ghDown(error)) ended = { error, at: root.id };
        else failed ??= { error };
        for (const batch of members)
          unanswered.push({ batch, next: unknown(batch, detailOf(error)) });
        continue;
      }
      answered = true;
      // The checks GitHub requires of an open pull request's base. A read that fails leaves what the
      // root holds: the status read above is still true.
      let required: RequiredChecks | null = null;
      if (read?.state === PrState.Open) {
        try {
          required = await ctx.gh.prRequiredChecks({ repo, url: root.prUrl }, ghCall(ctx, signal));
        } catch (error) {
          if (controller.signal.aborted) return;
          logger.warn({ batchId: root.id, err: detailOf(error) }, 'gh pr checks failed');
          if (ghDown(error)) ended = { error, at: root.id };
        }
      }
      // Whether the open pull request waits in its base's merge queue (null: unread, or not open). A
      // push to its branch takes it out of the queue, so while it is queued or unread nothing below
      // pushes to it, starts a watchdog or reruns a check for it.
      let queue: boolean | null = null;
      if (read?.state === PrState.Open) {
        try {
          queue = await ctx.gh.prInMergeQueue({ repo, url: root.prUrl }, ghCall(ctx, signal));
        } catch (error) {
          if (controller.signal.aborted) return;
          logger.warn({ batchId: root.id, err: detailOf(error) }, 'gh api graphql failed');
          if (ghDown(error)) ended = { error, at: root.id };
        }
      }
      // A pull request the queue removed reads as a failed required check.
      required = followQueue(root, read, required, queue);
      // Whether this round withdrew the catch-up card: the stored sign that the merge is still to ask.
      let catchUpCardWasOpen = false;
      ctx.state.write((write) => {
        for (const batch of members) {
          record(write, batch, answer(batch, read), batch.id === root.id);
          followConflict(write, batch, read);
        }
        if (read !== null) storeRequired(write, root, read, required, queue);
        // The catch-up card closes when the pull request merges cleanly or is gone. Not while it is
        // behind: the merge below is asked only of a clean one, and the card is what says it is due.
        if (
          read !== null &&
          (read.state !== PrState.Open ||
            (read.mergeable === PrMergeable.Mergeable && read.mergeBlocked === null))
        ) {
          const key = prCardKey.catchUp(root.id);
          catchUpCardWasOpen = findOpenByFoldKey(write.tx, root.projectId, key) !== undefined;
          withdrawIn(write, root.projectId, [key]);
        }
      });
      if (
        landing !== undefined &&
        read?.state === PrState.Open &&
        queue === false &&
        root.ciFixOf === null &&
        root.autoMerge
      ) {
        if (
          read.mergeBlocked === MergeBlocked.Conflicts ||
          read.mergeable === PrMergeable.Conflicting
        )
          landing.catchUp(root.id);
        else if (read.mergeable === PrMergeable.Mergeable && read.mergeBlocked === null)
          landing.retryMerge(root.id, { catchUpCardWasOpen });
      }
      followMissingRuns(root, read, required, queue);
      try {
        await followCancelled(root, read, required, queue, signal);
      } catch (error) {
        if (controller.signal.aborted) return;
        logger.warn(
          { batchId: root.id, err: detailOf(error) },
          'could not follow a cancelled check',
        );
        if (ghDown(error)) ended = { error, at: root.id };
      }
      // A pull request that conflicts runs no workflow, so its failing checks are stale.
      if (
        ciFix !== undefined &&
        ended === null &&
        root.ciFixOf === null &&
        read?.state === PrState.Open &&
        queue === false &&
        read.mergeBlocked !== MergeBlocked.Conflicts &&
        required !== null &&
        required.state === 'failing'
      ) {
        try {
          await startCiFix({
            ctx,
            dataDir: ciFix.dataDir,
            root,
            required: requiredOf(required),
            head: read.headSha,
            signal,
          });
        } catch (error) {
          if (controller.signal.aborted) return;
          logger.warn({ batchId: root.id, err: detailOf(error) }, 'could not start a CI fix');
          if (ghDown(error)) ended = { error, at: root.id };
        }
      }
    }
    resumeAfter = ended?.at ?? null;
    settle(unanswered, ended ?? (answered ? null : failed), answered, recheck);
  }

  function arm(): void {
    if (stopped) return;
    timer = clock.setTimeout(() => {
      timer = null;
      begin();
    }, intervalMs);
  }

  function begin(): void {
    if (stopped) return;
    if (current !== null) {
      again = true;
      return;
    }
    timer?.cancel();
    timer = null;
    current = (async () => {
      try {
        await round(controller.signal);
      } catch (error) {
        logger.error({ err: detailOf(error) }, 'pull request watch round failed');
      }
      // Also after a round that failed: what earlier rounds learned still waits to be acted on, and a
      // pull request that breaks the round must not keep a merged one's branch for ever.
      try {
        await afterRound?.(controller.signal);
      } catch (error) {
        logger.error({ err: detailOf(error) }, 'after-round work failed');
      }
      current = null;
      if (again) {
        again = false;
        begin();
      } else {
        arm();
      }
    })();
  }

  async function idle(): Promise<void> {
    while (current !== null) await current;
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      begin();
    },
    poke() {
      if (started) begin();
    },
    recheck() {
      if (!started || stopped) return;
      recheckDue = true;
      begin();
    },
    async stop() {
      stopped = true;
      timer?.cancel();
      timer = null;
      controller.abort();
      await idle();
    },
    idle,
  };
}

/** Reads a batch event that moved a batch to SHIPPED, and pokes the watch so the new pull request is read at once. */
export function subscribePrWatch(bus: EventBus, watch: Pick<PrWatch, 'poke'>): () => void {
  return bus.subscribe((event) => {
    if (event.type === EventType.BatchUpdated && event.data['to'] === 'SHIPPED') watch.poke();
  });
}
