import { randomUUID } from 'node:crypto';
import {
  AreaRole,
  ClaimKind,
  ConflictError,
  InvalidError,
  passHeldAreas,
  type PassDto,
  type PassFileChange,
  type PassId,
  type PassTurnId,
  type ProjectDto,
  type TaskDto,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  activeClaims,
  claimRequestsForTask,
  getBatch,
  getProject,
  getTask,
  getWorkstreamRow,
  listPassDirt,
  listPassTurns,
  maxGrantedSeq,
  passHoldingTask,
  passPageAreas,
  setPassTurnKept,
  type DbReader,
} from '@10db/db';
import type { Clock } from '../clock';
import type { DeliveryJobs } from '../delivery';
import type { StateStore } from '../events';
import { KeptRefMovedError, PassFolderOffBranchError, type Git, type KeptCommit } from '../git';
import type { InboxService } from '../inbox';
import type { Logger } from '../log';
import { classifyPath } from '../guard';

// Workbench spec §9.1: a turn's work is kept, not committed. At the end of each turn the task's page
// files, as they are on disk, are kept as an unsigned commit on the pass branch's tip at the task's
// own ref, and the branch does not move.

/** What the pass's work in Your folder needs. */
export interface PassWorkDeps {
  readonly state: StateStore;
  readonly git: Git;
  readonly inbox: InboxService;
  readonly jobs: DeliveryJobs;
  readonly logger: Logger;
  readonly clock: Clock;
}

/** A file a turn or a page changed, with its lines added and removed. */
export type FileChange = PassFileChange;

/** A task's kept work after a keep, or as its latest kept commit holds it. */
export interface KeptWork {
  /** The task's kept commit now; null while the task has never changed a page file. */
  readonly keptSha: string | null;
  /** The pass branch tip the work was compared with; always set, so it marks "kept" on a turn row. */
  readonly keptBaseSha: string;
  /** False when nothing changed since the previous kept commit. */
  readonly made: boolean;
  /** The files the kept commit changed, against the previous kept commit. */
  readonly turnFiles: readonly FileChange[];
  /** The page's files against the pass branch tip. */
  readonly pageFiles: readonly FileChange[];
  /** Page files still exactly as they were in the folder before the pass opened. */
  readonly fromBeforePass: readonly string[];
}

/** Where a pass task's work is kept while the task is in the pass. */
export const passKeptRef = (pass: PassId, task: TaskId): string =>
  `refs/10db/passes/${pass}/${task}`;

/** Where a task's work is kept once it has left its pass (spec §5.4). */
export const keptRef = (task: TaskId): string => `refs/10db/kept/${task}`;

/** The trailer that names the turn a kept commit holds, so a rerun of its keep finds it. */
const TURN_TRAILER = '10db-turn';

/** A pass task with what its work is kept against. */
export interface PassTaskPlace {
  readonly pass: PassDto;
  readonly task: TaskDto;
  readonly project: ProjectDto;
  readonly repo: string;
  /** The pass's branch. */
  readonly branch: string;
}

/** The pass's branch, which its batch names from the pass's opening on. */
export function passBranch(db: DbReader, pass: PassDto): string {
  const { branch } = getBatch(db, pass.batchId);
  if (branch === null) throw new ConflictError(`Pass "${pass.name}" has no branch`);
  return branch;
}

/** The pass that holds the task, with its branch and checkout; refused for a task no pass holds. */
export function passTaskPlace(db: DbReader, taskId: TaskId): PassTaskPlace {
  const task = getTask(db, taskId);
  const pass = passHoldingTask(db, task);
  if (!pass) throw new ConflictError(`${task.title} is in no open pass`);
  const project = getProject(db, pass.projectId);
  return {
    pass,
    task,
    project,
    repo: project.repoPath,
    branch: passBranch(db, pass),
  };
}

/** A claim on one of the task's page files. */
interface HeldClaim {
  readonly kind: ClaimKind;
  readonly name: string;
}

/**
 * The claims whose files are the task's pages (spec §7.1, §9.1): the page and hazard claims its run
 * holds now; once a crash path has released them, what the pass holds for it and the hazards it
 * names. A shared area is held a turn at a time, and its files are never page work.
 */
function pageClaims(db: DbReader, project: ProjectDto, task: TaskDto): readonly HeldClaim[] {
  const shared = new Set(
    project.areas.filter((a) => a.role === AreaRole.Shared).map((a) => a.name),
  );
  const active =
    task.workstreamId === null
      ? []
      : activeClaims(db, task.workstreamId)
          .filter((c) => !(c.kind === ClaimKind.Area && shared.has(c.name)))
          .map((c) => ({ kind: c.kind, name: c.name }));
  if (active.length > 0) return active;
  const held = new Set(passHeldAreas(project.areas, task));
  return claimRequestsForTask(task, project).filter(
    (r) => r.kind === ClaimKind.Hazard || held.has(r.name),
  );
}

/**
 * Whether a path is one of the task's page files, as the guard's judge reads a pass (spec §7.1): a
 * path in any page area of the pass belongs only to the task holding that page, whatever hazard also
 * matches it; a hazard or another held area counts only outside the pass's pages.
 */
