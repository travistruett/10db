import {
  BatchFailure,
  BuilderOwns,
  CopyWait,
  Urgency,
  type BatchDto,
  type BatchId,
  type ProjectDto,
  type ProjectId,
} from '@10db/contracts';
import { findOpenByFoldKey, getBatch } from '@10db/db';
import { areaMatches } from '../guard';
import type { StateStore } from '../events';
import { BY_ANSWER, CardTier, decidedByBuilder, type InboxService } from '../inbox';
import { shipFailureFoldKey, type Card, type ShipFailure } from './cards';
import { raise, type DeliveryContext } from './context';

// The cards of a separate copy's landing, each keyed by its batch and kind: a rerun raises it once, and the
// landing withdraws a wait's card when it goes on (spec §5).

const WITHDRAWN = 'the separate copy landing goes on (copy-landing)';

const waitKey = (batchId: BatchId, wait: CopyWait): string => `copy-wait:${batchId}:${wait}`;
const migrationsKey = (batchId: BatchId): string => `copy-migrations:${batchId}`;

function lines(paths: readonly string[]): string {
  const shown = paths.slice(0, 10).map((p) => `- ${p}`);
  const more = paths.length - shown.length;
  return [...shown, ...(more > 0 ? [`- and ${String(more)} more`] : [])].join('\n');
}

function waitCard(batch: BatchDto, wait: CopyWait, detail: readonly string[]): Card {
  const title = `Batch "${batch.title}" is waiting to land in your folder`;
  const common = {
    tier: CardTier.Ask,
    urgency: Urgency.Normal,
    closesWhen: { by: 'withdrawn', when: WITHDRAWN } as const,
    decision: decidedByBuilder(BuilderOwns.YourHands),
    foldKey: waitKey(batch.id, wait),
    refresh: true,
  };
  switch (wait) {
    case CopyWait.FolderOffBase:
      return {
        ...common,
        title: `${title}: your folder is on another branch`,
        body: `Your folder is on ${detail[0] ?? 'another branch'}, not ${batch.baseBranch}. 10db lands only on ${batch.baseBranch}. Switch your folder back to it and the landing goes on by itself.`,
      };
    case CopyWait.EditsInTheWay:
      return {
        ...common,
        title: `${title}: you have edits where it writes`,
        body: `These files have changes of yours that the landing would overwrite:\n${lines(detail)}\n\nCommit, stash or discard them and the landing goes on by itself. 10db never touches them.`,
      };
    case CopyWait.IndexLocked:
      return {
        ...common,
        title: `${title}: another git holds your folder's index`,
        body: "Another git command has held your folder's index lock for over 10 minutes. If none is running, remove .git/index.lock; the landing goes on by itself.",
      };
    case CopyWait.BaseMoving:
      return {
        ...common,
        tier: CardTier.Status,
        decision: decidedByBuilder(BuilderOwns.YourHands),
        title: `${title}: ${batch.baseBranch} keeps moving`,
        body: `${batch.baseBranch} keeps moving; the landing waits for it to be still for 10 minutes.`,
      };
  }
}

/** The wait's card, once: the key folds a repeat into the open one. */
export function raiseWaitCard(
  inbox: InboxService,
  batch: BatchDto,
  wait: CopyWait,
  detail: readonly string[],
): void {
  raise(inbox, batch.projectId, waitCard(batch, wait, detail));
}

/** Withdraws the batch's open wait cards, except the one of `keep`. */
export function withdrawWaitCards(
  deps: { readonly state: StateStore; readonly inbox: InboxService },
  projectId: ProjectId,
  batchId: BatchId,
  keep: CopyWait | null = null,
): void {
  for (const wait of Object.values(CopyWait)) {
    if (wait === keep) continue;
    const card = findOpenByFoldKey(deps.state.db, projectId, waitKey(batchId, wait));
    if (card !== undefined) deps.inbox.resolve(card.id, 'The landing goes on');
  }
}

