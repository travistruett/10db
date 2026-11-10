import {
  ClaimKind,
  ConflictError,
  InvalidError,
  type ClaimId,
  type PassHoldDto,
  type PassId,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  acquireClaims,
  activeClaims,
  closeHold,
  copyHazardNames,
  getHold,
  getPass,
  getPassProgress,
  getProject,
  getTask,
  getWorkstreamRow,
  holdRecord,
  insertHold,
  insertSystemNotice,
  listPassTasks,
  listPassTurns,
  listSharedChanges,
  markLanded,
  openHolds,
  openPassTurn,
  releaseClaim,
  upsertSharedChange,
  type AcquireResult,
  type DbReader,
} from '@10db/db';
import { claimScopeOf } from '../delivery';
import type { Logger } from '../log';
import { PassFolderOffBranchError, type ChainCommit } from '../git';
import { keepNamedPaths, passBranch, passTaskPlace, type PassWorkDeps } from './kept-work';
import {
  chainTip,
  extendChain,
  holdRef,
  onPassBranch,
  sharedPathOf,
  sharedPathsDiffering,
  sharedRef,
  type SharedDeps,
} from './shared-hold';

// Workbench spec §7.2: what a hold changed in its shared area is kept as one change on the pass's
// shared chain, numbered as the hold was, and released; a sign-off later lands the chain's prefix it
// needs, in number order.

/** The trailer that names the hold a chain commit keeps, so a rerun finds it. */
const HOLD_TRAILER = '10db-hold';

/** What keeping a hold left on the chain. */
export interface KeptHold {
  readonly seq: number;
  /** The change's chain commit; null when the hold changed nothing. */
  readonly sha: string | null;
  /** True when this keep made a new chain commit. */
  readonly made: boolean;
  /** The shared files the hold changed, sorted. */
  readonly paths: readonly string[];
}

const quoted = (paths: readonly string[]): string => paths.map((p) => `\`${p}\``).join(', ');

/**
 * Keeps what a hold changed (spec §7.2): a shared file of its area whose content on disk differs
 * from the record taken at the grant (which holds the chain's tip for every file it did not record)
 * is in the change, whole, even when it was dirty at the grant. The change is one commit on the
 * shared chain by compare-and-swap, followed once when another keep moved it; then one write upserts
 * the change's row and, unless `keepOpen` (the commit tool's early keep), closes the hold, releases
 * its claim and posts a line on every other thread of the pass. A hold that changed nothing makes no
 * commit and closes as empty. A closed hold is answered as it was kept.
 */
