import {
  EventType,
  PassState,
  PullRequestChecks,
  type FailingCheckDto,
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
  getPass,
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
import { classifyCiFailures } from './ci-failure-class';
import { startCiFix } from './ci-fix';
import { CHECKS_START_MS, ciRerunStep } from './ci-rerun';
import { queuePassSettle, settleClosedPass } from './pass-settle';
import { recordPassPullRequest, watchedAsPass } from './pass-watch';
import {
  clearCiStop,
  deleteCiOutOfMoves,
  endFixesOfEndedPullRequests,
  raiseCiOutOfMovesWhenDue,
  readCiOutOfMoves,
  type FixEnds,
} from './ci-stop';
import { ghCall, postIn, raiseIn, rewriteIn, withdrawIn, type DeliveryContext } from './context';
import { clearGuardrailHold } from './guardrail-hold-card';
import { withdrawHeldCards } from './watchpoint-hold';
import {
  baseNotices,
  cancelledNoticeHead,
  cancelledNoticeKind,
  cancelledNotices,
  ciNotices,
  EMPTY_NO_RUNNER,
  FailedRerunOutcome,
  failedRerunHead,
  failedRerunNotices,
  failedRerunRecord,
  NOTICE_KEY,
  noRunnerNoticeHead,
  noRunnerNotices,
  noRunnerRecord,
  rerunNoticeHead,
  rerunNotices,
  rerunRecord,
  waitingOnBaseHead,
  waitingOnBaseNotice,
  waitingOnBaseRecord,
  type CancelledWhy,
  type FailedRerunRecord,
  type NoRunnerRecord,
  type RerunRuns,
  type WaitingOnBaseRecord,
} from './notices';

/** How often the watch reads every followed pull request. */
const PR_WATCH_INTERVAL_MS = 2 * 60_000;

/** GitHub's refusal of `gh run rerun` on a run still in progress ("This workflow is already running"). */
const RUN_STILL_RUNNING = /already running/i;

/**
 * How many times 10db runs a job again that GitHub cancelled for want of a runner, for one head of a
 * pull request. A shortage of macOS runners can last hours; past this the builder is told once.
 */
const MAX_RUNNER_RERUNS = 3;
/** How long a pull request waits on a base that fails its checks before the failure counts as its own. */
const BASE_WAIT_MS = 60 * 60_000;
/**
 * How long, in minutes, a shortage of runners is given before each rerun, by the reruns made so far,
 * and after the last one before the builder is told. A shortage comes in bursts of hours, so a rerun
 * at once lands inside the same burst.
 */
const RUNNER_BACKOFF_MINUTES = [10, 20, 40, 20] as const;

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
   * Pushes nothing when checks have appeared since. Returns false when the shipper holds the ask (a
   * drain for an update is on) and did nothing: the watch counts it as not asked and asks again.
   */
  restartCi(batchId: BatchId): boolean;
  /**
   * The open pull request failed required checks the base failed too, and the base passes them
   * again: merges the base into it and pushes it, so its checks run on a new head. Returns false
   * when the shipper holds the ask (a drain is on): the watch asks again next round.
   */
  catchUpToBase(batchId: BatchId): boolean;
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
  /**
   * The Actions runs GitHub took a rerun of for this head, each with the checks it reran: a refusal
   * of another run never repeats them, and the stored record names only these checks.
   */
  readonly rerun: Map<string, readonly { readonly name: string }[]>;
  /**
   * The stored rerun notice is an older one with no record of its runs: every run of this head
   * counts as run, since 10db can't tell which it took and a head is never run a second time.
   */
  readonly everyRunAsked: boolean;
  /** A read after the rerun listed no cancelled check: the rerun took, so a cancellation now is a second one. */
  active: boolean;
  /**
   * The notice shown, if any. 'stopped': 10db could not run a check, so it asks nothing more until
   * the checks clear. 'again': 10db ran the checks it names, and it still runs one it has not run.
   */
  notice: 'again' | 'stopped' | null;
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
  /** Whether GitHub cancelled each Actions job (by job id) for want of a runner: a job's record never changes. */
  const noRunnerJobs = new Map<string, boolean>();
  /** The required checks that failed on a pull request's head: one that then passes there was flaky. */
  const failedOnHead = new Map<BatchId, { readonly head: string; readonly names: Set<string> }>();
  /** When a head's runner shortage was first seen, or last rerun: the backoff counts from it. */
  const noRunnerSince = new Map<BatchId, { readonly head: string; readonly at: number }>();
  /**
   * The open pull requests whose failing required checks fail on their base too, by root batch: no
   * fix starts for them, and when the base passes again their checks start over.
   */
  const waitingOnBase = new Map<
    BatchId,
    {
      readonly projectId: ProjectId;
      readonly repo: string;
      readonly branch: string;
      readonly head: string;
      readonly checks: readonly string[];
    }
  >();
  /**
   * The batches whose failing spell has no checks card yet because the base's card covers every
   * failing check; the card is raised when a check fails that the base does not.
   */
  const heldBack = new Set<BatchId>();
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
    /** The failing checks the card names; empty when the base's card covers every one. */
    cardChecks: readonly FailingCheckDto[] = next.failingChecks,
  ): void {
    recordPullRequestStatus(write, batch.id, next);
    if (!cards) return;
    const wasChecks = batch.pr?.checks ?? null;
    const wasState = batch.pr?.state ?? null;
    if (
      next.state !== PullRequestState.Unknown &&
      !(next.state === PullRequestState.Open && next.checks === PullRequestChecks.Failing)
    )
      heldBack.delete(batch.id);
    if (next.state === PullRequestState.Open && next.checks === PullRequestChecks.Failing) {
      // A stopped fix's card names the failing checks and stands in for this one.
      const stopped = getBatch(write.tx, batch.id).ciStopped !== null;
      if (!stopped && cardChecks.length > 0) {
        const card = prCards.checksFailed(batch, cardChecks);
        // A failing spell raises its card once. A spell the base alone held back raises it when
        // the pull request's own check fails; a card dismissed since stays dismissed.
        if (wasChecks !== PullRequestChecks.Failing || heldBack.delete(batch.id))
          raiseIn(write, batch.projectId, card);
        // An open card names the checks that fail now and links their latest runs, however they
        // changed since it was raised.
        rewriteIn(write, batch.projectId, card);
      } else if (!stopped) heldBack.add(batch.id);
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
    // The builder's Drop It closed it, so it needs no card saying so.
    if (
      next.state === PullRequestState.Closed &&
      wasState !== PullRequestState.Closed &&
      !readCiOutOfMoves(write.tx, batch.id).dropped
    )
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
      // A restart the shipper holds (a drain is on) stays unasked: no count, no notice, and the
      // first round after the hold ends asks it.
      if (landing.restartCi(root.id)) {
        waiting.asked = true;
        waiting.since = at;
      }
      return;
    }
    ctx.state.write((write) => {
      const now = getBatch(write.tx, root.id);
      if (!now.notices.some((n) => n.key === NOTICE_KEY.checksNeverStarted))
        setBatchNotice(write, root.id, ciNotices.neverStarted(now));
    });
  }

  /** Shows the cancelled-check notice on the batch, naming each check with its link. */
  function noticeCancelled(
    root: BatchDto,
    checks: RequiredChecks['cancelled'],
    why: CancelledWhy,
    head: string | null,
  ) {
    ctx.state.write((write) => {
      const now = getBatch(write.tx, root.id);
      setBatchNotice(write, root.id, cancelledNotices.stuck(now, checks, why, head));
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
   * Rewrites the stored rerun notice of `head` to say `state`, when it records runs GitHub took and
   * still leaves one to ask for (not done): the notice names a notice beside it or says what 10db
   * will do, and that stops being true when 10db stops at a check it cannot run, or the check it
   * stopped at clears. A head 10db finished asking for keeps its notice, which says neither.
   */
  function rewriteRerunNotice(
    rootId: BatchId,
    head: string | null,
    runs: RerunRuns,
    state: 'stopped' | 'cleared',
  ): void {
    if (head === null) return;
    const stored = getBatch(ctx.state.db, rootId).notices.find(
      (n) => rerunNoticeHead(n.key) === head,
    );
    if (stored === undefined || (rerunRecord(stored)?.done ?? true)) return;
    ctx.state.write((write) => {
      setBatchNotice(write, rootId, rerunNotices.ran(head, runs, state));
    });
  }

  /**
   * Follows an open pull request's cancelled required checks (a runner problem, say, or a run
   * GitHub stopped). A cancelled check is its own state, never pending: nothing runs for it, and the
   * pull request cannot merge. The second read in a row that lists one (a newer push's run replaces
   * a superseded one within minutes, and rerunning that old run could cancel the new one) runs its
   * Actions run again, once for the head. While another job of that run is still running, GitHub
   * refuses the rerun, so 10db waits for the run to finish before it counts a read. A run is never
   * run a second time: a check cancelled again after it ran (or still cancelled 10 minutes after the
   * rerun) shows a notice naming the check and its link, as does a check with no Actions run to
   * start. A check whose run was not in the rerun gets its own, by the same rule, so a notice that
   * says 10db ran a check is only ever about a run GitHub took. The notice goes when no check is
   * cancelled, also when a required check fails instead. A failing required check with a check still
   * cancelled, a conflict and a pull request that is no longer open leave all of it alone.
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
    const cancelled = required.cancelled;
    // A failing check starts a fix, which pushes a new head: a cancelled one beside it is not the
    // question, and nothing is rerun or shown. With none cancelled the read carries on only to correct
    // what is stored (the rerun notice, the cancelled-check notice): it returns before any rerun.
    if (required.state === 'failing' && cancelled.length > 0) return;
    // A cancelled notice stored for another head names that head's checks: it is gone once the pull
    // request moves on, so it neither stops 10db nor stays up for the new head.
    const storedCancelled = getBatch(ctx.state.db, root.id).notices.find(
      (n) => n.key === NOTICE_KEY.checksCancelled,
    );
    // A notice with no head (stored by a daemon from before the record field) is left alone: the
    // batch stores no head of its pull request to compare it with, so it is read as 'stopped' below
    // and goes when the checks clear. Rerunning on a guess could run a head's check twice.
    const storedFor = storedCancelled === undefined ? null : cancelledNoticeHead(storedCancelled);
    if (storedFor !== null && storedFor !== read.headSha) clearCancelledNotice(root.id);
    const storedNotices = getBatch(ctx.state.db, root.id).notices;
    // The rerun is stored on the batch, so a daemon that restarted after it reads the head as asked.
    clearRerunNotices(root.id, read.headSha);
    let seen = cancelledRuns.get(root.id);
    const storedRerun =
      seen === undefined && read.headSha !== null
        ? storedNotices.find((n) => rerunNoticeHead(n.key) === read.headSha)
        : undefined;
    if (storedRerun !== undefined && read.headSha !== null) {
      const record = rerunRecord(storedRerun);
      const partial = record !== null && !record.done;
      const shown = storedNotices.find((n) => n.key === NOTICE_KEY.checksCancelled);
      // The kind is stored with the notice. One stored by an older daemon has none: a partial
      // rerun that shows a notice then stopped at a run GitHub refused outright.
      const shownKind = (shown && cancelledNoticeKind(shown)) ?? (partial ? 'stopped' : 'again');
      seen = {
        head: read.headSha,
        // A rerun that left a run to ask for already counted its reads: the next one asks again.
        streak: partial ? 1 : 0,
        asked: !partial,
        // The time of the rerun isn't stored: the minutes a run gets to start count from this read.
        askedAt: clock.now().getTime(),
        // The runs GitHub took are never run again; a partial record leaves the rest to ask for.
        rerun: record === null ? new Map<string, { name: string }[]>() : record.runs,
        everyRunAsked: record === null,
        active: false,
        notice: shown === undefined ? null : shownKind,
      };
      cancelledRuns.set(root.id, seen);
    }
    const sameHead = seen?.head === read.headSha;
    if (cancelled.length === 0) {
      if (seen !== undefined && sameHead) {
        // Rerun: it took. Not rerun: the cancellation went away by itself (a newer run).
        if (seen.asked) seen.active = true;
        seen.streak = 0;
        // A rerun notice that still left a run to ask for named the notice beside it, or said 10db
        // runs the rest as soon as GitHub allows (the run finished by itself): neither holds now.
        rewriteRerunNotice(root.id, read.headSha, seen.rerun, 'cleared');
        seen.notice = null;
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
      // A new head starts over. After a restart a stored notice with no rerun record is one 10db
      // stopped at without running anything: it stands, and only a stored rerun record counts as asked.
      if (seen !== undefined) clearCancelledNotice(root.id);
      track = {
        head: read.headSha,
        streak: 0,
        asked: false,
        askedAt: 0,
        rerun: new Map(),
        everyRunAsked: false,
        active: false,
        notice: seen === undefined && stored ? 'stopped' : null,
      };
    }
    cancelledRuns.set(root.id, track);
    // The checks whose run 10db has not run for this head. Only the others may be called cancelled again.
    const notRun = track.everyRunAsked
      ? []
      : cancelled.filter((job) => job.runId === null || !track.rerun.has(job.runId));
    if (track.notice === 'stopped' || (track.notice === 'again' && notRun.length === 0)) return;
    const at = clock.now().getTime();
    if (track.asked && notRun.length === 0) {
      track.streak = 0;
      if (track.active || at - track.askedAt >= CHECKS_START_MS) {
        track.notice = 'again';
        noticeCancelled(root, cancelled, { kind: 'again' }, read.headSha);
      }
      return;
    }
    const runs = [...new Set(notRun.flatMap((job) => (job.runId === null ? [] : [job.runId])))];
    // GitHub refuses to rerun a run that is still in progress (another of its jobs is running), so
    // the cancelled one waits for its run to finish: no read counts, nothing is rerun or shown.
    if (required.pending.some((job) => job.runId !== null && runs.includes(job.runId))) return;
    track.streak += 1;
    if (track.streak < 2) return;
    const repo = root.repo;
    // A check with no Actions run (a commit status from another CI) has nothing 10db can run.
    if (repo === null || notRun.some((job) => job.runId === null)) {
      track.notice = 'stopped';
      // A run refused as still running is not asked for now: the rerun notice stops saying it is.
      rewriteRerunNotice(root.id, read.headSha, track.rerun, 'stopped');
      noticeCancelled(root, notRun, { kind: 'no_run' }, read.headSha);
      return;
    }
    // Stored as soon as GitHub takes each run, before the next call: a daemon killed between two
    // reruns must not run this head a second time. It names only the checks GitHub took, over every
    // round, since a check it took stops being listed as cancelled once it runs.
    const storeRerun = (state: 'asking' | 'refused' | 'done'): void => {
      if (read.headSha === null) return;
      const headSha = read.headSha;
      ctx.state.write((write) => {
        setBatchNotice(write, root.id, rerunNotices.ran(headSha, track.rerun, state));
      });
    };
    // A run GitHub took earlier this head is never in `runs`, whichever run it refused after it.
    for (const runId of runs) {
      try {
        await ctx.gh.rerunFailed({ repo, runId }, ghCall(ctx, signal));
      } catch (error) {
        if (controller.signal.aborted || ghDown(error)) throw error;
        // The run is still going (a job gh doesn't list as required, say): ask again next round.
        if (RUN_STILL_RUNNING.test(detailOf(error))) return;
        logger.warn(
          { batchId: root.id, err: detailOf(error) },
          'could not run a cancelled check again',
        );
        track.notice = 'stopped';
        // The runs GitHub took stay on record as not done, so a restart does not read the head as
        // fully asked, but the notice stops saying 10db will ask for the refused one.
        if (track.rerun.size > 0) storeRerun('refused');
        const notTaken = notRun.filter((job) => job.runId === null || !track.rerun.has(job.runId));
        noticeCancelled(root, notTaken, { kind: 'refused', detail: detailOf(error) }, read.headSha);
        return;
      }
      track.rerun.set(
        runId,
        cancelled.filter((job) => job.runId === runId),
      );
      storeRerun('asking');
    }
    // Every run is asked for: the record says so, so a restart does not ask again.
    storeRerun('done');
    track.asked = true;
    track.askedAt = at;
    track.active = false;
    // A check cancelled from here on starts from its first read, and a notice shown before this
    // rerun names checks it did not run: the minutes after it decide what to say.
    track.streak = 0;
    track.notice = null;
  }

  /** Takes off the notices of runner-shortage reruns for any head but `keepHead`, and the card that went with them. */
  function clearNoRunner(rootId: BatchId, keepHead: string | null): void {
    const root = getBatch(ctx.state.db, rootId);
    const stale = root.notices.filter((n) => {
      const head = noRunnerNoticeHead(n.key);
      return head !== null && head !== keepHead;
    });
    const carded = findOpenByFoldKey(ctx.state.db, root.projectId, prCardKey.noRunner(rootId));
    if (stale.length === 0 && (keepHead !== null || carded === undefined)) return;
    ctx.state.write((write) => {
      for (const n of stale) clearBatchNotice(write, rootId, n.key);
      if (stale.length > 0 || keepHead === null)
        withdrawIn(write, root.projectId, [prCardKey.noRunner(rootId)]);
    });
  }

  /** Whether GitHub cancelled the job for want of a runner. A job's record never changes, so it is read once. */
  async function hadNoRunner(
    repo: string,
    jobId: string,
    rootId: BatchId,
    signal: AbortSignal,
  ): Promise<boolean> {
    const known = noRunnerJobs.get(jobId);
    if (known !== undefined) return known;
    try {
      const answer = await ctx.gh.jobHadNoRunner({ repo, jobId }, ghCall(ctx, signal));
      noRunnerJobs.set(jobId, answer);
      return answer;
    } catch (error) {
      if (controller.signal.aborted || ghDown(error)) throw error;
      // Not read, so the job is an ordinary cancelled check for now and is looked at again next round.
      logger.warn(
        { batchId: rootId, jobId, err: detailOf(error) },
        'could not read a cancelled job',
      );
      return false;
    }
  }

  /**
   * Runs again a required job GitHub cancelled because no hosted runner picked it up (the job has no
   * runner, no steps and the annotation "not acquired by Runner of type hosted"): a shortage of
   * runners, not a failure of the code, so no CI fix starts and no card is raised until the limit.
   * Reruns it after a backoff (`RUNNER_BACKOFF_MINUTES`), up to `MAX_RUNNER_RERUNS` for one head of the pull request; the count is the
   * stored notice's record, so a restart keeps it and a new head starts from zero. Still stuck a
   * last wait after the limit, it raises one card naming the job and the attempts. A cancelled job that had a runner or ran a step,
   * and a run a person cancelled, are no case of this and stay for `followCancelled`. Returns the
   * required checks without the jobs it dealt with. Throws gh's failure only when gh itself is down.
   */
  async function followNoRunner(
    root: BatchDto,
    read: PullRequestStatus | null,
    required: RequiredChecks | null,
    queue: boolean | null,
    signal: AbortSignal,
  ): Promise<RequiredChecks | null> {
    if (read === null) return required;
    if (read.state !== PrState.Open || root.ciFixOf !== null) {
      clearNoRunner(root.id, null);
      return required;
    }
    if (required === null) return required;
    const repo = root.repo;
    const head = read.headSha;
    if (
      repo === null ||
      head === null ||
      queue !== false ||
      required.cancelled.length === 0 ||
      read.mergeBlocked === MergeBlocked.Conflicts ||
      read.mergeable === PrMergeable.Conflicting ||
      // A failing check starts a fix that pushes a new head: a cancelled job beside it is not the question.
      required.state === 'failing'
    ) {
      if (head !== null) clearNoRunner(root.id, head);
      return required;
    }
    clearNoRunner(root.id, head);
    const stored = getBatch(ctx.state.db, root.id).notices.find(
      (n) => noRunnerNoticeHead(n.key) === head,
    );
    const record = (stored && noRunnerRecord(stored)) ?? EMPTY_NO_RUNNER;
    const shortage: RequiredChecks['cancelled'] = [];
    const others: RequiredChecks['cancelled'] = [];
    for (const job of required.cancelled) {
      const isShortage =
        job.jobId !== null &&
        (record.jobs.includes(job.jobId) || (await hadNoRunner(repo, job.jobId, root.id, signal)));
      (isShortage ? shortage : others).push(job);
    }
    if (shortage.length === 0) return required;
    const rest: RequiredChecks = { ...required, cancelled: others };
    const fresh = shortage.filter((job) => job.jobId !== null && !record.jobs.includes(job.jobId));
    if (fresh.length === 0) return rest;
    const names = [...new Set([...record.names, ...fresh.map((job) => job.name)])];
    const nowMs = clock.now().getTime();
    const since = noRunnerSince.get(root.id);
    if (since?.head !== head) {
      noRunnerSince.set(root.id, { head, at: nowMs });
      return rest;
    }
    const wait = RUNNER_BACKOFF_MINUTES[Math.min(record.attempts, MAX_RUNNER_RERUNS)] ?? 0;
    if (nowMs - since.at < wait * 60_000) return rest;
    if (record.attempts >= MAX_RUNNER_RERUNS) {
      if (record.carded) return rest;
      const next: NoRunnerRecord = { ...record, names, carded: true };
      ctx.state.write((write) => {
        const now = getBatch(write.tx, root.id);
        setBatchNotice(
          write,
          root.id,
          noRunnerNotices.of(head, next, 'stopped', MAX_RUNNER_RERUNS),
        );
        raiseIn(write, root.projectId, prCards.noRunner(now, names, record.attempts));
      });
      return rest;
    }
    const runs = [...new Set(fresh.flatMap((job) => (job.runId === null ? [] : [job.runId])))];
    // GitHub refuses to rerun a run another of whose jobs is still going: wait for it to finish.
    if (required.pending.some((job) => job.runId !== null && runs.includes(job.runId))) return rest;
    let done: NoRunnerRecord = record;
    // Stored as soon as GitHub takes each run, before the next call, so a daemon killed between two
    // reruns does not run this head's job a third time. All the runs of one round are one attempt.
    const store = (state: 'ran' | 'refused', detail = ''): void => {
      ctx.state.write((write) => {
        setBatchNotice(
          write,
          root.id,
          noRunnerNotices.of(head, done, state, MAX_RUNNER_RERUNS, detail),
        );
      });
    };
    for (const runId of runs) {
      const ofRun = fresh.filter((job) => job.runId === runId);
      try {
        await ctx.gh.rerunFailed({ repo, runId }, ghCall(ctx, signal));
      } catch (error) {
        if (controller.signal.aborted || ghDown(error)) throw error;
        // The run is still going (a job gh doesn't list as required, say): ask again next round.
        if (RUN_STILL_RUNNING.test(detailOf(error))) return rest;
        logger.warn(
          { batchId: root.id, err: detailOf(error) },
          'could not rerun a job with no runner',
        );
        // Counted and never asked for again: a refusal that repeated would otherwise ask every round.
        done = {
          ...done,
          attempts: record.attempts + 1,
          jobs: [...done.jobs, ...ofRun.flatMap((job) => (job.jobId === null ? [] : [job.jobId]))],
          names,
        };
        store('refused', detailOf(error));
        continue;
      }
      done = {
        ...done,
        attempts: record.attempts + 1,
        jobs: [...done.jobs, ...ofRun.flatMap((job) => (job.jobId === null ? [] : [job.jobId]))],
        names,
      };
      store('ran');
    }
    noRunnerSince.set(root.id, { head, at: nowMs });
    return rest;
  }

  /**
   * Remembers which required checks failed on the head, and when the same head's checks pass, raises
   * one card per check that failed first, counting how often it did. Cards are per project, so a
   * restart loses only the failure not yet seen to pass.
   */
  function noteFlaky(
    root: BatchDto,
    read: PullRequestStatus | null,
    required: RequiredChecks | null,
  ): void {
    if (read?.state !== PrState.Open || required === null || root.ciFixOf !== null) {
      failedOnHead.delete(root.id);
      return;
    }
    const known = failedOnHead.get(root.id);
    if (read.headSha === null) return;
    if (required.state === 'failing') {
      const entry =
        known?.head === read.headSha ? known : { head: read.headSha, names: new Set<string>() };
      for (const job of required.failing) entry.names.add(job.name);
      failedOnHead.set(root.id, entry);
      return;
    }
    if (required.state !== 'passing' || known?.head !== read.headSha) return;
    failedOnHead.delete(root.id);
    const head = read.headSha;
    // A head whose failed checks 10db ran again is `followFailedRerun`'s: it says which flaked.
    if (getBatch(ctx.state.db, root.id).notices.some((n) => failedRerunHead(n.key) === head))
      return;
    ctx.state.write((write) => {
      for (const name of known.names) countFlaky(write, root, name, head);
    });
  }

  /** Posts the flaky-check notice for `name` in the caller's write: a flake asks nothing of the builder. */
  function countFlaky(write: WriteContext, root: BatchDto, name: string, head: string): void {
    postIn(write, root.projectId, prCards.flakyCheck(name, { head, prUrl: root.prUrl }));
  }

  /** Takes off the failed-check rerun notices for any head but `keepHead`: a new commit starts over. */
  function clearFailedRerun(rootId: BatchId, keepHead: string): void {
    const stale = getBatch(ctx.state.db, rootId).notices.filter((n) => {
      const head = failedRerunHead(n.key);
      return head !== null && head !== keepHead;
    });
    if (stale.length === 0) return;
    ctx.state.write((write) => {
      for (const n of stale) clearBatchNotice(write, rootId, n.key);
    });
  }

  /**
   * Runs a head's failing required checks again once, before a fix starts or the checks card is
   * raised, when the base does not fail them: a flaky test fails one run and passes the next. A check
   * that fails again on the rerun is the change's, as before; one that passes was flaky, and a card
   * names it with the head. The record is stored on the batch as soon as GitHub takes each run, so a
   * restart never runs the head's checks a second time. Returns the names of the checks that wait on
   * the rerun: no fix starts for the pull request and the card leaves them out. Only for a pull
   * request 10db fixes: open, not a fix's, out of the merge queue, with no conflict. A check the base
   * failed, which waited on it, is never rerun here: the wait asks for its run itself. Throws gh's
   * failure only when gh itself is down.
   */
  async function followFailedRerun(
    root: BatchDto,
    read: PullRequestStatus | null,
    required: RequiredChecks | null,
    queue: boolean | null,
    reads: Map<string, Promise<ReadonlySet<string> | null>>,
    signal: AbortSignal,
  ): Promise<ReadonlySet<string>> {
    const held = new Set<string>();
    const repo = root.repo;
    if (
      ciFix === undefined ||
      read?.state !== PrState.Open ||
      root.ciFixOf !== null ||
      required === null ||
      queue !== false ||
      read.mergeBlocked === MergeBlocked.Conflicts ||
      read.mergeable === PrMergeable.Conflicting ||
      repo === null
    )
      return held;
    const head = read.headSha;
    const branch = read.baseRef;
    if (head === null || branch == null) return held;
    clearFailedRerun(root.id, head);
    const notices = getBatch(ctx.state.db, root.id).notices;
    const stored = notices.find((n) => failedRerunHead(n.key) === head);
    const record = stored === undefined ? null : failedRerunRecord(stored);
    // A record that can't be read still says the head was run again: it never is a second time.
    if (stored !== undefined && record === null) return held;
    let change: RequiredCheckJobDto[] = [];
    if (record === null && required.state === 'failing') {
      const waited = notices.find((n) => waitingOnBaseHead(n.key) === head);
      const onBase = new Set(
        waited === undefined ? [] : (waitingOnBaseRecord(waited)?.checks ?? []),
      );
      const base = await readBase(repo, branch, reads, signal);
      // Only an Actions job is run again: its new job id is what says the rerun failed too.
      change = classifyCiFailures(requiredOf(required).failing, base).change.filter(
        (job) => job.runId !== null && job.jobId !== null && !onBase.has(job.name),
      );
    }
    const step = ciRerunStep({
      record,
      change,
      failing: required.failing,
      pending: required.pending,
      cancelled: required.cancelled,
      listed: required.state !== 'none',
      now: clock.now().getTime(),
    });
    const store = (next: FailedRerunRecord, detail?: string): void => {
      ctx.state.write((write) => {
        setBatchNotice(write, root.id, failedRerunNotices.of(head, next, detail));
      });
    };
    switch (step.kind) {
      case 'none':
        return held;
      case 'hold':
        return new Set(step.names);
      case 'failedAgain':
        if (record !== null) store({ ...record, outcome: FailedRerunOutcome.Failed });
        return held;
      case 'flaked':
        if (record === null) return held;
        ctx.state.write((write) => {
          setBatchNotice(
            write,
            root.id,
            failedRerunNotices.of(head, { ...record, outcome: FailedRerunOutcome.Flaked }),
          );
          for (const name of step.names) countFlaky(write, root, name, head);
        });
        return held;
      case 'rerun':
        break;
    }
    const at = clock.now().getTime();
    const taken: string[] = [];
    const ofTaken = (): FailedRerunRecord => {
      const jobs = change.filter((job) => job.runId !== null && taken.includes(job.runId));
      return {
        runs: [...taken],
        jobs: jobs.flatMap((job) => (job.jobId === null ? [] : [job.jobId])),
        names: [...new Set(jobs.map((job) => job.name))],
        at,
        outcome: FailedRerunOutcome.Rerun,
      };
    };
    for (const runId of step.runs) {
      try {
        await ctx.gh.rerunFailed({ repo, runId }, ghCall(ctx, signal));
      } catch (error) {
        if (controller.signal.aborted || ghDown(error)) throw error;
        // The run is still going (a job gh doesn't list as required, say): ask again next round.
        if (RUN_STILL_RUNNING.test(detailOf(error))) {
          if (taken.length === 0) return new Set(change.map((job) => job.name));
          break;
        }
        logger.warn({ batchId: root.id, err: detailOf(error) }, 'could not rerun a failed check');
        // Refused outright: the failure goes on as the change's, and the head is never asked again.
        if (taken.length === 0) {
          store(
            {
              runs: [],
              jobs: [],
              names: [...new Set(change.map((job) => job.name))],
              at,
              outcome: FailedRerunOutcome.Refused,
            },
            detailOf(error),
          );
          return held;
        }
        break;
      }
      taken.push(runId);
      store(ofTaken());
    }
    return new Set(ofTaken().names);
  }

  /**
   * The checks failing on a pull request's base, read once a round per branch; null when the read
   * fails (every failing check then counts as the pull request's own).
   */
  function readBase(
    repo: string,
    branch: string,
    reads: Map<string, Promise<ReadonlySet<string> | null>>,
    signal: AbortSignal,
  ): Promise<ReadonlySet<string> | null> {
    const key = prCardKey.baseRed(repo, branch);
    let read = reads.get(key);
    if (read === undefined) {
      read = ctx.gh
        .baseFailingChecks({ repo, branch }, ghCall(ctx, signal))
        .catch((error: unknown) => {
          if (ghDown(error)) throw error;
          logger.warn({ repo, branch, err: detailOf(error) }, 'could not read the base checks');
          return null;
        });
      reads.set(key, read);
    }
    return read;
  }

  /**
   * Sorts a pull request's failing required checks into the base's and its own. Returns the checks a
   * fix is for, or null while the pull request waits: every failing check fails on the base too, or
   * the base has passed them and the pull request's checks are being run again on a new head.
   * The wait is stored on the batch (a restart keeps it) and ends after `BASE_WAIT_MS` with the
   * base still failing, which makes the failure the pull request's own.
   */
  async function followBase(
    root: BatchDto,
    head: string,
    branch: string | null,
    required: RequiredChecksDto,
    reads: Map<string, Promise<ReadonlySet<string> | null>>,
    signal: AbortSignal,
  ): Promise<RequiredChecksDto | null> {
    if (root.repo === null || branch === null || head === '') return required;
    clearWaitingNotices(root, head);
    const stored = getBatch(ctx.state.db, root.id).notices.find(
      (n) => waitingOnBaseHead(n.key) === head,
    );
    const was = stored === undefined ? null : waitingOnBaseRecord(stored);
    const now = clock.now().getTime();
    const base = await readBase(root.repo, branch, reads, signal);
    const sorted = classifyCiFailures(required.failing, base);
    const names = sorted.base.map((job) => job.name);
    const record: WaitingOnBaseRecord = {
      since: was?.since ?? now,
      checks: was?.checks ?? names,
      asked: was?.asked ?? false,
    };
    const store = (next: WaitingOnBaseRecord): void => {
      ctx.state.write((write) => {
        setBatchNotice(write, root.id, waitingOnBaseNotice(head, branch, next));
      });
    };
    const track = (checks: readonly string[]): void => {
      waitingOnBase.set(root.id, {
        projectId: root.projectId,
        repo: root.repo ?? '',
        branch,
        head,
        checks,
      });
    };
    // A wait that outlived the bound is over: whatever the base does, the failure is this pull request's.
    if (was !== null && now - was.since >= BASE_WAIT_MS) {
      waitingOnBase.delete(root.id);
      return required;
    }
    if (sorted.base.length > 0) {
      if (was?.checks.join() !== names.join()) store({ ...record, checks: names });
      track(names);
      return sorted.change.length === 0 ? null : { ...required, failing: sorted.change };
    }
    // The base passes what this head waited on, which ran before the base's fix.
    if (was !== null && base !== null) {
      waitingOnBase.delete(root.id);
      if (!was.asked) {
        const asked = await askNewHead(root, required, signal);
        if (asked) store({ ...record, asked: true });
      }
      return null;
    }
    waitingOnBase.delete(root.id);
    return required;
  }

  /** Takes the waiting-on-base notices off the batch, except the one for `keepHead`. */
  function clearWaitingNotices(root: BatchDto, keepHead: string | null): void {
    const stale = root.notices.filter((n) => {
      const head = waitingOnBaseHead(n.key);
      return head !== null && head !== keepHead;
    });
    if (stale.length === 0) return;
    ctx.state.write((write) => {
      for (const n of stale) clearBatchNotice(write, root.id, n.key);
    });
  }

  /**
   * Asks for the checks to run on a head that holds the base: the shipper merges the base in and
   * pushes when the batch lands itself; a batch the builder merges has its failed jobs run again.
   * False when nothing was asked (a drain holds the shipper), so the next round asks again.
   */
  async function askNewHead(
    root: BatchDto,
    required: RequiredChecksDto,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (landing !== undefined && root.autoMerge) return landing.catchUpToBase(root.id);
    const repo = root.repo;
    if (repo === null) return false;
    const runs = new Set(
      required.failing.flatMap((job) => (job.runId === null ? [] : [job.runId])),
    );
    for (const runId of runs) {
      try {
        await ctx.gh.rerunFailed({ repo, runId }, ghCall(ctx, signal));
      } catch (error) {
        if (controller.signal.aborted || ghDown(error)) throw error;
        logger.warn({ batchId: root.id, err: detailOf(error) }, 'could not rerun after the base');
      }
    }
    return true;
  }

  /**
   * One card per base branch that blocks pull requests, naming how many wait on it; withdrawn when
   * none waits any more. `seen`: the card key and project of each branch a pull request read this round.
   */
  function syncBaseCards(seen: ReadonlyMap<string, ProjectId>): void {
    const waiting = new Map<
      string,
      { repo: string; branch: string; checks: Set<string>; n: number }
    >();
    for (const { repo, branch, checks } of waitingOnBase.values()) {
      const key = prCardKey.baseRed(repo, branch);
      const entry = waiting.get(key) ?? { repo, branch, checks: new Set<string>(), n: 0 };
      for (const name of checks) entry.checks.add(name);
      entry.n += 1;
      waiting.set(key, entry);
    }
    ctx.state.write((write) => {
      for (const [key, projectId] of seen) {
        const entry = waiting.get(key);
        if (entry === undefined) {
          withdrawIn(write, projectId, [key]);
          continue;
        }
        const card = prCards.baseRed({
          repo: entry.repo,
          branch: entry.branch,
          checks: [...entry.checks],
          waiting: entry.n,
        });
        if (findOpenByFoldKey(write.tx, projectId, key) === undefined)
          raiseIn(write, projectId, card);
        else rewriteIn(write, projectId, card);
      }
    });
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
    // The failing checks of each base read this round, by repository and branch.
    const baseReads = new Map<string, Promise<ReadonlySet<string> | null>>();
    // The base-red card keys of the pull requests read this round, with their project.
    const seenBases = new Map<string, ProjectId>();
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
      // A pass's pull request, while the pass holds its tasks or in a local project, is read for
      // merged and closed only: nothing below runs for it.
      const passId = watchedAsPass(ctx.state.db, root);
      if (passId !== null) {
        ctx.state.write((write) => {
          recordPassPullRequest(write, root, passId, answer(root, read));
        });
        // A local project's settled pass: one stacked on it follows its record's merge or close.
        if (read !== null && getPass(ctx.state.db, passId).state === PassState.Settled)
          queuePassSettle(ctx, passId, settleClosedPass);
        continue;
      }
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
      noteFlaky(root, read, required);
      // The failing checks 10db ran again once and waits on: no fix, and no card names them yet.
      let held: ReadonlySet<string> = new Set();
      try {
        held = await followFailedRerun(root, read, required, queue, baseReads, signal);
      } catch (error) {
        if (controller.signal.aborted) return;
        logger.warn({ batchId: root.id, err: detailOf(error) }, 'could not rerun a failed check');
        if (ghDown(error)) {
          ended = { error, at: root.id };
          // Not run yet: the next round runs them, so this one names them on no card.
          held = new Set(required?.failing.map((job) => job.name) ?? []);
        }
      }
      // Whether this round withdrew the catch-up card: the stored sign that the merge is still to ask.
      let catchUpCardWasOpen = false;
      // A failure the base has too is the base's card (`prCards.baseRed`), not one per pull request.
      let cardChecks: readonly FailingCheckDto[] | undefined;
      if (
        read?.state === PrState.Open &&
        read.checks === PullRequestChecks.Failing &&
        root.repo !== null &&
        read.baseRef != null
      ) {
        try {
          const base = await readBase(root.repo, read.baseRef, baseReads, signal);
          if (base !== null) {
            const own = read.failingChecks.filter((c) => !base.has(c.name));
            // The base's card covers a failure all the base's only when 10db follows the base for this
            // pull request: a fix-capable watch, a required check, no queue, no conflict.
            const covered =
              ciFix !== undefined &&
              root.ciFixOf === null &&
              queue === false &&
              read.mergeBlocked !== MergeBlocked.Conflicts &&
              read.mergeable !== PrMergeable.Conflicting &&
              required?.state === 'failing' &&
              read.failingChecks.every((c) => required.failing.some((job) => job.name === c.name));
            cardChecks = own.length > 0 ? own : covered ? [] : read.failingChecks;
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          if (ghDown(error)) ended = { error, at: root.id };
        }
      }
      // An empty list holds the card back: it is raised if the rerun fails again.
      if (held.size > 0)
        cardChecks = (cardChecks ?? read?.failingChecks ?? []).filter((c) => !held.has(c.name));
      ctx.state.write((write) => {
        for (const batch of members) {
          record(write, batch, answer(batch, read), batch.id === root.id, cardChecks);
          followConflict(write, batch, read);
        }
        if (read !== null) storeRequired(write, root, read, required, queue);
        // Last, after `record` read `dropped` and `clearCiStop` ran: nothing after it re-creates it.
        if (read !== null && read.state !== PrState.Open) {
          deleteCiOutOfMoves(write, root.id);
          // A merged or closed pull request has nothing left to hold: its card and approval go with it.
          clearGuardrailHold(write, root);
          withdrawHeldCards(write, root);
        }
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
      // A closed pass settles, or its Move card says why not, after each read: news once it merged
      // or closed, which is read only once.
      const passEnded =
        read !== null && read.state !== PrState.Open && root.pr?.state !== STATE_OF[read.state];
      if (root.passId != null && read !== null)
        queuePassSettle(ctx, root.passId, (c, id, s) =>
          settleClosedPass(c, id, s, { news: passEnded }),
        );
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
        // A job GitHub cancelled for want of a runner is dealt with first, and the rest go on.
        const rest = await followNoRunner(root, read, required, queue, signal);
        await followCancelled(root, read, rest, queue, signal);
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
          const own = await followBase(
            root,
            read.headSha ?? '',
            read.baseRef,
            requiredOf(required),
            baseReads,
            signal,
          );
          // A check run again once waits for its rerun before any fix.
          if (own !== null && held.size === 0)
            await startCiFix({
              ctx,
              dataDir: ciFix.dataDir,
              root,
              required: own,
              head: read.headSha,
              signal,
            });
        } catch (error) {
          if (controller.signal.aborted) return;
          logger.warn({ batchId: root.id, err: detailOf(error) }, 'could not start a CI fix');
          if (ghDown(error)) ended = { error, at: root.id };
        }
      } else {
        waitingOnBase.delete(root.id);
        clearWaitingNotices(root, null);
      }
      // A stop at the limit or on an unchanged head gets its out-of-moves card once its wait is over.
      if (read?.state === PrState.Open && root.ciFixOf === null) {
        const now = getBatch(ctx.state.db, root.id);
        if (now.ciStopped !== null && now.notices.some((n) => n.key === NOTICE_KEY.ciOutOfMoves))
          ctx.state.write((write) => {
            raiseCiOutOfMovesWhenDue(write, root.id);
          });
      }
      if (root.repo !== null && read?.baseRef != null)
        seenBases.set(prCardKey.baseRed(root.repo, read.baseRef), root.projectId);
    }
    if (ended === null) {
      // A pull request that left the watch (merged, closed, deleted) waits on nothing.
      const watched = new Set(
        groupByPullRequest(listWatchedPullRequests(ctx.state.db)).map((group) => group.root.id),
      );
      for (const [id, entry] of waitingOnBase) {
        if (watched.has(id)) continue;
        waitingOnBase.delete(id);
        seenBases.set(prCardKey.baseRed(entry.repo, entry.branch), entry.projectId);
      }
      syncBaseCards(seenBases);
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
