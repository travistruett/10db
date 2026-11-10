import { WorkstreamState, type PassDto, type TaskDto } from '@10db/contracts';
import {
  getProject,
  getWorkstreamRow,
  listPassDirt,
  listPassTasks,
  listSharedChanges,
  type DbReader,
} from '@10db/db';
import type { Git } from '../git';
import { pageMatcher, passBranch, type PassWorkDeps } from './kept-work';

// Workbench spec §5.4, W10, §18: what a close lists besides its pages. A file in Your folder that
// differs from the pass's branch and that no unfinished page owns is the builder's to place or leave
// out; a commit on the pass's branch that 10db did not make is in the pull request all the same.

/** A file no unfinished page owns, with its lines against the pass's branch. */
export interface UnownedFile {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  /** The file is exactly as it was dirty when the pass opened. */
  readonly fromBeforePass: boolean;
}

/** The pass's pages that are not signed off: their runs have not reached DONE. */
export function unfinishedPages(db: DbReader, passId: PassDto['id']): TaskDto[] {
  return listPassTasks(db, passId).filter(
    (task) =>
      task.workstreamId === null ||
      getWorkstreamRow(db, task.workstreamId).state !== WorkstreamState.Done,
  );
}

/**
 * The files of Your folder that differ from the pass's branch tip and that no unfinished page owns,
 * nor a shared change still on the chain: a signed-off page's file edited since counts, as does a
 * file under no page at all. Each carries its lines added and removed, and whether it is the dirt
 * the pass opened on. Reads only.
 */
export async function unownedFiles(
  deps: Pick<PassWorkDeps, 'state' | 'git'>,
  pass: PassDto,
): Promise<UnownedFile[]> {
  const db = deps.state.db;
  const project = getProject(db, pass.projectId);
  const repo = project.repoPath;
  const tip = await deps.git.commitAt(repo, passBranch(db, pass));
  const owners = unfinishedPages(db, pass.id).map((task) =>
    pageMatcher(db, project, task, pass.id),
  );
  const shared = new Set(
    listSharedChanges(db, pass.id)
      .filter((c) => c.dropOf === null && c.droppedBy === null && c.landedSha === null)
      .flatMap((c) => c.paths),
  );
  const changed = (await changedAgainst(deps.git, repo, tip)).filter(
    (path) => !shared.has(path) && !owners.some((owns) => owns(path)),
  );
  if (changed.length === 0) return [];
  const dirt = new Map(listPassDirt(db, pass.id).map((d) => [d.path, d.blob]));
  const onDisk = new Map((await deps.git.hashOnDisk(repo, changed)).map((f) => [f.path, f.blob]));
  const lines = new Map((await deps.git.pageChanges(repo, tip, changed)).map((l) => [l.path, l]));
  return changed.map((path) => ({
    path,
    added: lines.get(path)?.added ?? 0,
    removed: lines.get(path)?.removed ?? 0,
    fromBeforePass: dirt.has(path) && dirt.get(path) === (onDisk.get(path) ?? null),
  }));
}

/** The paths of the folder whose content differs from commit `tip`, sorted. */
async function changedAgainst(git: Git, repo: string, tip: string): Promise<string[]> {
  const paths = await git.changedPaths(repo);
  return (await git.pageChanges(repo, tip, paths)).map((l) => l.path).sort();
}

/** A commit on the pass's branch since its start that 10db did not make (§18), oldest first. */
export interface ForeignCommit {
  readonly sha: string;
  readonly subject: string;
}

/**
 * The commits the pass's branch has since its start that carry no 10db operation id: one typed by
 * hand in the folder, which the pull request holds whatever the pass signed off.
 */
export async function foreignCommits(
  deps: Pick<PassWorkDeps, 'state' | 'git'>,
  pass: PassDto,
): Promise<ForeignCommit[]> {
  const db = deps.state.db;
  const repo = getProject(db, pass.projectId).repoPath;
  const branch = passBranch(db, pass);
  const since = new Set(await deps.git.commitsSince(repo, pass.startSha, branch));
  if (since.size === 0) return [];
  return (await deps.git.ownCommitsWithSubject(repo, branch, ''))
    .filter((c) => since.has(c.sha))
    .map((c) => ({ sha: c.sha, subject: c.message.split('\n')[0] ?? '' }));
}
