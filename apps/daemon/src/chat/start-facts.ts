import { WHOLE_REPOSITORY_GLOBS, type ProjectDto } from '@10db/contracts';
import { latestFailedTaskTitle, type DbReader } from '@10db/db';
import { areaMatches } from '../guard';
import type { StartFacts } from './session-starts';

// UI spec §6.2: the facts Start from is built from. Each is read on its own; one that can't be read
// is none, so the others still offer theirs.

const DAY_MS = 24 * 60 * 60_000;
const FAILED_WITHIN_MS = 7 * DAY_MS;

/** Runs git in a checkout and answers its stdout. */
export type StartGit = (repo: string, args: readonly string[]) => Promise<string>;

const isWholeRepository = (globs: readonly string[]): boolean =>
  globs.some((glob) => WHOLE_REPOSITORY_GLOBS.includes(glob));

export async function startFacts(
  deps: { readonly db: DbReader; readonly git: StartGit },
  project: ProjectDto,
  now: Date,
): Promise<StartFacts> {
  const repo = project.repoPath;
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const failed = latestFailedTaskTitle(
    deps.db,
    project.id,
    new Date(now.getTime() - FAILED_WITHIN_MS).toISOString(),
  );
  const [count, files] = await Promise.all([
    deps
      .git(repo, ['rev-list', '--count', `--since=${since}`, project.baseBranch, '--'])
      .then((out) => Number.parseInt(out.trim(), 10))
      .catch(() => null),
    deps
      .git(repo, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD'])
      .then((out) => out.split('\0').filter((f) => f !== ''))
      .catch(() => []),
  ]);
  const covered = project.areas
    .filter((area) => !isWholeRepository(area.globs))
    .map((area) => ({
      name: area.name,
      n: files.filter((file) => area.globs.some((glob) => areaMatches(file, glob))).length,
    }))
    .filter((area) => area.n > 0)
    .sort((a, b) => b.n - a.n);
  return {
    failedTask: failed === null ? null : { title: failed },
    baseCommits: count === null || Number.isNaN(count) ? null : { base: project.baseBranch, count },
    recentArea: covered[0]?.name ?? null,
  };
}
