import type { ClaimId, PassDto, PassId } from '@10db/contracts';
import { getProject, listPassTasks, passPageAreas, type DbReader } from '@10db/db';
import { classifyPath } from '../guard';
import {
  KeptRefMovedError,
  PassFolderOffBranchError,
  type ChainCommit,
  type ChainCommitInput,
} from '../git';
import { pageMatcher, passBranch, readKeptRef, type PassWorkDeps } from './kept-work';

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

/**
 * Refuses with `PassFolderOffBranchError` while HEAD does not name the pass's branch: the folder's
 * files are then another branch's, and nothing of them is a hold's record or a shared change.
 */
export async function onPassBranch(deps: SharedDeps, pass: PassDto, repo: string): Promise<void> {
  const branch = passBranch(deps.state.db, pass);
  const found = await deps.git.currentBranch(repo);
  if (found !== branch) throw new PassFolderOffBranchError(repo, branch, found);
}

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

/** How many times a change follows other turn ends that moved the chain before it gives up. */
const CHAIN_TRIES = 8;

/**
 * One change on the pass's chain (`Git.chainCommit`) on the tip read just before, read again and
 * tried again while other keeps or drops move it, up to `CHAIN_TRIES` times.
 */
export async function extendChain(
  deps: SharedDeps,
  input: Omit<ChainCommitInput, 'expect'>,
): Promise<ChainCommit> {
  for (let tries = 1; ; tries += 1) {
    try {
      return await deps.git.chainCommit({
        ...input,
        expect: await readKeptRef(deps.git, input.repo, input.ref),
      });
    } catch (error) {
      if (!(error instanceof KeptRefMovedError) || tries >= CHAIN_TRIES) throw error;
    }
  }
}
