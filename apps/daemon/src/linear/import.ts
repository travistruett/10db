import {
  ConflictError,
  LinearVia,
  type ChatDto,
  type LinearSignInsDto,
  type ProjectId,
} from '@10db/contracts';
import { getProject } from '@10db/db';
import type { ChatService } from '../chat';
import type { StateStore } from '../events';

export interface LinearImport {
  /** From Linear: a Plan session on the project's account that asks which issues to import; ConflictError when the account has no Linear. */
  startImport(projectId: ProjectId): Promise<ChatDto>;
}

/**
 * Import from Linear: a Plan session that reaches Linear through the project's own account sign-in. It refuses only
 * on a definite "no Linear" for the account (that row's hint); an unchecked account goes ahead.
 */
export function createLinearImport(deps: {
  readonly state: StateStore;
  readonly chat: Pick<ChatService, 'create' | 'send' | 'open'>;
  /** How each account reaches Linear, from cached reads. */
  readonly signIns: { list(): Promise<LinearSignInsDto> };
}): LinearImport {
  const refuseSignedOut = async (projectId: ProjectId): Promise<void> => {
    const accountId = getProject(deps.state.db, projectId).accountId;
    const row = (await deps.signIns.list()).rows.find((r) => r.accountId === accountId);
    if (row?.via === LinearVia.None && !row.unchecked)
      throw new ConflictError(row.note ?? "This project's account has no Linear sign-in.");
  };

  return {
    async startImport(projectId) {
      await refuseSignedOut(projectId);
      const chat = deps.chat.create({
        projectId,
        model: null,
        tabPosition: deps.chat.open().length,
        plan: true,
      });
      deps.chat.send(chat.conversationId, { text: IMPORT_BRIEF, mentions: [], pictures: [] });
      return chat;
    },
  };
}

/** What an import's Plan session is told: how a draft carries its issue and what blocks means. */
const IMPORT_BRIEF = [
  'Import Linear issues as tasks.',
  'Ask me which issues I want, for example "my ready AMP issues" or "the Onboarding project". Read them with Linear\'s tools (list_issues, get_issue, list_projects, get_project) and change nothing in Linear.',
  "Draft each issue as one task, following the 10db-task drafting rules: a title that is the precise promise, a headline, why, a description, acceptance criteria and areas. Put the issue on the draft as external: { kind: \"linear\", id: the issue's identifier such as AMP-120, issueId: Linear's own id, url: the issue's url }. 10db skips an issue that is already a task on the Board.",
  'When one issue blocks another and both are in this import, the blocked task lists the blocking one in dependsOn.',
  "When I name a Linear project, draft it as one goal: the project's name as its title, its description (or its summary, when it has none) as the goal's objective, and one task per issue in it, each carrying its external link as above. A blocks relation between two of its issues becomes the task's depends_on inside the goal. Issues I ask for outside any project stay loose tasks.",
  'Start by asking which issues to import.',
].join('\n\n');