export async function keepHold(
  deps: SharedDeps,
  input: { readonly claimId: ClaimId; readonly keepOpen?: boolean },
): Promise<KeptHold> {
  const db = deps.state.db;
  const hold = getHold(db, input.claimId);
  const kept = listSharedChanges(db, hold.passId).find((c) => c.seq === hold.seq);
  if (hold.closedAt !== null)
    return { seq: hold.seq, sha: kept?.sha ?? null, made: false, paths: kept?.paths ?? [] };
  const pass = getPass(db, hold.passId);
  const task = getTask(db, hold.taskId);
  const repo = getProject(db, pass.projectId).repoPath;
  await onPassBranch(deps, pass, repo);
  const record = holdRecord(db, hold.claimId);
  const changed = await sharedPathsDiffering(deps, {
    repo,
    against: hold.recordSha,
    shared: sharedPathOf(db, pass, hold.area),
    also: kept?.paths ?? [],
  });
  const dirtyKept = changed.some((path) => record.some((r) => r.path === path));
  // An earlier keep's path that is back as the grant found it is set on the chain as it was before
  // the hold (the record's parent, the chain's tip at the grant), never as the folder has it, which
  // may be dirt from before the hold.
  const takenBack = (kept?.paths ?? []).filter((path) => !changed.includes(path));
  let made: ChainCommit = { sha: null, made: false, files: [] };
  if (changed.length + takenBack.length > 0) {
    made = await extendChain(deps, {
      repo,
      ref: sharedRef(pass.id),
      base: pass.startSha,
      paths: changed,
      ...(takenBack.length > 0
        ? { restore: { from: `${hold.recordSha}^`, paths: takenBack } }
        : {}),
      message: `Shared change ${String(hold.seq)} of ${task.title}`,
      trailer: { key: HOLD_TRAILER, value: hold.claimId },
    });
  }
  const files = made.files.filter((f) => changed.includes(f.path));
  const sha = made.sha;
  const empty = sha === null || files.length === 0;
  deps.state.write((ctx) => {
    // Another keep of the hold, at the same turn's end, closed it first: it kept the same files.
    if (getHold(ctx.tx, hold.claimId).closedAt !== null) return;
    if (sha !== null && (kept !== undefined || files.length > 0))
      upsertSharedChange(ctx, { passId: pass.id, seq: hold.seq, sha, files, dirtyKept });
    if (input.keepOpen === true) return;
    closeHold(ctx, hold.claimId, { empty });
    releaseClaim(ctx, hold.claimId);
    if (empty) return;
    const line = `${task.title} changed shared ${quoted(files.map((f) => f.path))}${
      dirtyKept ? '; it includes edits that were already in your folder' : ''
    }.`;
    for (const other of listPassTasks(ctx.tx, pass.id))
      if (other.id !== task.id) insertSystemNotice(ctx, other.id, line);
  });
  return {
    seq: hold.seq,
    sha: empty ? null : sha,
    made: made.made,
    paths: files.map((f) => f.path),
  };
}

/**
 * Keeps an open hold, or, when it cannot be kept (its record is gone, the chain is unreadable), lets
 * it go: closed as empty and its claim released in one write, with a line on its page's thread, so
 * a start-up or an Abandon is never stuck on it. A folder off the pass's branch is not such a case:
 * the hold stays open for the folder's return, and the refusal is thrown.
 */
export async function keepOrLetGo(
  deps: SharedDeps & { readonly logger?: Logger },
  claimId: ClaimId,
): Promise<void> {
  try {
    await keepHold(deps, { claimId });
  } catch (error) {
    if (error instanceof PassFolderOffBranchError) throw error;
    const why = error instanceof Error ? error.message : String(error);
    deps.logger?.warn({ claimId, err: why }, 'a shared hold could not be kept; it is let go');
    deps.state.write((ctx) => {
      const hold = getHold(ctx.tx, claimId);
      if (hold.closedAt !== null) return;
      closeHold(ctx, claimId, { empty: true });
      releaseClaim(ctx, claimId);
      insertSystemNotice(
        ctx,
        hold.taskId,
        `What this page changed in shared ${hold.area} during its turn could not be kept (${why}), so it is not a shared change: its files stay in the folder as they are.`,
      );
    });
  }
}

/** The open holds of a workstream, by number. */
function openHoldsOf(db: DbReader, ws: WorkstreamId): PassHoldDto[] {
  const task = getTask(db, getWorkstreamRow(db, ws).taskId);
  const passId = task.passId;
  if (passId == null) return [];
  return openHolds(db, passId).filter((h) => h.workstreamId === ws);
}

/**
 * Keeps, then releases, every open hold of the workstream (spec §6.2 step 2): what its turn changed
 * in each shared area is on the chain before the area is free again.
 */
export async function closeHoldsOf(deps: PassWorkDeps, ws: WorkstreamId): Promise<void> {
  for (const hold of openHoldsOf(deps.state.db, ws))
    await keepHold(deps, { claimId: hold.claimId });
}

/**
 * What a page needs of the shared chain to sign off (spec §7.2): every number up to the highest
 * granted when one of its turns was kept, or its own last change, and the holds among them still
 * open, whose turns the sign-off waits for.
 */