export function pageMatcher(
  db: DbReader,
  project: ProjectDto,
  task: TaskDto,
  passId: PassId,
): (path: string) => boolean {
  const claims = pageClaims(db, project, task);
  const held = (kind: ClaimKind) =>
    new Set(claims.filter((c) => c.kind === kind).map((c) => c.name));
  const areas = held(ClaimKind.Area);
  const hazards = held(ClaimKind.Hazard);
  const passPages = new Set(passPageAreas(db, passId));
  return (path) => {
    const hit = classifyPath(path, project.areas, project.hazards);
    const pages = hit.areas.filter((a) => passPages.has(a));
    if (pages.length > 0) return pages.some((a) => areas.has(a));
    return hit.hazards.some((h) => hazards.has(h)) || hit.areas.some((a) => areas.has(a));
  };
}

/** What a kept ref names now, or null when there is none. */
export async function readKeptRef(git: Git, repo: string, ref: string): Promise<string | null> {
  return (await git.keptRefs(repo, ref)).includes(ref) ? git.commitAt(repo, ref) : null;
}

/** Each page file `to` changed against `from`, with its lines. */
async function filesBetween(
  git: Git,
  repo: string,
  from: string,
  to: string,
  mine: (path: string) => boolean,
): Promise<FileChange[]> {
  const { files } = await git.diffSince(repo, from, to, 0);
  return files
    .filter((f) => mine(f.path))
    .map((f) => ({ path: f.path, added: f.added ?? 0, removed: f.removed ?? 0 }));
}

/** The page files still holding the content the pass's dirt record took when it opened. */
async function stillFromBeforePass(
  db: DbReader,
  git: Git,
  place: PassTaskPlace,
  pageFiles: readonly FileChange[],
): Promise<string[]> {
  const pages = new Set(pageFiles.map((f) => f.path));
  const dirt = listPassDirt(db, place.pass.id).filter((d) => pages.has(d.path));
  if (dirt.length === 0) return [];
  const onDisk = new Map(
    (
      await git.hashOnDisk(
        place.repo,
        dirt.map((d) => d.path),
      )
    ).map((f) => [f.path, f.blob]),
  );
  return dirt.filter((d) => onDisk.get(d.path) === d.blob).map((d) => d.path);
}

/** The facts of a kept commit: the files it changed since `previous`, and the page against the tip. */
async function factsOf(
  deps: Pick<PassWorkDeps, 'state' | 'git'>,
  place: PassTaskPlace,
  kept: { readonly sha: string | null; readonly base: string; readonly made: boolean },
  previous: string,
): Promise<KeptWork> {
  const mine = pageMatcher(deps.state.db, place.project, place.task, place.pass.id);
  const pageFiles =
    kept.sha === null ? [] : await filesBetween(deps.git, place.repo, kept.base, kept.sha, mine);
  return {
    keptSha: kept.sha,
    keptBaseSha: kept.base,
    made: kept.made,
    turnFiles:
      kept.made && kept.sha !== null
        ? await filesBetween(deps.git, place.repo, previous, kept.sha, mine)
        : [],
    pageFiles,
    fromBeforePass: await stillFromBeforePass(deps.state.db, deps.git, place, pageFiles),
  };
}

/** What keeping a task's page work reads and writes. */
type KeepDeps = Pick<PassWorkDeps, 'state' | 'git'>;

/**
 * One more kept commit of the task's page work at its ref, named by `trailer`, with the ref's value
 * before it; with `only`, of those of its page files alone. Another keep that moved the ref meanwhile
 * is followed once, then the call fails.
 */
async function keepPageWork(
  deps: KeepDeps,
  workstreamId: WorkstreamId,
  trailer: string,
  only?: readonly string[],
): Promise<{
  readonly place: PassTaskPlace;
  readonly kept: KeptCommit;
  readonly parent: string | null;
}> {
  const db = deps.state.db;
  const place = passTaskPlace(db, getWorkstreamRow(db, workstreamId).taskId);
  const { git } = deps;
  const { repo, branch, task } = place;
  const found = await git.currentBranch(repo);
  if (found !== branch) throw new PassFolderOffBranchError(repo, branch, found);
  const mine = pageMatcher(db, place.project, task, place.pass.id);
  const ref = passKeptRef(place.pass.id, task.id);
  const keep = async () => {
    const parent = await readKeptRef(git, repo, ref);
    const kept = await git.keepWork({
      repo,
      branch,
      ref,
      paths: (await git.changedPaths(repo)).filter(
        (path) => mine(path) && (only === undefined || only.includes(path)),
      ),
      parent,
      message: `Kept work of ${task.title}`,
      trailer: { key: TURN_TRAILER, value: trailer },
    });
    return { kept, parent };
  };
  let done: Awaited<ReturnType<typeof keep>>;
  try {
    done = await keep();
  } catch (error) {
    if (!(error instanceof KeptRefMovedError)) throw error;
    done = await keep();
  }
  return { place, ...done };
}

