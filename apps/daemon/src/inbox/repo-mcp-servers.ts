import {
  ConflictError,
  InvalidError,
  McpApprovalChoice,
  McpVerdict,
  NotFoundError,
  type ProjectId,
  type RepoMcpServerDto,
  type RepoMcpServersDto,
  type SetRepoMcpVerdict,
} from '@10db/contracts';
import { findOpenByFoldKey, getMcpApproval, getProject, recordMcpApproval } from '@10db/db';
import type { StateStore } from '../events';
import { ProjectMcpError, readRepoMcp, type RepoMcp } from '../sessions';
import { approvalBody, earlierMcpApproval, mcpApprovalFoldKey } from './mcp-approval';
import type { InboxService } from './service';

/** The checkout's `.mcp.json` as the builder reviews it; its own error text when it can't be read. */
function readReview(repoPath: string): { repo: RepoMcp } | { error: string } {
  try {
    return { repo: readRepoMcp(repoPath) };
  } catch (error) {
    if (error instanceof ProjectMcpError) return { error: error.message };
    throw error;
  }
}

/**
 * The repo's MCP servers on Settings › Trust. Listing raises no card; a verdict written here answers the
 * server's open approval card when one waits, so the card closes with it, and otherwise records the same
 * verdict an answered card would, for the exact config the builder saw.
 */
export function createRepoMcpServers(deps: {
  readonly state: StateStore;
  readonly inbox: InboxService;
}): {
  list(projectId: ProjectId): RepoMcpServersDto;
  set(projectId: ProjectId, name: string, input: SetRepoMcpVerdict): RepoMcpServersDto;
} {
  const db = deps.state.db;

  const list = (projectId: ProjectId): RepoMcpServersDto => {
    const project = getProject(db, projectId);
    const read = readReview(project.repoPath);
    if ('error' in read) return { servers: [], error: read.error };
    const servers = read.repo.servers.map(({ review }): RepoMcpServerDto => {
      const earlier = earlierMcpApproval(db, projectId, review.name);
      const body = approvalBody(review, earlier);
      const earlierHosts = earlier === undefined ? null : [...earlier.hosts];
      const approval = getMcpApproval(db, projectId, review.name, review.configHash);
      if (approval)
        return { ...review, verdict: approval.verdict, inboxId: null, body, earlierHosts };
      const card = findOpenByFoldKey(db, projectId, mcpApprovalFoldKey(projectId, review));
      return { ...review, verdict: 'pending', inboxId: card?.id ?? null, body, earlierHosts };
    });
    return { servers, error: null };
  };

  return {
    list,
    set(projectId, name, input) {
      const project = getProject(db, projectId);
      const read = readReview(project.repoPath);
      if ('error' in read) throw new InvalidError(read.error);
      const server = read.repo.servers.find((s) => s.name === name);
      if (server === undefined) throw new NotFoundError('MCP server', name);
      const { review } = server;
      // The page showed a config that has changed since: nothing is written.
      if (review.configHash !== input.configHash)
        throw new ConflictError('The config changed; look again.');
      const approve = input.verdict === McpVerdict.Approved;
      const card = findOpenByFoldKey(db, projectId, mcpApprovalFoldKey(projectId, review));
      if (card) {
        deps.inbox.answer(card.id, {
          choice: approve ? McpApprovalChoice.Approve : McpApprovalChoice.Deny,
        });
      } else {
        deps.state.write((ctx) => {
          recordMcpApproval(ctx, {
            projectId,
            serverName: review.name,
            configHash: review.configHash,
            verdict: input.verdict,
            variables: approve ? review.variables : [],
            hosts: approve ? review.hosts : [],
            sourceInboxId: null,
          });
        });
      }
      return list(projectId);
    },
  };
}
