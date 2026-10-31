import type { ProjectId } from '@10db/contracts';
import { getAppSetting, getProject } from '@10db/db';
import type { StateStore } from '../events';
import type { Git } from '../git';
import type { Logger } from '../log';
import { writeFoundHostsIfNone } from '../permissions';
import { findRegistryHostsAt } from './find-registry-hosts';

const key = (projectId: ProjectId): string => `network-hosts-found:${projectId}`;

/**
 * Gives a project that has no reading of its package files one, read from the files committed on its
 * default branch through the daemon's git, and keeps it: a project added before 10db kept a reading
 * has none, and its blocked-host cards could not name the file that needs a host. A project that has
 * a reading, even an empty one, is left alone, so a reading is made once.
 *
 * The files are those of a commit, ones the builder merged, never a lane's uncommitted edits, so a
 * card's recommendation is not something a lane writes. Allows nothing: a reading says only which file
 * names a host. A branch git can't read leaves the project without a reading, to be tried again, and
 * is only logged: the card that asked still reaches the builder, without the file's name.
 */
export async function takeFoundHostsReading(
  deps: {
    readonly state: StateStore;
    readonly git: Pick<Git, 'regularFilesAt' | 'fileAt'>;
    readonly logger: Logger;
  },
  projectId: ProjectId,
): Promise<void> {
  if (getAppSetting(deps.state.db, key(projectId)) !== undefined) return;
  const project = getProject(deps.state.db, projectId);
  const revs = [`refs/heads/${project.baseBranch}`, `refs/remotes/origin/${project.baseBranch}`];
  for (const rev of revs) {
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
