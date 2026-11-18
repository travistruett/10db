import { join } from 'node:path';
import {
  CARD_OPENS,
  CARD_RESOLVES_WHEN,
  Urgency,
  type ProjectDto,
  type ProjectId,
  type WorkstreamId,
} from '@10db/contracts';
import { getMcpApproval, type DbReader, type Json } from '@10db/db';
import type { AwsCredentialsExporter } from '../environment';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import {
  ProjectMcpError,
  readRepoMcp,
  repoMcpHash,
  resolveProjectMcp,
  withAwsCredentials,
  type ProjectMcp,
  type RepoMcp,
} from '../sessions';
import { earlierMcpApproval, requestMcpApproval } from './mcp-approval';
import type { InboxService } from './service';
import { BY_ANSWER, CardTier } from './card-tier';
import { resolveStaleCards } from './resolve-cards';

/**
 * What an MCP config card carries: the link that opens the project's own config file, where the fix is
 * made, and the closer that names the hash of that file. The fix can also be made elsewhere (an
 * environment variable, an AWS sign-in), so the card is answered by a dismiss as well; it still closes
 * itself when the config changes. The hash is the project checkout's, never a worktree's, so
 * alternating worktrees can't close and re-raise the card.
 */
function configCard(
  projectId: ProjectId,
  repoPath: string,
): {
  readonly closesWhen: typeof BY_ANSWER;
  readonly detail: Record<string, Json>;
} {
  return {
    closesWhen: BY_ANSWER,
    detail: {
      [CARD_OPENS]: { to: 'path', path: join(repoPath, '.mcp.json'), label: 'Open the Config' },
      [CARD_RESOLVES_WHEN]: {
        event: 'mcp_config_changed',
        projectId,
        hash: repoMcpHash(repoPath),
      },
    },
  };
}

/**
 * Closes the project's open MCP config cards raised on a config that has changed since: the project
 * checkout's config at `repoPath` hashes to something else now.
 */
export function resolveMcpConfigCards(
  db: DbReader,
  inbox: Pick<InboxService, 'resolve'>,
  projectId: ProjectId,
  repoPath: string,
): void {
  const hash = repoMcpHash(repoPath);
  resolveStaleCards(db, inbox, projectId, (when) =>
    when.event === 'mcp_config_changed' && when.projectId === projectId && when.hash !== hash
      ? "The repo's MCP config changed"
      : null,
  );
}

/** A flag for an approved server 10db can't run as written; it folds per server. */
export function flagMcpFailure(
  inbox: InboxService,
  projectId: ProjectId,
  workstreamId: WorkstreamId | null,
  failure: { readonly name: string; readonly message: string },
  repoPath: string,
): void {
  inbox.flag({
    projectId,
    workstreamId,
    tier: CardTier.Ask,
    urgency: Urgency.Normal,
    ...configCard(projectId, repoPath),
    title: `The repo's MCP server "${failure.name}" can't run as written`,
    body: failure.message,
    foldKey: `project-mcp-failure:${projectId}:${failure.name}`,
  });
}

export interface ProjectMcpReaderDeps {
  readonly state: StateStore;
  readonly inbox: InboxService;
  readonly logger: Logger;
  /** Short-lived credentials for a server's declared AWS profile; the server never reads `~/.aws`. */
  readonly exportAwsCredentials: AwsCredentialsExporter;
}

export interface ProjectMcpRead {
  readonly project: ProjectDto;
  readonly checkout: string;
  /** The workstream the cards belong to; null for a session that has none. */
  readonly workstreamId: WorkstreamId | null;
  /** The session's project env: the servers expand from it, and the AWS CLI runs in it. */
  readonly env: Readonly<Record<string, string>>;
}

export interface ProjectMcpReader {
  /**
   * The repo's MCP servers for one session. Only servers the builder approved for their exact config are
   * passed; the session starts either way. A server with no verdict gets an approval card, one 10db can't
   * run as written (an AWS export that failed included) gets a flag naming the cause, and a reserved
   * name gets a warning flag. Every card folds, so a retried session adds none. A file 10db can't parse
   * raises a flag that says why, then throws, so the session fails before its row is written.
   */
  read(input: ProjectMcpRead): Promise<ProjectMcp>;
}

export function createProjectMcpReader(deps: ProjectMcpReaderDeps): ProjectMcpReader {
  return {
    async read({ project, checkout, workstreamId, env }) {
      // A config that changed since a card was raised ends the card, whether or not this read is clean.
      resolveMcpConfigCards(deps.state.db, deps.inbox, project.id, project.repoPath);
      let repo: RepoMcp;
      try {
        repo = readRepoMcp(checkout);
      } catch (error) {
        if (error instanceof ProjectMcpError) {
          deps.inbox.flag({
            projectId: project.id,
            workstreamId,
            tier: CardTier.Ask,
            urgency: Urgency.High,
            ...configCard(project.id, project.repoPath),
            title: "The repo's MCP config stops sessions from starting",
            body: error.message,
            foldKey: `project-mcp-error:${project.id}`,
          });
        }
        throw error;
      }
      const resolved = resolveProjectMcp({
        repo,
        env,
        approvalFor: (review) =>
          getMcpApproval(deps.state.db, project.id, review.name, review.configHash),
      });
      const mcp = await withAwsCredentials({
        mcp: resolved,
        repo,
        env,
        exportAwsCredentials: deps.exportAwsCredentials,
      });
      for (const warning of mcp.warnings) {
        deps.inbox.flag({
          projectId: project.id,
          workstreamId,
          tier: CardTier.Ask,
          urgency: Urgency.Normal,
          ...configCard(project.id, project.repoPath),
          title: "Check the repo's MCP config",
          body: warning,
          foldKey: `project-mcp-warning:${project.id}`,
        });
      }
      for (const review of mcp.pending)
        requestMcpApproval(
          deps.inbox,
          project.id,
          review,
          earlierMcpApproval(deps.state.db, project.id, review.name),
        );
      for (const failure of mcp.failures)
        flagMcpFailure(deps.inbox, project.id, workstreamId, failure, project.repoPath);
      // Names only, never values. The live acceptance check reads this line by its message and field names.
      deps.logger.info(
        {
          workstreamId,
          passed: Object.entries(mcp.servers).map(([name, server]) => ({
            name,
            transport: server.type,
            envKeys: server.type === 'stdio' ? Object.keys(server.env).sort() : [],
          })),
          pending: mcp.pending.map((r) => r.name),
          denied: mcp.denied,
          failed: mcp.failures.map((f) => f.name),
        },
        'project mcp servers',
      );
      return mcp;
    },
  };
}
