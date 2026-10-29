import {
  EventType,
  PullRequestChecks,
  PullRequestState,
  type BatchDto,
  type ProjectId,
  type PullRequestStatusDto,
} from '@10db/contracts';
import {
  findOpenByFoldKey,
  listProjects,
  listWatchedPullRequests,
  recordPullRequestStatus,
} from '@10db/db';
import type { Clock, Timer } from '../clock';
import type { EventBus } from '../events';
import { PrState } from '../github';
import { prCardKey, prCards, detailOf } from './cards';
import { ghCall, raise, withdraw, type DeliveryContext } from './context';

/** How often the watch reads every followed pull request. */
const PR_WATCH_INTERVAL_MS = 2 * 60_000;

/** Longest reason kept on a batch: it is shown in the UI. */
const MAX_REASON = 500;

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

/**
 * Follows the pull request of every shipped batch (decision `2026-10-29-pull-request-watch`): one
 * gh call at a time, on the injected clock, outside the delivery job queues so that ship and cut
 * never wait on it. It records each read on the batch and raises a card only when the stored status
 * changes, so a restart or a dismissed card never raises again. It never rejects.
 */
export function createPrWatch(input: {
  readonly ctx: DeliveryContext;
  readonly clock: Clock;
  readonly intervalMs?: number;
}): PrWatch {
  const { ctx, clock } = input;
  const intervalMs = input.intervalMs ?? PR_WATCH_INTERVAL_MS;
  const logger = ctx.logger.child({ module: 'pr-watch' });
  const controller = new AbortController();
  let timer: Timer | null = null;
  let current: Promise<void> | null = null;
  let again = false;
  let started = false;
  let stopped = false;

  /**
   * A read that could not say where the pull request stands. The last known checks are kept, so a
   * failed read is not a transition: a dismissed failing-checks card stays dismissed when gh
   * answers again with the same checks.
   */
  function unknown(batch: BatchDto, now: string, reason: string): PullRequestStatusDto {
    return {
      state: PullRequestState.Unknown,
      checks: batch.pr?.checks ?? PullRequestChecks.Unknown,
      failingChecks: batch.pr?.failingChecks ?? [],
      checkedAt: now,
      unknownReason: reason.slice(0, MAX_REASON),
    };
  }

  /** Stores `next` and acts on the change from what was stored before. */
  function record(batch: BatchDto, next: PullRequestStatusDto): void {
    const before = batch.pr;
    ctx.state.write((write) => recordPullRequestStatus(write, batch.id, next));
    const wasChecks = before?.checks ?? null;
    const wasState = before?.state ?? null;
    if (next.state === PullRequestState.Open && next.checks === PullRequestChecks.Failing) {
      if (wasChecks !== PullRequestChecks.Failing)
        raise(ctx.inbox, batch.projectId, prCards.checksFailed(batch, next.failingChecks));
    } else if (
      next.state === PullRequestState.Merged ||
      next.state === PullRequestState.Closed ||
      next.checks === PullRequestChecks.Passing ||
      next.checks === PullRequestChecks.None
    ) {
      withdraw(ctx.state, ctx.inbox, batch.projectId, [prCardKey.checks(batch.id)]);
    }
    if (next.state === PullRequestState.Closed && wasState !== PullRequestState.Closed)
      raise(ctx.inbox, batch.projectId, prCards.closed(batch));
  }

  async function round(signal: AbortSignal): Promise<void> {
    const batches = listWatchedPullRequests(ctx.state.db);
    if (batches.length === 0) return;
    let failure: { readonly error: unknown } | null = null;
    let answered = false;
    let firstUnknown: BatchDto | null = null;
    for (const batch of batches) {
      if (signal.aborted) return;
      const now = clock.now().toISOString();
      let next: PullRequestStatusDto;
      if (failure === null) {
        try {
          if (batch.repo === null || batch.prUrl === null) {
            next = unknown(batch, now, `10db has no repository recorded for "${batch.title}"`);
          } else {
            const read = await ctx.gh.prStatus(
              { repo: batch.repo, ref: batch.prUrl },
              ghCall(ctx, signal),
            );
            answered = true;
            next =
              read === null
                ? unknown(batch, now, `GitHub has no pull request at ${batch.prUrl}`)
                : {
                    state: STATE_OF[read.state],
                    checks: read.checks,
                    failingChecks: read.failingChecks,
                    checkedAt: now,
                    unknownReason: null,
                  };
          }
        } catch (error) {
          // Stopped: record nothing, the next daemon asks again.
          if (controller.signal.aborted) return;
          failure = { error };
          logger.warn({ batchId: batch.id, err: detailOf(error) }, 'gh pr view failed');
          next = unknown(batch, now, detailOf(error));
        }
      } else {
        // One failure ends the round: offline costs one timeout, not one per pull request.
        next = unknown(batch, now, detailOf(failure.error));
      }
      record(batch, next);
      if (
        failure !== null &&
        firstUnknown === null &&
        next.state === PullRequestState.Unknown &&
        batch.pr?.state !== PullRequestState.Unknown
      )
        firstUnknown = batch;
    }
    if (failure !== null && firstUnknown !== null && ghCardProjects().length === 0)
      raise(ctx.inbox, firstUnknown.projectId, prCards.ghUnavailable(firstUnknown, failure.error));
    // Only a round gh answered in full says gh works again: a half round leaves batches unknown.
    if (answered && failure === null)
      for (const id of ghCardProjects())
        withdraw(ctx.state, ctx.inbox, id, [prCardKey.ghUnavailable]);
  }

  /**
   * The projects with an open gh card. It is one card per daemon, but fold keys are per project
   * and the card's project can drop out of the watch (its last pull request merged) while the card
   * is open, so look in every project, not only the ones this round read.
   */
  function ghCardProjects(): ProjectId[] {
    return listProjects(ctx.state.db)
      .map((project) => project.id)
      .filter((id) => findOpenByFoldKey(ctx.state.db, id, prCardKey.ghUnavailable) !== undefined);
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
