import {
  ConflictError,
  type PassId,
  type PassSharedChangeDto,
  type SharedUnlandedDto,
  type TaskId,
} from '@10db/contracts';
import {
  getPass,
  getProject,
  getTask,
  insertDrop,
  listHolds,
  listSharedChanges,
  openHolds,
  type DbReader,
} from '@10db/db';
import { readKeptRef } from './kept-work';
import {
  extendChain,
  onPassBranch,
  sharedPathOf,
  sharedPathsDiffering,
  sharedRef,
  type SharedDeps,
} from './shared-hold';

// Workbench spec §7.2 (D17): a page taken out may drop a shared change of its own that has not
// landed. Its files go back to what they were when its hold was granted, and a drop is appended to
// the chain; offered only when no later change touches its paths and the files on disk are still
// what the change made.

/** The trailer that names the change a drop puts back, so a rerun finds its chain commit. */
const DROP_TRAILER = '10db-drop';

const quoted = (paths: readonly string[]): string => paths.map((p) => `\`${p}\``).join(', ');

/** Whether a change is still on the chain to land: not a drop, not dropped, not landed. */
const unlanded = (c: PassSharedChangeDto): boolean =>
  c.dropOf === null && c.droppedBy === null && c.landedSha === null && c.paths.length > 0;

/** The later changes, not dropped, that touch one of the change's paths. */
function laterTouching(db: DbReader, change: PassSharedChangeDto): PassSharedChangeDto[] {
  return listSharedChanges(db, change.passId).filter(
    (c) =>
      c.seq > change.seq &&
      c.dropOf === null &&
      c.droppedBy === null &&
      c.paths.some((p) => change.paths.includes(p)),
  );
}

/** The commit holding each path as it was at the change's grant: its hold's record. */
function backOf(db: DbReader, change: PassSharedChangeDto): string {
  const hold = listHolds(db, change.passId).find((h) => h.seq === change.seq);
  if (!hold) throw new ConflictError(`Shared change ${String(change.seq)} has no hold`);
  return hold.recordSha;
}

/**
 * Why the change cannot be dropped now (spec §7.2), or null: another page's turn holds its area, a
 * later change touches its paths, or a file on disk is neither what the change made nor already put
 * back, which would be someone's edit.
 */
async function refusalOf(
  deps: SharedDeps,
  repo: string,
  change: PassSharedChangeDto,
): Promise<string | null> {
  const db = deps.state.db;
  // Another page's turn holding the area may be writing these files now.
  const area = listHolds(db, change.passId).find((h) => h.seq === change.seq)?.area;
  const holding = openHolds(db, change.passId).find(
    (h) => h.area === area && h.taskId !== change.taskId,
  );
  if (holding) return `${getTask(db, holding.taskId).title} holds ${holding.area} now`;
  const later = laterTouching(db, change);
  if (later.length > 0)
    return `${[...new Set(later.map((c) => getTask(db, c.taskId).title))].join(', ')} changed ${quoted(
      change.paths.filter((p) => later.some((c) => c.paths.includes(p))),
    )} after it`;
  const back = new Map(
    (await deps.git.blobsAt(repo, backOf(db, change), change.paths)).map((f) => [f.path, f.blob]),
  );
  const moved = (await deps.git.hashOnDisk(repo, change.paths))
    .filter((f) => f.blob !== (change.blobs[f.path] ?? null) && f.blob !== back.get(f.path))
    .map((f) => f.path);
  return moved.length > 0 ? `${quoted(moved)} changed on disk since` : null;
}

/** What a drop did. */
export interface DropDone {
  readonly seq: number;
  /** The drop's number on the chain; null when nothing was dropped. */
  readonly dropSeq: number | null;
  readonly paths: readonly string[];
  /** The files left as they were, because they changed since they were checked. */
  readonly left: readonly string[];
  /** Why the change was not dropped; null when it was. */
  readonly refused: string | null;
}

/**
 * Drops shared change `seq` (spec §7.2): refused, with the reason, while a later change touches its
 * paths or its files on disk changed. Otherwise each path is written back, hashed again just before:
 * to the content recorded at the grant, else the chain's version before it (both are the hold's
 * record commit), else removed; a file changed since is left and named. Then a drop is appended to
 * the chain and its row written. `force` (an Abandon) skips the refusals, never the hash before each
 * write. A change already dropped is answered as done; a rerun writes nothing twice.
 */
