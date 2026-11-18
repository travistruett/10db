import type { ProjectDto } from '@10db/contracts';
import { existsAsEntry, type Git } from '../git';
import { looseWork } from './build-output';
import { unseededIgnoredFiles } from './worktree-cleanup';

/** The words for a worktree whose git directory 10db would not read: removing it would still take what it holds. */
const UNREADABLE = '(files in this worktree could not be listed)';

/**
 * What removing a session's worktree at `path` would lose: its uncommitted changes, and the git-ignored files
 * 10db did not seed (build output left out), as the startup sweep reads them. Nothing for a worktree that is gone.
 */
export async function chatWorktreeLosses(
  git: Pick<Git, 'worktreeChanges' | 'worktreeIgnoredFiles'>,
  project: Pick<ProjectDto, 'repoPath' | 'worktreeSeed'>,
  path: string,
): Promise<{ readonly uncommitted: string[]; readonly ignored: string[] }> {
  if (!existsAsEntry(path)) return { uncommitted: [], ignored: [] };
  const uncommitted = await git.worktreeChanges(project.repoPath, path);
  const ignored = await unseededIgnoredFiles(git, project.repoPath, path, project.worktreeSeed);
  return { uncommitted, ignored: ignored === null ? [UNREADABLE] : looseWork(ignored) };
}
