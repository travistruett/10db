import type { ProjectDto, ProjectId } from '@10db/contracts';
import { getAppSetting, getProject } from '@10db/db';
import type { StateStore } from '../events';
import type { Git } from '../git';
import type { Logger } from '../log';
import { writeFoundHostsIfNone } from '../permissions';
import { findRegistryHostsAt } from './find-registry-hosts';

const key = (projectId: ProjectId): string => `network-hosts-found:${projectId}`;

/**
 * The commit a reading may take a project's files from: one no lane can move. Only the fetched
 * `origin` copy of the base branch counts, whatever the delivery mode now: a lane's commit tool
 * commits on the branch its workstream pinned, often the local base branch itself, and it did so
 * under `local` delivery even if the builder has since switched the project to `pull_request`. A lane
 * can neither push nor write `.git`.
 */
function trustedRevs(project: ProjectDto): string[] {
  return [`refs/remotes/origin/${project.baseBranch}`];
}

/**
 * Gives a project that has no reading of its package files one, read from the files committed on its
 * default branch through the daemon's git, and keeps it: a project added before 10db kept a reading
 * has none, and its blocked-host cards could not name the file that needs a host. A project that has
 * a reading, even an empty one, is left alone, so a reading is made once.
 *
 * The files are those of a commit no lane can make (see `trustedRevs`), never a lane's uncommitted
 * edits, so a card's recommendation is not something a lane writes. Allows nothing: a reading says
 * only which file names a host. A branch git can't read leaves the project without a reading, to be
 * tried again, and is only logged: the card that asked still reaches the builder, without the file's
 * name.
 */
export async function takeFoundHostsReading(
  deps: {
    readonly state: StateStore;
    readonly git: Pick<Git, 'commitAt' | 'folderAt' | 'fileAt'>;
    readonly logger: Logger;
  },
  projectId: ProjectId,
): Promise<void> {
  if (getAppSetting(deps.state.db, key(projectId)) !== undefined) return;
  const project = getProject(deps.state.db, projectId);
  for (const rev of trustedRevs(project)) {
    try {
      const found = await findRegistryHostsAt(deps.git, project.repoPath, rev);
      deps.state.write((ctx) => {
        writeFoundHostsIfNone(ctx, projectId, found);
      });
      return;
    } catch (error) {
      deps.logger.debug(
        { projectId, rev, err: error instanceof Error ? error.message : String(error) },
        'package file hosts not read from the default branch',
      );
    }
  }
}