export function sharedNeeded(
  db: DbReader,
  passId: PassId,
  taskId: TaskId,
): { upTo: number; openHolds: PassHoldDto[] } {
  const granted = listPassTurns(db, passId)
    .filter((t) => t.taskId === taskId && t.sharedSeq !== null)
    .map((t) => t.sharedSeq ?? 0);
  const own = listSharedChanges(db, passId)
    .filter((c) => c.taskId === taskId && c.dropOf === null && c.droppedBy === null)
    .map((c) => c.seq);
  const upTo = Math.max(0, ...granted, ...own);
  return { upTo, openHolds: openHolds(db, passId).filter((h) => h.seq <= upTo) };
}

/** A number of the chain a landing reached: the commit that landed its change, or null passed over. */
export interface LandedShared {
  readonly seq: number;
  readonly landedSha: string | null;
}

/**
 * Lands the pass's shared chain up to `upTo` on its branch (spec §7.2, §9.2), from the number landed
 * so far, in number order: each change as one signed commit on the branch's tip with its paths as
 * its chain commit holds them, so the branch's shared files are always a state the folder was in;
 * an empty hold, a dropped change and a drop are passed over. Each number is recorded as it lands,
 * and a rerun finds a commit it made by its operation id. Refused at a hold still open, and while
 * the folder is off the pass's branch.
 */
export async function landSharedChanges(
  deps: PassWorkDeps,
  i: { readonly passId: PassId; readonly upTo: number },
): Promise<LandedShared[]> {
  const db = deps.state.db;
  const pass = getPass(db, i.passId);
  const repo = getProject(db, pass.projectId).repoPath;
  const branch = passBranch(db, pass);
  const changes = new Map(listSharedChanges(db, pass.id).map((c) => [c.seq, c]));
  const open = new Set(openHolds(db, pass.id).map((h) => h.seq));
  const landed: LandedShared[] = [];
  for (let seq = getPassProgress(db, pass.id).sharedLanded + 1; seq <= i.upTo; seq += 1) {
    if (open.has(seq))
      throw new ConflictError(
        `Shared change ${String(seq)} is still being made; its turn has not ended`,
      );
    const change = changes.get(seq);
    let sha: string | null = change?.landedSha ?? null;
    if (
      change !== undefined &&
      sha === null &&
      change.dropOf === null &&
      change.droppedBy === null &&
      change.paths.length > 0
    ) {
      const done = await deps.git.landPaths({
        repo,
        branch,
        from: change.sha,
        paths: change.paths,
        message: `Shared change ${String(seq)} of ${getTask(db, change.taskId).title}`,
        opId: `shared-${pass.id}-${String(seq)}`,
      });
      sha = done.sha;
    }
    const at = sha;
    deps.state.write((ctx) => {
      markLanded(ctx, { passId: pass.id, seq, landedSha: at });
    });
    landed.push({ seq, landedSha: at });
  }
  return landed;
}

/**
 * The commit tool of a pass lane (spec §6.2) does steps 2 and 3 early: a shared file of an area the
 * lane holds now goes to that hold's change, kept and left open, and every other path to the page's
 * kept commit (`keepNamedPaths`, which refuses one that is not the page's). The guard's judge runs on
 * each path first. Answers the page's commit when the call named a page file, else the shared
 * change's; a shared change that holds nothing is refused. The pass's branch never moves.
 */
export async function keepCommitToolPaths(
  deps: SharedDeps,
  input: {
    readonly workstreamId: WorkstreamId;
    readonly paths: readonly string[];
    readonly opId: string;
    /** Why the guard would refuse a write to the path, or null when it allows it. */
    readonly judge: (path: string) => string | null;
  },
): Promise<{ readonly sha: string; readonly alreadyCommitted: boolean }> {
  const db = deps.state.db;
  const holds = openHoldsOf(db, input.workstreamId);
  const sharedOf = holds.map((hold) => ({
    hold,
    shared: sharedPathOf(db, getPass(db, hold.passId), hold.area),
  }));
  const byHold = new Map<ClaimId, string[]>();
  const page: string[] = [];
  for (const path of input.paths) {
    const held = sharedOf.find((s) => s.shared(path))?.hold;
    if (held === undefined) page.push(path);
    else byHold.set(held.claimId, [...(byHold.get(held.claimId) ?? []), path]);
  }
  for (const path of [...byHold.values()].flat()) {
    const refused = input.judge(path);
    if (refused !== null) throw new InvalidError(refused);
  }
  const shared: { readonly sha: string; readonly alreadyCommitted: boolean }[] = [];
  for (const [claimId, paths] of byHold) {
    const kept = await keepHold(deps, { claimId, keepOpen: true });
    if (kept.sha === null) throw new InvalidError(`Nothing to commit in ${paths.join(', ')}`);
    shared.push({ sha: kept.sha, alreadyCommitted: !kept.made });
  }
  if (page.length > 0)
    return keepNamedPaths(deps, {
      workstreamId: input.workstreamId,
      paths: page,
      opId: input.opId,
      judge: input.judge,
    });
  const [first] = shared;
  if (!first) throw new InvalidError('Name at least one path to commit');
  return first;
}