/** One card: the landing brought migrations into the base. Its key is the batch, so a rerun raises it once. */
export function raiseMigrationsCard(
  inbox: InboxService,
  batch: BatchDto,
  paths: readonly string[],
): void {
  raise(inbox, batch.projectId, {
    tier: CardTier.Ask,
    urgency: Urgency.Normal,
    closesWhen: BY_ANSWER,
    decision: decidedByBuilder(BuilderOwns.YourHands),
    title: `The landing of "${batch.title}" brought migrations into ${batch.baseBranch}`,
    body: `Apply them to your dev database before you use the app:\n${lines(paths)}`,
    foldKey: migrationsKey(batch.id),
  });
}

/**
 * The migrations card for a landing of T..C (the journal's `baseTip` and `candidate`) into the base,
 * when it touched a `migrations` hazard path. Called live by the landing and again by recovery for a
 * copy found at `landed`; the card's key is the batch, so a repeat folds into the open one.
 */
export async function raiseMigrationsForLanding(
  ctx: Pick<DeliveryContext, 'git' | 'inbox' | 'logger' | 'state'>,
  batch: BatchDto,
  project: ProjectDto,
  expected: string,
  candidate: string,
): Promise<void> {
  try {
    const files = await ctx.git.filesChangedBetween(project.repoPath, expected, candidate);
    const globs = project.hazards.filter((h) => h.name === 'migrations').flatMap((h) => h.globs);
    const migrations = files.filter((f) => globs.some((g) => areaMatches(f, g)));
    if (migrations.length > 0)
      raiseMigrationsCard(ctx.inbox, getBatch(ctx.state.db, batch.id), migrations);
  } catch (error) {
    ctx.logger.warn(
      { batchId: batch.id, err: error instanceof Error ? error.message : String(error) },
      'migrations card not raised',
    );
  }
}

function failure(
  batch: BatchDto,
  code: BatchFailure,
  title: string,
  body: string,
  actions: readonly string[] = ['retry', 'abandon'],
): ShipFailure {
  return {
    failure: code,
    card: {
      title: `Batch "${batch.title}" not shipped: ${title}`,
      body,
      foldKey: shipFailureFoldKey(batch.id),
      tier: CardTier.Ask,
      urgency: Urgency.High,
      closesWhen: { by: 'event', when: { event: 'batch_shipped', batchId: batch.id } },
      decision: decidedByBuilder(BuilderOwns.OutOfMoves),
      detail: { batchId: batch.id, actions: [...actions] },
    },
  };
}

export const copyLandingCards = {
  lockfileInCopy: (batch: BatchDto, paths: readonly string[]): ShipFailure =>
    failure(
      batch,
      BatchFailure.LockfileInCopy,
      "a separate copy doesn't land dependency changes",
      `The copy changed files of the project's dependencies, which the landing doesn't carry into your folder:\n${lines(paths)}\n\nMove the task out of a separate copy, or take those changes out of it, then retry.`,
    ),
  gateChangedCopy: (batch: BatchDto, paths: readonly string[], head: string | null): ShipFailure =>
    failure(
      batch,
      BatchFailure.GateChangedCopy,
      'the gate changed the copy',
      `The gate passed, but the copy is not what it checked: ${head === null ? 'its head moved' : 'its files changed'}.${paths.length > 0 ? `\n${lines(paths)}` : ''}\n\nA gate that writes into the copy's tracked files can't be trusted to land them. Fix what the gate writes, then retry.`,
    ),
  gitFilters: (batch: BatchDto, paths: readonly string[]): ShipFailure =>
    failure(
      batch,
      BatchFailure.GitFilters,
      "git filters 10db won't run",
      `The landing would write paths whose git filters 10db never runs in your folder:\n${lines(paths)}\n\nTake those paths out of the change, then retry.`,
    ),
  /** The journal is kept at promoting: Retry classifies the folder again, and Abandon is refused. */
  interruptedLanding: (batch: BatchDto, paths: readonly string[], refs: string): ShipFailure =>
    failure(
      batch,
      BatchFailure.InterruptedLanding,
      'a landing was interrupted in your folder',
      `10db was writing ${batch.baseBranch} into your folder when something stopped it, and your folder is not in a state 10db can finish or undo by itself. Nothing in it was touched afterward; the copy still has the work.\n${paths.length > 0 ? `\nPaths:\n${lines(paths)}\n` : ''}\nRefs: ${refs}\n\nPut your folder in a clean state on ${batch.baseBranch} (or finish the move yourself), then press Retry.`,
      ['retry'],
    ),
};
