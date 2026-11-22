import {
  ConflictError,
  InvalidError,
  LinearBinding,
  LinearVia,
  type ChatDto,
  type ChatId,
  type LinearSignInsDto,
  type LinkLinearTeamInput,
  type ProjectId,
  type ProjectLinearDto,
} from '@10db/contracts';
import { deleteAppSetting, getAppSetting, getProject, setAppSetting } from '@10db/db';
import type { ChatService } from '../chat';
import type { StateStore } from '../events';
import type { Logger } from '../log';

/** Where a project's Linear binding is stored, in the `trust.<project>` pattern. */
const bindingKey = (projectId: ProjectId): string => `linear.${projectId}`;

/** How long a finished check's session stays open, so the tool's own answer reaches it first. */
const ARCHIVE_AFTER_MS = 2_000;

export interface LinearBindings {
  /** The project's binding, and the check in flight or the reason the last one refused. */
  get(projectId: ProjectId): ProjectLinearDto;
  /** Opens a session on the project's account that reads the workspace and looks the team up. */
  check(projectId: ProjectId, teamKey: string): Promise<ProjectLinearDto>;
  /** `link_linear_team`: writes the binding, or records the refusal, for the check this chat is. */
  submit(projectId: ProjectId, chatId: ChatId, input: LinkLinearTeamInput): ProjectLinearDto;
  unlink(projectId: ProjectId): ProjectLinearDto;
  /** From Linear: a Plan session whose opening brief names the linked workspace and team; ConflictError when none is linked. */
  startImport(projectId: ProjectId): ChatDto;
}

type Check =
  | { readonly state: 'checking'; readonly teamKey: string; readonly chatId: ChatId }
  | { readonly state: 'refused'; readonly teamKey: string; readonly reason: string };

/**
 * A project's Linear binding: the workspace and team a session read through the builder's own sign-in. The check
 * runs as a visible session on the project's account, so it reaches Linear the way that account's sessions do on
 * every provider. Its one check per project is held in memory: a restart drops it, and the builder presses Link again.
 */
export function createLinearBindings(deps: {
  readonly state: StateStore;
  readonly chat: Pick<ChatService, 'create' | 'send' | 'patch' | 'archive' | 'open'>;
  /** How each account reaches Linear, from cached reads. */
  readonly signIns: { list(): Promise<LinearSignInsDto> };
  readonly log: Logger;
}): LinearBindings {
  const checks = new Map<ProjectId, Check>();

  const stored = (projectId: ProjectId): LinearBinding | null => {
    const parsed = LinearBinding.safeParse(getAppSetting(deps.state.db, bindingKey(projectId)));
    return parsed.success ? parsed.data : null;
  };
  const view = (projectId: ProjectId): ProjectLinearDto => ({
    binding: stored(projectId),
    check: checks.get(projectId) ?? null,
  });
  const archiveLater = (chatId: ChatId): void => {
    const timer = setTimeout(() => {
      deps.chat.archive(chatId).catch((error: unknown) => {
        deps.log.warn({ err: error, chatId }, 'the Linear check session could not be archived');
      });
    }, ARCHIVE_AFTER_MS);
    timer.unref();
  };

  return {
    get: view,

    async check(projectId, teamKey) {
      const project = getProject(deps.state.db, projectId);
      if (checks.get(projectId)?.state === 'checking')
        throw new ConflictError('A Linear check is already running for this project.');
      const accountId = project.accountId;
      const row = (await deps.signIns.list()).rows.find((r) => r.accountId === accountId);
      if (row?.via === LinearVia.None && !row.unchecked)
        throw new ConflictError(row.note ?? "This project's account has no Linear sign-in.");
      const chat = deps.chat.create({
        projectId,
        model: null,
        tabPosition: deps.chat.open().length,
      });
      checks.set(projectId, { state: 'checking', teamKey, chatId: chat.id });
      try {
        await deps.chat.patch(chat.id, { title: `Link Linear team ${teamKey}` });
        deps.chat.send(chat.conversationId, {
          text: openingMessage(teamKey),
          mentions: [],
          pictures: [],
        });
      } catch (error) {
        checks.delete(projectId);
        throw error;
      }
      return view(projectId);
    },

    submit(projectId, chatId, input) {
      const check = checks.get(projectId);
      if (check?.state !== 'checking' || check.chatId !== chatId)
        throw new ConflictError(
          'No Linear check is waiting on this session, so nothing was linked.',
        );
      const { workspace, team } = input;
      if (team === null) {
        checks.set(projectId, {
          state: 'refused',
          teamKey: check.teamKey,
          reason: `Your Linear sign-in reaches the workspace ${workspace.name}, which has no team ${check.teamKey}.`,
        });
      } else {
        if (team.key.toUpperCase() !== check.teamKey)
          throw new InvalidError(
            `This check is for the team ${check.teamKey}, not ${team.key}. Look up ${check.teamKey}.`,
          );
        deps.state.write((ctx) => {
          setAppSetting(ctx, bindingKey(projectId), {
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            teamId: team.id,
            teamKey: team.key.toUpperCase(),
            teamName: team.name,
          });
        });
        checks.delete(projectId);
      }
      archiveLater(chatId);
      return view(projectId);
    },

    startImport(projectId) {
      const binding = stored(projectId);
      if (binding === null)
        throw new ConflictError('Link this project to a Linear team before importing from it.');
      const chat = deps.chat.create({
        projectId,
        model: null,
        tabPosition: deps.chat.open().length,
        plan: true,
      });
      deps.chat.send(chat.conversationId, {
        text: importBrief(binding),
        mentions: [],
        pictures: [],
      });
      return chat;
    },

    unlink(projectId) {
      getProject(deps.state.db, projectId);
      deps.state.write((ctx) => {
        deleteAppSetting(ctx, bindingKey(projectId));
      });
      checks.delete(projectId);
      return view(projectId);
    },
  };
}

/** What the check's session is asked: read the workspace, find the team, and report it through 10db's tool. */
function openingMessage(teamKey: string): string {
  return [
    `Link this project to the Linear team ${teamKey}.`,
    "Use Linear's tools to read which workspace this sign-in reaches (whoami or get_workspace) and to find the team with the key " +
      `${teamKey} (list_teams or get_team). Change nothing in Linear.`,
    `Then call link_linear_team once with the workspace's id and name and the team's id, key and name, or with team null when the workspace has no team ${teamKey}. Say nothing else.`,
  ].join('\n\n');
}

/** What an import's Plan session is told: where the issues are, how a draft carries its issue and what blocks means. */
function importBrief(binding: LinearBinding): string {
  return [
    `Import Linear issues from the team ${binding.teamKey} (${binding.teamName}) in the workspace ${binding.workspaceName} (workspace id ${binding.workspaceId}, team id ${binding.teamId}) as tasks.`,
    'Ask me which issues I want, for example "the ready AMP ones". Read them with Linear\'s tools (list_issues, get_issue) and change nothing in Linear.',
    `Draft each issue as one task, following the 10db-task drafting rules: a title that is the precise promise, a headline, why, a description, acceptance criteria and areas. Put the issue on the draft as external: { kind: "linear", id: the issue's identifier such as ${binding.teamKey}-120, issueId: Linear's own id, url: the issue's url }. 10db skips an issue that is already a task on the Board.`,
    'When one issue blocks another and both are in this import, the blocked task lists the blocking one in dependsOn.',
    'Start by asking which issues to import.',
  ].join('\n\n');
}