export async function dropShared(
  deps: SharedDeps,
  input: { readonly passId: PassId; readonly seq: number; readonly force?: boolean },
): Promise<DropDone> {
  const db = deps.state.db;
  const pass = getPass(db, input.passId);
  const repo = getProject(db, pass.projectId).repoPath;
  const change = listSharedChanges(db, pass.id).find((c) => c.seq === input.seq);
  if (!change) {
    // A hold that changed nothing has no change to drop.
    if (listHolds(db, pass.id).some((h) => h.seq === input.seq && h.closedAt !== null))
      return { seq: input.seq, dropSeq: null, paths: [], left: [], refused: null };
    throw new ConflictError(`Pass "${pass.name}" has no shared change ${String(input.seq)}`);
  }
  const done = (patch: Partial<DropDone>): DropDone => ({
    seq: change.seq,
    dropSeq: null,
    paths: change.paths,
    left: [],
    refused: null,
    ...patch,
  });
  if (change.droppedBy !== null) return done({ dropSeq: change.droppedBy });
  await onPassBranch(deps, pass, repo);
  if (change.dropOf !== null || change.landedSha !== null || change.paths.length === 0)
    return done({ refused: `Shared change ${String(change.seq)} is not on the chain to drop` });
  if (input.force !== true) {
    const refused = await refusalOf(deps, repo, change);
    if (refused !== null) return done({ refused });
  }
  const back = backOf(db, change);
  const { written, left } = await deps.git.restoreFiles(
    repo,
    change.paths.map((path) => ({ path, from: back })),
    change.paths.map((path) => ({ path, blob: change.blobs[path] ?? null })),
  );
  await deps.git.refreshIndex(repo, written);
  const ref = sharedRef(pass.id);
  const made = await extendChain(deps, {
    repo,
    ref,
    base: pass.startSha,
    paths: change.paths,
    from: back,
    message: `Drop of shared change ${String(change.seq)} of ${getTask(db, change.taskId).title}`,
    trailer: { key: DROP_TRAILER, value: String(change.seq) },
  });
  // A tree the chain holds already, with no drop commit of its own, is the chain's tip.
  const sha = made.sha ?? (await readKeptRef(deps.git, repo, ref)) ?? pass.startSha;
  const drop = deps.state.write((ctx) =>
    insertDrop(ctx, { passId: pass.id, of: change.seq, sha, files: made.files }),
  );
  return done({ dropSeq: drop.seq, left });
}

/**
 * The page's shared changes that have not landed (spec §5.4, §7.2), as a take-out or a close offers
 * Keep and Drop for them: why Drop is not offered, if it is not, and the pages that changed the same
 * paths later. A hold of the page that is still open is listed as well.
 */
export async function sharedUnlanded(
  deps: SharedDeps,
  input: { readonly passId: PassId; readonly taskId: TaskId },
): Promise<SharedUnlandedDto[]> {
  const db = deps.state.db;
  const pass = getPass(db, input.passId);
  const repo = getProject(db, pass.projectId).repoPath;
  const changes = listSharedChanges(db, pass.id);
  const holding = openHolds(db, pass.id).filter((h) => h.taskId === input.taskId);
  const mine = changes.filter(
    (c) => c.taskId === input.taskId && unlanded(c) && !holding.some((h) => h.seq === c.seq),
  );
  const kept = await Promise.all(
    mine.map(async (change) => ({
      seq: change.seq,
      paths: [...change.paths],
      dropRefusal: await refusalOf(deps, repo, change),
      laterPages: [...new Set(laterTouching(db, change).map((c) => getTask(db, c.taskId).title))],
    })),
  );
  // A hold the page's turn is making now is offered too, with the files it has changed so far: the
  // take-out stops the turn, which keeps it, before it drops it.
  const inProgress = await Promise.all(
    holding.map(async (hold) => ({
      seq: hold.seq,
      paths: await sharedPathsDiffering(deps, {
        repo,
        against: hold.recordSha,
        shared: sharedPathOf(db, pass, hold.area),
        also: changes.find((c) => c.seq === hold.seq)?.paths ?? [],
      }),
      dropRefusal: null,
      laterPages: [],
    })),
  );
  return [...kept, ...inProgress].sort((a, b) => a.seq - b.seq);
}
