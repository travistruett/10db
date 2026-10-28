import { join } from 'node:path';
import type { ProjectDto } from '@10db/contracts';
import { slugOf } from './branch-name';

/** The project id's tail in its worktree directory: enough to tell two projects of one name apart. */
const PROJECT_ID_SUFFIX = 6;

/**
 * `<root>/<project slug>-<last 6 hex of the project id>/<branch leaf>` (W4). Every part is a slug or
 * hex, so the path can't leave `root`.
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
