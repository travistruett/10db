import { McpToolName, McpToolOutputs } from '@10db/contracts';
import { getProject, listToolOpResults, type DbReader, type WorkstreamRow } from '@10db/db';
import type { Git } from '../git';

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

/**
 * The run's commits from `base` to `head`, each range starting at its first commit's parent. The
 * builder's own checkout is shared: the builder and other tools commit on its branch too, so only the
 * commits the run's sessions made through the commit tool are the run's, and a commit of anyone
 * else's between two of them splits their history in two ranges. A worktree's branch holds only
 * 10db's commits, base merges included: every commit is the run's, in one range from `base` to `head`.
 */
export async function runCommits(
  deps: { readonly db: DbReader; readonly git: Pick<Git, 'commitsSince'> },
  row: WorkstreamRow,
  checkout: string,
  base: string,
  head: string,
): Promise<RunCommits> {
  const all = await deps.git.commitsSince(checkout, base, head);
  if (checkout !== getProject(deps.db, row.projectId).repoPath)
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
