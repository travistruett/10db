import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidError, type ProjectDto } from '@10db/contracts';
import { slugOf } from './branch-name';

/** The worktree root, made owner-only when missing, as a real path. */
export function madeWorktreeRoot(root: string): string {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    return realpathSync(root);
  } catch (error) {
    throw new InvalidError(
      `10db can't make its worktree root ${root}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The project id's tail in its worktree directory: enough to tell two projects of one name apart. */
const PROJECT_ID_SUFFIX = 6;

/**
 * `<root>/<project slug>-<last 6 hex of the project id>/<branch leaf>`: one directory per project, so
 * two projects with the same slug never share one. Every part is a slug or hex, so the path can't
 * leave `root`.
 */
export function worktreePathFor(
  root: string,
  project: Pick<ProjectDto, 'id' | 'name'>,
  branch: string,
): string {
  const leaf = branch.slice(branch.lastIndexOf('/') + 1);
  return join(
    root,
    `${slugOf(project.name, 'project')}-${project.id.slice(-PROJECT_ID_SUFFIX)}`,
    leaf,
  );
}
