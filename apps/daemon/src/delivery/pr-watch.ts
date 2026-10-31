import {
  EventType,
  PullRequestChecks,
  PullRequestState,
  type BatchDto,
  type BatchId,
  type ProjectId,
  type PullRequestStatusDto,
} from '@10db/contracts';
import {
  clearBatchNotice,
  findOpenByFoldKey,
  getBatch,
  listProjects,
  listWatchedPullRequests,
  recordPullRequestStatus,
  setBatchNotice,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import type { Clock, Timer } from '../clock';
import type { EventBus } from '../events';
import { GhError, GhFailure, PrMergeable, PrState, type PullRequestStatus } from '../github';
import { prCardKey, prCards, detailOf } from './cards';
import { ghCall, raiseIn, rewriteIn, withdrawIn, type DeliveryContext } from './context';
import { baseNotices, NOTICE_KEY } from './notices';

/** How often the watch reads every followed pull request. */
const PR_WATCH_INTERVAL_MS = 2 * 60_000;

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
  /** Stops the timer, aborts the gh call in flight and waits for the round to end. */
  stop(): Promise<void>;
  /** Settles once no round is running. */
  idle(): Promise<void>;
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

/** The batches in watch order, starting after `after` while it is still watched. */
function startingAfter(batches: readonly BatchDto[], after: BatchId | null): BatchDto[] {
  const at = after === null ? -1 : batches.findIndex((batch) => batch.id === after);
  return [...batches.slice(at + 1), ...batches.slice(0, at + 1)];
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
}): PrWatch {
  const { ctx, clock, afterRound } = input;
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

  /** Stores `next` and acts on the change from what was stored before, in the caller's write. */
  function record(write: WriteContext, batch: BatchDto, next: PullRequestStatusDto): void {
    const wasChecks = batch.pr?.checks ?? null;
    const wasState = batch.pr?.state ?? null;
    recordPullRequestStatus(write, batch.id, next);
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
   * round turned unknown. A round gh answered with nothing down withdraws the card.
   */
  function settle(
    unanswered: readonly Unanswered[],
    down: { readonly error: unknown } | null,
    answered: boolean,
  ): void {
    if (unanswered.length === 0 && (!answered || ghCardProjects(ctx.state.db).length === 0)) return;
    ctx.state.write((write) => {
      for (const { batch, next } of unanswered) record(write, batch, next);
      const open = ghCardProjects(write.tx);
      if (down !== null) {
        for (const id of open) rewriteIn(write, id, prCards.ghUnavailableText(down.error));
        const first = unanswered.find(({ batch }) => batch.pr?.state !== PullRequestState.Unknown);
        if (open.length === 0 && first !== undefined)
          raiseIn(write, first.batch.projectId, prCards.ghUnavailable(first.batch, down.error));
      } else if (answered) {
        for (const id of open) withdrawIn(write, id, [prCardKey.ghUnavailable]);
      }
    });
  }

  async function round(signal: AbortSignal): Promise<void> {
    const batches = startingAfter(listWatchedPullRequests(ctx.state.db), resumeAfter);
    if (batches.length === 0) return;
    const unanswered: Unanswered[] = [];
    let ended: { readonly error: unknown; readonly at: BatchId } | null = null;
    let failed: { readonly error: unknown } | null = null;
    let answered = false;
    for (const batch of batches) {
      if (signal.aborted) return;
      if (ended !== null) {
        unanswered.push({ batch, next: unknown(batch, detailOf(ended.error)) });
        continue;
      }
      if (batch.repo === null || batch.prUrl === null) {
        const next = unknown(batch, `10db has no repository recorded for "${batch.title}"`);
        ctx.state.write((write) => {
          record(write, batch, next);
        });
        continue;
      }
      let read: PullRequestStatus | null;
      try {
        read = await ctx.gh.prStatus({ repo: batch.repo, ref: batch.prUrl }, ghCall(ctx, signal));
      } catch (error) {
        // Stopped: record nothing, the next daemon asks again.
        if (controller.signal.aborted) return;
        logger.warn({ batchId: batch.id, err: detailOf(error) }, 'gh pr view failed');
        if (ghDown(error)) ended = { error, at: batch.id };
        else failed ??= { error };
        unanswered.push({ batch, next: unknown(batch, detailOf(error)) });
        continue;
      }
      answered = true;
      const next = answer(batch, read);
      ctx.state.write((write) => {
        record(write, batch, next);
        followConflict(write, batch, read);
      });
    }
    resumeAfter = ended?.at ?? null;
    settle(unanswered, ended ?? (answered ? null : failed), answered);
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
