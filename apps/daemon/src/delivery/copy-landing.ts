import {
  BatchFailure,
  BatchState,
  CopyStep,
  CopyWait,
  InvalidError,
  type BatchDto,
  type BatchId,
  type ProjectDto,
  type ProjectId,
} from '@10db/contracts';
import {
  getBatch,
  getLocalCopy,
  getProject,
  isLivePromoting,
  listOpenLocalCopies,
  patchLocalCopy,
  transitionBatch,
} from '@10db/db';
import { areaMatches } from '../guard';
import type { BaseUpdate } from './base-update';
import { shipCards, wrongBranchCard, type ShipFailure } from './cards';
import {
  copyLandingCards,
  raiseMigrationsCard,
  raiseWaitCard,
  withdrawWaitCards,
} from './copy-landing-cards';
import { retireCopy } from './copy-retire';
import type { DeliveryContext } from './context';
import { shipCheck, type LocalCheck } from './local-check';
import { resolveShipCards } from './stale-cards';
import type { PromotionInput, Promotion } from '../git';

export interface CopyLanding {
  /** Runs or resumes the landing from the journal's step; the ship job calls it for a local copy. */
  land(batchId: BatchId, signal: AbortSignal): Promise<void>;
  /** Rechecks every waiting landing of the project; the minute timer calls it. */
  recheck(projectId: ProjectId): void;
}

export interface CopyLandingDeps {
  readonly ctx: DeliveryContext;
  /** True while a waiting update drains the factory: no ship begins. */
  readonly holdShips?: () => boolean;
  /**
   * The shipper's check on the copy, in the batch's gate slot (`shipSteps`' step 2). `afterBase` runs once
   * the base is in the copy and before the gate starts; false stops the gate.
   */
  readonly check: (
    batch: BatchDto,
    project: ProjectDto,
    checkout: string,
    check: LocalCheck,
    signal: AbortSignal,
    afterBase: (update: BaseUpdate) => Promise<boolean>,
  ) => Promise<boolean>;
  /** SHIPPING to FAILED with the card; a landing live at promoting fails as interrupted. */
  readonly fail: (batch: BatchDto, outcome: ShipFailure) => void;
  /** Queues a ship job for the batch; `settled` runs when it ends. */
  readonly resume: (batchId: BatchId, settled: () => void) => void;
}

const BASE_STILL_MS = 10 * 60_000;
const INDEX_RETRY_MS = 30_000;
const INDEX_CARD_AFTER_MS = 10 * 60_000;
/** The fourth race with the base waits instead of merging again. */
const MAX_RACES = 3;
const MAX_ROUNDS = 8;

type Next = 'again' | 'done';

/** The landing went round MAX_ROUNDS times without ending in a wait, a failure or a landing. */
export class LandingNotSettledError extends Error {
  override readonly name = 'LandingNotSettledError';
  constructor(batchId: BatchId) {
    super(`The landing of batch ${batchId} did not settle`);
  }
}

