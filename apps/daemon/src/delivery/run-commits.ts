import { McpToolName, McpToolOutputs } from '@10db/contracts';
import {
  getProject,
  listToolOpResults,
  listWorkstreams,
  type DbReader,
  type WorkstreamRow,
} from '@10db/db';
import type { Git } from '../git';
import { laneBranchOf, type LaneBranch } from './lane-branch';

type DiffSince = Awaited<ReturnType<Git['diffSince']>>;

/** A stretch of first-parent history made only of the run's commits: `base` is the commit before it. */
export interface CommitRange {
  readonly base: string;
  readonly head: string;
}

/** What a run committed between two commits, and the stretches of history its commits make up. */
export interface RunCommits {
  readonly commits: readonly string[];
  readonly ranges: readonly CommitRange[];
}

/** The commits the run's sessions made through the commit tool. */
function committedByRun(db: DbReader, row: WorkstreamRow): Set<string> {
  return new Set(
    listToolOpResults(db, row.id, McpToolName.Commit).flatMap((result) => {
      const parsed = McpToolOutputs.commit.safeParse(result);
      return parsed.success ? [parsed.data.sha] : [];
    }),
  );
}

/** Whether another workstream of the run's batch works in the same worktree and commits on its branch. */
function sharesWorktree(db: DbReader, row: WorkstreamRow): boolean {
  if (row.batchId === null) return false;
  return listWorkstreams(db, { batchId: row.batchId }).some((w) => w.id !== row.id);
}

/**
 * The run's commits from `base` to `head`, each range starting at its first commit's parent. The
 * builder's own checkout is shared: the builder and other tools commit on its branch too, so only the
 * commits the run's sessions made through the commit tool are the run's, and a commit of anyone
 * else's between two of them splits their history in two ranges. A batch worktree several runs share
 * is read the same way: its other runs, and 10db's base merges and regenerations, commit on its
 * branch too. A worktree only this run works in holds only its own and 10db's commits: every commit
 * is the run's, in one range from `base` to `head`.
 */
export async function runCommits(
  deps: { readonly db: DbReader; readonly git: Pick<Git, 'commitsSince' | 'branchTip'> },
  row: WorkstreamRow,
  checkout: string,
  base: string,
  head: string,
): Promise<RunCommits> {
  const lane = laneBranchOf(row);
  if (lane !== null) return laneCommits(deps.git, checkout, lane);
  const all = await deps.git.commitsSince(checkout, base, head);
  if (checkout !== getProject(deps.db, row.projectId).repoPath && !sharesWorktree(deps.db, row))
    return { commits: all, ranges: [{ base, head }] };
  const own = committedByRun(deps.db, row);
  const ranges: CommitRange[] = [];
  let open: { base: string; head: string } | null = null;
  for (const sha of all) {
    if (!own.has(sha)) open = null;
    else if (open !== null) open.head = sha;
    else {
      // From the commit's own first parent: `base` need not be one, as after the builder reset the branch.
      open = { base: `${sha}^`, head: sha };
      ranges.push(open);
    }
  }
  return { commits: all.filter((sha) => own.has(sha)), ranges };
}

/**
 * A Your-folder run of a Commit Directly project commits on its own lane branch, which starts on the
 * base: its work is the branch's commits the base lacks, in one range. A landing adds one commit of
 * its own to the base, so the lane's commits stay its work after it lands.
 */
async function laneCommits(
  git: Pick<Git, 'commitsSince' | 'branchTip'>,
  checkout: string,
  lane: LaneBranch,
): Promise<RunCommits> {
  const tip = await git.branchTip(checkout, lane.lane);
  if (tip === null) return { commits: [], ranges: [] };
  const commits = await git.commitsSince(checkout, `refs/heads/${lane.base}`, tip);
  const [first] = commits;
  if (first === undefined) return { commits: [], ranges: [] };
  return { commits, ranges: [{ base: `${first}^`, head: tip }] };
}

/**
 * The changes `ranges` make, as one diff: each range's diff in order, cut to `maxBytes` in all, and
 * each file's line counts summed over the ranges that change it (null when any shows it as binary).
 * With `paths.only`, the diff and the counts cover only those files.
 */
export async function diffOfRanges(
  git: Pick<Git, 'diffSince'>,
  checkout: string,
  ranges: readonly CommitRange[],
  maxBytes: number,
  paths?: { readonly only: readonly string[] },
): Promise<DiffSince> {
  const [single] = ranges;
  if (single !== undefined && ranges.length === 1)
    return git.diffSince(checkout, single.base, single.head, maxBytes, paths);
  const parts: string[] = [];
  let left = maxBytes;
  let truncated = false;
  const files = new Map<string, { added: number | null; removed: number | null }>();
  for (const range of ranges) {
    const part = await git.diffSince(checkout, range.base, range.head, Math.max(left, 0), paths);
    parts.push(part.diff);
    left -= Buffer.byteLength(part.diff, 'utf8');
    truncated ||= part.truncated;
    for (const f of part.files) {
      const had = files.get(f.path);
      files.set(
        f.path,
        had === undefined
          ? { added: f.added, removed: f.removed }
          : {
              added: had.added === null || f.added === null ? null : had.added + f.added,
              removed: had.removed === null || f.removed === null ? null : had.removed + f.removed,
            },
      );
    }
  }
  return {
    diff: parts.join(''),
    truncated,
    files: [...files].map(([path, counts]) => ({ path, ...counts })),
  };
}
