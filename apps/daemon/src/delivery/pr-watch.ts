import {
  EventType,
  PullRequestChecks,
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
  return { state: read.state, failing: read.failing.map(dto), pending: read.pending.map(dto) };
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
}): PrWatch {
  const { ctx, clock, afterRound, ciFix } = input;
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

  /**
   * Stores what the round read of an open pull request's required checks and of why GitHub will not
   * merge it, on the root batch only and only when that changes what the root holds. A merged or closed
   * pull request has no merge to block; its stored required checks stay, for "Merged · CI passed".
   * A required read gh could not answer (`required` null) leaves the stored checks as they were.
   */
  function storeRequired(
    write: WriteContext,
    root: BatchDto,
    read: PullRequestStatus,
    required: RequiredChecks | null,
  ): void {
    const now = getBatch(write.tx, root.id);
    const blocked = read.state === PrState.Open ? read.mergeBlocked : null;
    const nextRequired = required === null ? now.prRequired : requiredOf(required);
    const patch: BatchPatch = {
      ...(JSON.stringify(nextRequired) === JSON.stringify(now.prRequired)
        ? {}
        : { prRequired: nextRequired }),
      ...(blocked === now.prMergeBlocked ? {} : { prMergeBlocked: blocked }),
    };
    if (Object.keys(patch).length > 0) patchBatch(write, root.id, patch);
  }

  async function round(signal: AbortSignal): Promise<void> {
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
      ctx.state.write((write) => {
        for (const batch of members) {
          record(write, batch, answer(batch, read), batch.id === root.id);
          followConflict(write, batch, read);
        }
        if (read !== null) storeRequired(write, root, read, required);
      });
      // A pull request that conflicts runs no workflow, so its failing checks are stale.
      if (
        ciFix !== undefined &&
        ended === null &&
        root.ciFixOf === null &&
        read?.state === PrState.Open &&
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
