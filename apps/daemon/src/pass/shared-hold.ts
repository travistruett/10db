import {
  ClaimKind,
  type ClaimId,
  type PassDto,
  type PassId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  acquireClaims,
  copyHazardNames,
  getProject,
  getTask,
  getWorkstreamRow,
  insertHold,
  listPassTasks,
  openHolds,
  passPageAreas,
  type AcquireResult,
  type DbReader,
} from '@10db/db';
import { claimScopeOf } from '../delivery';
import { classifyPath } from '../guard';
import { pageMatcher, passTaskPlace, readKeptRef, type PassWorkDeps } from './kept-work';

// Workbench spec §7.2, §7.3: a pass task's shared area is held one turn at a time. At the grant the
// daemon records every path of the area that differs from the shared chain's tip, with its content,
// so only what changes during the hold is ever kept under the task's name.

/** The pass's shared chain: one commit per shared change, the first on the pass's start. */
export const sharedRef = (pass: PassId): string => `refs/10db/passes/${pass}/shared`;

/** The commit holding the content a hold's record took at its grant. */
export const holdRef = (pass: PassId, claim: ClaimId): string =>
  `refs/10db/passes/${pass}/holds/${claim}`;

/** What the shared chain and its holds read and write. */
export type SharedDeps = Pick<PassWorkDeps, 'state' | 'git'>;

/** The chain's tip: its newest commit, else the pass's start. */
export async function chainTip(deps: SharedDeps, repo: string, pass: PassDto): Promise<string> {
  return (await readKeptRef(deps.git, repo, sharedRef(pass.id))) ?? pass.startSha;
}

/**
 * Whether a path is one of the area's shared files in the pass (spec §7.3): it matches the area, and
 * no page area of the project, no area a pass task holds as a page, and no hazard a pass task holds
 * claims it, since each of those makes it one page's work alone.
 */
export function sharedPathOf(db: DbReader, pass: PassDto, area: string): (path: string) => boolean {
  const project = getProject(db, pass.projectId);
  const pages = new Set(passPageAreas(db, pass.id));
  const owners = listPassTasks(db, pass.id).map((task) => pageMatcher(db, project, task, pass.id));
  return (path) => {
    const hit = classifyPath(path, project.areas, project.hazards);
    if (!hit.areas.includes(area)) return false;
    if (hit.areas.some((a) => pages.has(a))) return false;
    return !owners.some((owns) => owns(path));
  };
}

/**
 * The area's shared files whose content on disk differs from commit `against`: the folder's changes
 * since HEAD and every file `against` differs from HEAD by, read again on disk.
 */
export async function sharedPathsDiffering(
  deps: SharedDeps,
  input: {
    readonly repo: string;
    readonly against: string;
    readonly shared: (path: string) => boolean;
    /** Paths to look at as well, whatever git lists. */
    readonly also?: readonly string[];
  },
): Promise<string[]> {
  const { git } = deps;
  const head = await git.commitAt(input.repo, 'HEAD');
  const candidates = [
    ...new Set([
      ...(await git.changedPaths(input.repo)),
      ...(await git.filesChangedBetween(input.repo, head, input.against)),
      ...(input.also ?? []),
    ]),
  ].filter(input.shared);
  if (candidates.length === 0) return [];
  const onDisk = await git.hashOnDisk(input.repo, candidates);
  const there = new Map(
    (await git.blobsAt(input.repo, input.against, candidates)).map((f) => [f.path, f.blob]),
  );
  return onDisk.filter((f) => there.get(f.path) !== f.blob).map((f) => f.path);
}

/**
 * Grants a pass lane its shared area for the turn (spec §7.2): the area's shared files that differ
 * from the chain's tip are recorded with their content, then the claim and its hold, numbered on the
 * chain, are written together, and the hold's ref keeps the record. A task that took the claim first
 * is the conflict, and nothing is written: the record's commit is left unreferenced.
 */
export async function grantSharedHold(
  deps: SharedDeps,
  input: { readonly workstreamId: WorkstreamId; readonly area: string },
): Promise<AcquireResult> {
  const db = deps.state.db;
  const place = passTaskPlace(db, getWorkstreamRow(db, input.workstreamId).taskId);
  const { pass, repo } = place;
  const tip = await chainTip(deps, repo, pass);
  const paths = await sharedPathsDiffering(deps, {
    repo,
    against: tip,
    shared: sharedPathOf(db, pass, input.area),
  });
  const { sha, record } = await deps.git.recordPaths({ repo, base: tip, paths });
  const outcome = deps.state.write((ctx): AcquireResult => {
    const row = getWorkstreamRow(ctx.tx, input.workstreamId);
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
  if (outcome.ok) {
    const claim = outcome.claims.find((c) => c.kind === ClaimKind.Area && c.name === input.area);
    if (claim) await deps.git.keepRef(repo, holdRef(pass.id, claim.id), sha);
  }
  return outcome;
}