/**
 * Grants a pass lane its shared area for the turn (spec §7.2): the area's shared files that differ
 * from the chain's tip are recorded with their content, then the claim and its hold, numbered on the
 * chain, are written together, and the hold's ref keeps the record. A task that took the claim first
 * is the conflict, and nothing is written: the record's commit is left unreferenced. Null, with
 * nothing written, once the lane's turn has ended. An open hold on the area whose claim its lane
 * no longer holds is kept first.
 */
export async function grantSharedHold(
  deps: SharedDeps & { readonly logger?: Logger },
  input: { readonly workstreamId: WorkstreamId; readonly area: string },
): Promise<AcquireResult | null> {
  const db = deps.state.db;
  const place = passTaskPlace(db, getWorkstreamRow(db, input.workstreamId).taskId);
  const { pass, repo } = place;
  await onPassBranch(deps, pass, repo);
  // A hold whose claim was taken from its lane (a deadlock's yield, a take-out after a failed keep)
  // is kept first: otherwise its lane's edits would be in the next hold's record, or be its change.
  for (const stale of openHolds(db, pass.id))
    if (
      stale.area === input.area &&
      !activeClaims(db, stale.workstreamId).some((c) => c.id === stale.claimId)
    )
      await keepOrLetGo(deps, stale.claimId);
  const tip = await chainTip(deps, repo, pass);
  const paths = await sharedPathsDiffering(deps, {
    repo,
    against: tip,
    shared: sharedPathOf(db, pass, input.area),
  });
  const { sha, record } = await deps.git.recordPaths({ repo, base: tip, paths });
  const outcome = deps.state.write((ctx): AcquireResult | null => {
    const row = getWorkstreamRow(ctx.tx, input.workstreamId);
    // An area is held for a turn: once the turn has ended there is none to hold it for.
    if (!openPassTurn(ctx.tx, row.taskId)) return null;
    const areaScope = claimScopeOf(ctx.tx, row);
    const granted = acquireClaims(ctx, {
      projectId: pass.projectId,
      workstreamId: input.workstreamId,
      requests: [{ kind: ClaimKind.Area, name: input.area }],
      leaseExpiresAt: row.leaseExpiresAt ?? ctx.now,
      copyHazards: copyHazardNames(getProject(ctx.tx, pass.projectId)),
      ...(areaScope ? { areaScope } : {}),
    });
    if (!granted.ok) return granted;
    const claim = granted.claims.find((c) => c.kind === ClaimKind.Area && c.name === input.area);
    // A claim the lane held already has its hold.
    if (claim && !openHolds(ctx.tx, pass.id).some((h) => h.claimId === claim.id))
      insertHold(ctx, {
        claimId: claim.id,
        passId: pass.id,
        taskId: getTask(ctx.tx, row.taskId).id,
        workstreamId: input.workstreamId,
        area: input.area,
        recordSha: sha,
        record,
      });
    return granted;
  });
  if (outcome?.ok === true) {
    const claim = outcome.claims.find((c) => c.kind === ClaimKind.Area && c.name === input.area);
    if (claim) await deps.git.keepRef(repo, holdRef(pass.id, claim.id), sha);
  }
  return outcome;
}
