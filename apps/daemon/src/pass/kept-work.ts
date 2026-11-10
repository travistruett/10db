import { randomUUID } from 'node:crypto';
import {
  AreaRole,
  ClaimKind,
  ConflictError,
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
  passHoldingTask,
  setPassTurnKept,
  type DbReader,
} from '@10db/db';
import type { Clock } from '../clock';
import type { DeliveryJobs } from '../delivery';
import type { StateStore } from '../events';
import { KeptRefMovedError, PassFolderOffBranchError, type Git } from '../git';
import type { InboxService } from '../inbox';
import type { Logger } from '../log';
import { findClaimed } from '../watcher';

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

/** A claim as `findClaimed` reads it. */
interface HeldClaim {
  readonly kind: ClaimKind;
  readonly name: string;
}

/**
 * The claims whose files are the task's pages (spec §7.1, §9.1): the page and hazard claims its run
 * holds now; once a crash path has released them, what the pass holds for it and the hazards it
 * names. A shared area is held a turn at a time, and its files are never page work.
 */
export function pageClaims(db: DbReader, project: ProjectDto, task: TaskDto): readonly HeldClaim[] {
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

/** Whether a path is one of the task's page files. */
function pageMatcher(project: ProjectDto, claims: readonly HeldClaim[]) {
  return (path: string): boolean => findClaimed([path], project, claims).length > 0;
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
  deps: PassWorkDeps,
  place: PassTaskPlace,
  kept: { readonly sha: string | null; readonly base: string; readonly made: boolean },
  previous: string,
): Promise<KeptWork> {
  const mine = pageMatcher(place.project, pageClaims(deps.state.db, place.project, place.task));
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
  const db = deps.state.db;
  const place = passTaskPlace(db, getWorkstreamRow(db, input.workstreamId).taskId);
  const { git } = deps;
  const { repo, branch, task } = place;
  const found = await git.currentBranch(repo);
  if (found !== branch) throw new PassFolderOffBranchError(repo, branch, found);
  const mine = pageMatcher(place.project, pageClaims(db, place.project, task));
  const ref = passKeptRef(place.pass.id, task.id);
  const keep = async () => {
    const parent = await readKeptRef(git, repo, ref);
    const kept = await git.keepWork({
      repo,
      branch,
      ref,
      paths: (await git.changedPaths(repo)).filter(mine),
      parent,
      message: `Kept work of ${task.title}`,
      // A keep with no turn is its own work each time: nothing later may be taken for it.
      trailer: { key: TURN_TRAILER, value: input.turnId ?? `none-${randomUUID()}` },
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
  const facts = await factsOf(deps, place, done.kept, done.parent ?? done.kept.base);
  const { turnId } = input;
  if (turnId !== null)
    deps.state.write((ctx) =>
      setPassTurnKept(ctx, turnId, {
        keptSha: facts.keptSha,
        keptBaseSha: facts.keptBaseSha,
        sharedSeq: null,
      }),
    );
  return facts;
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
