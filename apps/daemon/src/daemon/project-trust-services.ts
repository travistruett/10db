import { getProject } from '@10db/db';
import type { ApiServices } from '../api';
import type { StateStore } from '../events';
import type { Git } from '../git';
import { createRepoMcpServers, type InboxService } from '../inbox';
import { projectLiveSystems, proposeProduction } from '../trust';

export type ProjectTrustServices = Pick<
  ApiServices,
  'liveSystemProposals' | 'repoMcpServers' | 'setRepoMcpVerdict'
>;

/**
 * What a project's Trust page reads from its repo: the checkout's MCP servers with the same approval the
 * Inbox card gives, and the production systems the repo suggests.
 */
export function createProjectTrustServices(deps: {
  readonly state: StateStore;
  readonly inbox: InboxService;
  readonly git: Git;
}): ProjectTrustServices {
  const db = deps.state.db;
  const repoMcp = createRepoMcpServers({ state: deps.state, inbox: deps.inbox });
  return {
    repoMcpServers: (projectId) => repoMcp.list(projectId),
    setRepoMcpVerdict: (projectId, name, input) => repoMcp.set(projectId, name, input),
    async liveSystemProposals(projectId) {
      const project = getProject(db, projectId);
      // A list the daemon can't read is shown empty by the Production card itself, so nothing is listed.
      const listed = projectLiveSystems(db, projectId, () => undefined);
      return { proposals: await proposeProduction(deps.git, project, listed) };
    },
  };
}