export function createCopyLanding(deps: CopyLandingDeps): CopyLanding {
  const { ctx } = deps;
  const db = ctx.state.db;
  const inflight = new Set<BatchId>();
  const RELEASED = { wait: null, waitDetail: [], retryAt: null } as const;

  const later = (ms: number): string => new Date(ctx.clock.now().getTime() + ms).toISOString();
  const patch = (batchId: BatchId, p: Parameters<typeof patchLocalCopy>[2]): void => {
    ctx.state.write((w) => patchLocalCopy(w, batchId, p));
  };
  /** Writes the patch only while the batch is still SHIPPING: an Abandon or a joined fix task won the race otherwise. */
  const patchWhileShipping = (batchId: BatchId, p: Parameters<typeof patchLocalCopy>[2]): boolean =>
    ctx.state.write((w) => {
      if (getBatch(w.tx, batchId).state !== BatchState.Shipping) return false;
      patchLocalCopy(w, batchId, p);
      return true;
    });
  const hits = (project: ProjectDto, hazard: string, files: readonly string[]): string[] => {
    const globs = project.hazards.filter((h) => h.name === hazard).flatMap((h) => h.globs);
    return files.filter((f) => globs.some((g) => areaMatches(f, g)));
  };

  async function land(batchId: BatchId, signal: AbortSignal): Promise<void> {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (signal.aborted) return;
      const batch = getBatch(db, batchId);
      if (batch.state !== BatchState.Shipping) return;
      if ((await stepOnce(batch, signal)) === 'done') return;
    }
    throw new LandingNotSettledError(batchId);
  }

  async function stepOnce(batch: BatchDto, signal: AbortSignal): Promise<Next> {
    const copy = getLocalCopy(db, batch.id);
    if (copy === null) return 'done';
    const project = getProject(db, batch.projectId);
    // A landing that may have written the folder is read by the classifier before anything else; it needs
    // only the folder, T and C.
    if (isLivePromoting(copy)) return promote(batch, project, copy, signal, 'classify');
    const { branch, worktreePath, baseSha } = batch;
    if (branch === null || worktreePath === null || baseSha === null) {
      deps.fail(batch, {
        failure: BatchFailure.WrongBranch,
        card: wrongBranchCard(batch, null, worktreePath ?? project.repoPath, 'not_shipped'),
      });
      return 'done';
    }
    const current = await ctx.git.currentBranch(worktreePath);
    if (current !== branch) {
      deps.fail(batch, {
        failure: BatchFailure.WrongBranch,
        card: wrongBranchCard(batch, current, worktreePath, 'not_shipped'),
      });
      return 'done';
    }
    if (copy.wait !== null && !(await due(batch, project))) return 'done';
    const head = await ctx.git.head(worktreePath);
    const gated = copy.step === CopyStep.Gated || copy.step === CopyStep.Promoting;
    if (gated && copy.candidate === head && copy.baseTip !== null)
      return promote(batch, project, copy, signal, 'call');
    return prepare(batch, project, copy, signal);
  }

  /** Whether a waiting landing is due again; a base that moved since the last look pushes `base_moving` back. */
  async function due(batch: BatchDto, project: ProjectDto): Promise<boolean> {
    const copy = getLocalCopy(db, batch.id);
    if (copy === null) return false;
    if (copy.wait === CopyWait.BaseMoving) {
      const tip = await ctx.git.branchTip(project.repoPath, batch.baseBranch);
      if (tip !== copy.baseTip) {
        patch(batch.id, { baseTip: tip, retryAt: later(BASE_STILL_MS) });
        return false;
      }
    }
    return copy.retryAt === null || Date.parse(copy.retryAt) <= ctx.clock.now().getTime();
  }

  /** Spec §5 steps 1 to 3: the copy's preconditions, the base merged in, and the gate bound to C. */
  async function prepare(
    batch: BatchDto,
    project: ProjectDto,
    copy: NonNullable<ReturnType<typeof getLocalCopy>>,
    signal: AbortSignal,
  ): Promise<Next> {
    const { branch, worktreePath, baseSha } = batch;
    if (branch === null || worktreePath === null || baseSha === null) return 'done';
    if (signal.aborted) return 'done';
    const attempt = copy.wait === CopyWait.BaseMoving ? 0 : copy.attempt;
    if (!patchWhileShipping(batch.id, { step: CopyStep.Merging, attempt, ...RELEASED }))
      return 'done';
    withdrawWaitCards(ctx, batch.projectId, batch.id);
    const dirty = await ctx.git.changedPaths(worktreePath);
    if (dirty.length > 0) {
      deps.fail(batch, shipCards.dirtyCheckout(batch, dirty, worktreePath));
      return 'done';
    }
    const tip = `refs/heads/${branch}`;
    if ((await ctx.git.commitsSince(worktreePath, baseSha, tip)).length === 0) {
      ctx.state.write((w) =>
        transitionBatch(w, batch.id, {
          to: BatchState.Closed,
          reason: 'no commits beyond the base',
        }),
      );
      ctx.logger.info({ batchId: batch.id }, 'batch closed');
      await retireCopy(ctx, batch.id, signal);
      return 'done';
    }
    const lockfiles = hits(
      project,
      'deps',
      await ctx.git.filesChangedBetween(worktreePath, baseSha, tip),
    );
    if (lockfiles.length > 0) {
      deps.fail(batch, copyLandingCards.lockfileInCopy(batch, lockfiles));
      return 'done';
    }
    const check = shipCheck(project);
    if (check === null)
      throw new InvalidError('This project has no gate command to land a copy with');
    const seen: { moved: string | null | undefined; dirty: readonly string[] } = {
      moved: undefined,
      dirty: [],
    };
    const passed = await deps.check(batch, project, worktreePath, check, signal, async () => {
      const t = await ctx.git.branchTip(project.repoPath, batch.baseBranch);
      const head = await ctx.git.head(worktreePath);
      if (t === null || !(await ctx.git.isAncestor(worktreePath, t, head))) {
        seen.moved = t;
        return false;
      }
      seen.dirty = await ctx.git.changedPaths(worktreePath);
      if (seen.dirty.length > 0) return false;
      return patchWhileShipping(batch.id, {
        step: CopyStep.Gating,
        baseTip: t,
        candidate: head,
        ...RELEASED,
      });
    });
    if (!passed) {
      if (seen.moved !== undefined) return raced(batch, attempt, seen.moved);
      if (seen.dirty.length > 0)
        deps.fail(batch, shipCards.dirtyCheckout(batch, seen.dirty, worktreePath));
      return 'done';
    }
    const gating = getLocalCopy(db, batch.id);
    const head = await ctx.git.head(worktreePath);
    const changed = await ctx.git.changedPaths(worktreePath);
    if (gating?.candidate !== head || changed.length > 0) {
      deps.fail(
        batch,
        copyLandingCards.gateChangedCopy(batch, changed, head === gating?.candidate ? head : null),
      );
      return 'done';
    }
    if (!patchWhileShipping(batch.id, { step: CopyStep.Gated })) return 'done';
    return promote(batch, project, gating, signal, 'call');
  }

  /** Spec §5 step 4. `how` classify reads the folder first (recovery, a Retry, or an unclear answer). */
  async function promote(
    batch: BatchDto,
    project: ProjectDto,
    copy: NonNullable<ReturnType<typeof getLocalCopy>>,
    signal: AbortSignal,
    how: 'call' | 'classify' | 'retry',
  ): Promise<Next> {
    const { baseTip: t, candidate: c } = copy;
    if (t === null || c === null)
      throw new InvalidError('The landing journal holds no base or candidate to promote');
    const input: PromotionInput = {
      repo: project.repoPath,
      branch: batch.baseBranch,
      expected: t,
      candidate: c,
    };
    if (how === 'classify') return unclear(batch, project, copy, input, signal, false);
    if (signal.aborted) return 'done';
    // Entering live: one write, and only while the batch is still shipping.
    const entered = ctx.state.write((w) => {
      if (getBatch(w.tx, batch.id).state !== BatchState.Shipping) return false;
      patchLocalCopy(w, batch.id, { step: CopyStep.Promoting, ...RELEASED });
      return true;
    });
    if (!entered) return 'done';
    const outcome = await ctx.git.promoteFastForward(input);
    return settle(batch, project, copy, input, outcome, signal, how === 'retry');
  }

  async function settle(
    batch: BatchDto,
    project: ProjectDto,
    prior: NonNullable<ReturnType<typeof getLocalCopy>>,
    input: PromotionInput,
    outcome: Promotion,
    signal: AbortSignal,
    retried: boolean,
  ): Promise<Next> {
    switch (outcome.kind) {
      case 'promoted':
        return landed(batch, project, input, signal);
      case 'base_moved':
        return raced(batch, prior.attempt, outcome.now);
      case 'off_base':
        return waits(batch, CopyWait.FolderOffBase, [outcome.head ?? 'a detached HEAD'], null);
      case 'in_the_way':
        return waits(batch, CopyWait.EditsInTheWay, [...outcome.changed, ...outcome.kept], null);
      case 'index_locked': {
        const nowMs = ctx.clock.now().getTime();
        const since =
          prior.wait === CopyWait.IndexLocked && prior.waitDetail[0] !== undefined
            ? prior.waitDetail[0]
            : new Date(nowMs).toISOString();
        const old = nowMs - Date.parse(since) >= INDEX_CARD_AFTER_MS;
        return waits(batch, CopyWait.IndexLocked, [since], later(INDEX_RETRY_MS), old);
      }
      case 'filters':
        patch(batch.id, { step: CopyStep.Gated, ...RELEASED });
        withdrawWaitCards(ctx, batch.projectId, batch.id);
        deps.fail(batch, copyLandingCards.gitFilters(batch, outcome.paths));
        return 'done';
      case 'unclear':
        return unclear(batch, project, prior, input, signal, retried);
    }
  }

  /** The folder classifier's row decides (spec §8). */
  async function unclear(
    batch: BatchDto,
    project: ProjectDto,
    prior: NonNullable<ReturnType<typeof getLocalCopy>>,
    input: PromotionInput,
    signal: AbortSignal,
    retried: boolean,
  ): Promise<Next> {
    const row = await ctx.git.classifyFolder(input);
    const interrupted = (paths: readonly string[], ref: string | null): Next => {
      deps.fail(batch, copyLandingCards.interruptedLanding(batch, paths, ref ?? 'none'));
      return 'done';
    };
    switch (row.row) {
      case 'A':
        return waits(batch, CopyWait.FolderOffBase, [row.head ?? 'a detached HEAD'], null);
      case 'B':
        return landed(batch, project, input, signal);
      case 'C':
        return retried ? interrupted([], null) : promote(batch, project, prior, signal, 'retry');
      case 'D':
        return (await ctx.git.finishPromotion(input)) === 'promoted'
          ? landed(batch, project, input, signal)
          : interrupted([], input.branch);
      case 'E':
        return raced(batch, prior.attempt, row.now);
      case 'F':
        return waits(batch, CopyWait.EditsInTheWay, row.paths, null);
      case 'G':
        return interrupted(row.paths, row.ref);
    }
  }

  /** The base moved under the promotion: merge again, and on the fourth race wait for it to be still. */
  function raced(batch: BatchDto, attempt: number, now: string | null): Next {
    withdrawWaitCards(ctx, batch.projectId, batch.id);
    if (attempt < MAX_RACES) {
      patch(batch.id, { step: CopyStep.Merging, attempt: attempt + 1, ...RELEASED });
      return 'again';
    }
    patch(batch.id, {
      step: CopyStep.Merging,
      wait: CopyWait.BaseMoving,
      waitDetail: [],
      baseTip: now,
      retryAt: later(BASE_STILL_MS),
    });
    raiseWaitCard(ctx.inbox, batch, CopyWait.BaseMoving, []);
    return 'done';
  }

  function waits(
    batch: BatchDto,
    wait: CopyWait,
    detail: readonly string[],
    retryAt: string | null,
    card = true,
  ): Next {
    patch(batch.id, { step: CopyStep.Promoting, wait, waitDetail: detail, retryAt });
    withdrawWaitCards(ctx, batch.projectId, batch.id, wait);
    if (card) raiseWaitCard(ctx.inbox, getBatch(db, batch.id), wait, detail);
    return 'done';
  }

  /** Spec §5 step 5: SHIPPED and `landed` in one write, then the migrations card, then retirement. */
  async function landed(
    batch: BatchDto,
    project: ProjectDto,
    input: PromotionInput,
    signal: AbortSignal,
  ): Promise<Next> {
    ctx.state.write((w) => {
      transitionBatch(w, batch.id, { to: BatchState.Shipped, reason: 'landed in your folder' });
      patchLocalCopy(w, batch.id, { step: CopyStep.Landed, ...RELEASED });
    });
    ctx.logger.info({ batchId: batch.id, branch: batch.baseBranch }, 'batch landed');
    withdrawWaitCards(ctx, batch.projectId, batch.id);
    resolveShipCards(db, ctx.inbox, getBatch(db, batch.id));
    try {
      const files = await ctx.git.filesChangedBetween(
        project.repoPath,
        input.expected,
        input.candidate,
      );
      const migrations = hits(project, 'migrations', files);
      if (migrations.length > 0) raiseMigrationsCard(ctx.inbox, getBatch(db, batch.id), migrations);
    } catch (error) {
      ctx.logger.warn(
        { batchId: batch.id, err: error instanceof Error ? error.message : String(error) },
        'migrations card not raised',
      );
    }
    patch(batch.id, { step: CopyStep.Retiring });
    await retireCopy(ctx, batch.id, signal);
    return 'done';
  }

  function recheck(projectId: ProjectId): void {
    if (deps.holdShips?.() === true) return;
    for (const copy of listOpenLocalCopies(db)) {
      if (copy.wait === null || inflight.has(copy.batchId)) continue;
      const batch = getBatch(db, copy.batchId);
      if (batch.projectId !== projectId || batch.state !== BatchState.Shipping) continue;
      inflight.add(batch.id);
      deps.resume(batch.id, () => {
        inflight.delete(batch.id);
      });
    }
  }

  return { land, recheck };
}