/**
 * Keeps the task's page work (spec §9.1) as one more kept commit at its ref, under the repo lock, by
 * compare-and-swap; another keep that moved the ref meanwhile is followed once, then the call fails.
 * Its page files are those of `pageClaims` that differ from the pass branch's tip on disk. With a turn,
 * the commit carries its trailer, so a rerun finds it, and the turn row records it and the tip.
 * Refused with `PassFolderOffBranchError` while HEAD is not the pass's branch.
 */
export async function keepTurnWork(
  deps: PassWorkDeps,
  input: { readonly workstreamId: WorkstreamId; readonly turnId: PassTurnId | null },
): Promise<KeptWork> {
  const { turnId } = input;
  // A keep with no turn is its own work each time: nothing later may be taken for it.
  const { place, kept, parent } = await keepPageWork(
    deps,
    input.workstreamId,
    turnId ?? `none-${randomUUID()}`,
  );
  // A turn's files are what changed since the task's previous turn was kept, whatever kept commits
  // the commit tool or a fold made between.
  const previous =
    turnId === null
      ? parent
      : (listPassTurns(deps.state.db, place.pass.id)
          .filter((t) => t.taskId === place.task.id && t.id !== turnId && t.keptBaseSha !== null)
          .at(-1)?.keptSha ?? null);
  const facts = await factsOf(
    deps,
    place,
    { ...kept, made: kept.sha !== null && kept.sha !== previous },
    previous ?? kept.base,
  );
  if (turnId !== null)
    deps.state.write((ctx) =>
      setPassTurnKept(ctx, turnId, {
        keptSha: facts.keptSha,
        keptBaseSha: facts.keptBaseSha,
        // The page was built with every shared change granted so far, open holds included.
        sharedSeq: maxGrantedSeq(ctx.tx, place.pass.id),
      }),
    );
  return facts;
}

/**
 * Keeps the files a put-back wrote into the folder as the task's work in the pass that now holds it,
 * so the builder's next message does not take them for hand edits. Nothing for a task no pass holds.
 */
export async function keepPutBackWork(
  deps: KeepDeps,
  taskId: TaskId,
  paths: readonly string[],
): Promise<void> {
  const db = deps.state.db;
  const task = getTask(db, taskId);
  if (paths.length === 0 || task.workstreamId === null || !passHoldingTask(db, task)) return;
  await keepPageWork(deps, task.workstreamId, `put-back-${randomUUID()}`, paths);
}

/**
 * The commit tool of a pass lane (spec §6.2): keeps the task's page work, the named paths with it,
 * as `keepTurnWork` does, under the call's opId, and answers that kept commit; the pass's branch
 * never moves. A path that is not one of the task's pages is refused (a shared file under a held
 * area goes to its hold instead, `keepCommitToolPaths`), then any the guard's judge refuses. A retry with the same opId answers the commit it made;
 * nothing to keep is refused.
 */
export async function keepNamedPaths(
  deps: KeepDeps,
  input: {
    readonly workstreamId: WorkstreamId;
    readonly paths: readonly string[];
    readonly opId: string;
    /** Why the guard would refuse a write to the path, or null when it allows it. */
    readonly judge: (path: string) => string | null;
  },
): Promise<{ readonly sha: string; readonly alreadyCommitted: boolean }> {
  const db = deps.state.db;
  const place = passTaskPlace(db, getWorkstreamRow(db, input.workstreamId).taskId);
  const mine = pageMatcher(db, place.project, place.task, place.pass.id);
  const shared = input.paths.filter((path) => !mine(path));
  if (shared.length > 0)
    throw new InvalidError(
      `${shared.join(', ')} ${shared.length === 1 ? 'is' : 'are'} not in your page: shared code needs request_claim for its shared area first. Otherwise keep the change inside your page.`,
    );
  for (const path of input.paths) {
    const refused = input.judge(path);
    if (refused !== null) throw new InvalidError(refused);
  }
  const { kept, parent } = await keepPageWork(deps, input.workstreamId, `op-${input.opId}`);
  if (!kept.made || kept.sha === null)
    throw new InvalidError(`Nothing to commit in ${input.paths.join(', ')}`);
  return { sha: kept.sha, alreadyCommitted: kept.sha === parent };
}

/**
 * The facts a Ready item shows for the task's latest kept commit, read without writing: what its
 * latest kept turn changed against the turn before, and the page against the tip it was kept on.
 */
export async function keptWorkFacts(deps: PassWorkDeps, taskId: TaskId): Promise<KeptWork> {
  const db = deps.state.db;
  const place = passTaskPlace(db, taskId);
  const keptSha = await readKeptRef(deps.git, place.repo, passKeptRef(place.pass.id, taskId));
  const kept = listPassTurns(db, place.pass.id).filter(
    (t) => t.taskId === taskId && t.keptBaseSha !== null,
  );
  const latest = kept.at(-1);
  const before = kept.at(-2);
  const base = latest?.keptBaseSha ?? (await deps.git.commitAt(place.repo, place.branch));
  const made = keptSha !== null && (latest === undefined || latest.keptSha !== before?.keptSha);
  return factsOf(
    deps,
    place,
    { sha: keptSha, base, made },
    before?.keptSha ?? latest?.keptBaseSha ?? base,
  );
}
