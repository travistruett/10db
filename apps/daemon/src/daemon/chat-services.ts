import { getProject } from '@10db/db';
import type { ApiServices } from '../api';
import {
  sessionsSettings,
  sessionStarts,
  setSessionsSettings,
  startFacts,
  type ChatService,
  type StartGit,
} from '../chat';
import type { StateStore } from '../events';
import { folderView, type FolderHold } from '../folder-hold';
import type { Logger } from '../log';

// Sessions spec §10: a chat's own routes. Its conversation is served by the conversation routes.

export type ChatApiServices = Pick<
  ApiServices,
  | 'openChats'
  | 'recentChats'
  | 'createChat'
  | 'patchChat'
  | 'archiveChat'
  | 'unarchiveChat'
  | 'stopChatWaiting'
  | 'projectFolder'
  | 'chatModels'
  | 'sessionStarts'
  | 'sessionsSettings'
  | 'setSessionsSettings'
>;

export function createChatApiServices(deps: {
  readonly state: StateStore;
  readonly chat: ChatService;
  readonly folderHold: FolderHold;
  readonly git: StartGit;
  readonly now: () => Date;
  readonly log: Logger;
}): ChatApiServices {
  const { state, chat } = deps;
  return {
    openChats: () => chat.open(),
    recentChats: (projectId, limit) => chat.recent(projectId, limit),
    createChat: (input) => chat.create(input),
    patchChat: (id, input) => chat.patch(id, input),
    archiveChat: (id) => chat.archive(id),
    unarchiveChat: (id) => chat.unarchive(id),
    stopChatWaiting(id) {
      chat.stopWaiting(id);
      return chat.get(id);
    },
    async projectFolder(projectId) {
      const project = getProject(state.db, projectId);
      let branch: string | null = null;
      try {
        branch = (
          await deps.git(project.repoPath, ['symbolic-ref', '--short', '-q', 'HEAD'])
        ).trim();
      } catch (error) {
        // A detached HEAD or an unreadable repository has no branch to show; the holders still do.
        deps.log.debug({ err: error, projectId }, 'Your folder is on no branch');
      }
      return folderView(
        projectId,
        branch === '' ? null : branch,
        deps.folderHold.holders(projectId),
      );
    },
    chatModels: (projectId) => chat.models(projectId),
    async sessionStarts(projectId) {
      const project = getProject(state.db, projectId);
      try {
        return sessionStarts(
          await startFacts({ db: state.db, git: deps.git }, project, deps.now()),
        );
      } catch (error) {
        // Start from is a convenience: what can't be read offers nothing, never an error.
        deps.log.warn({ err: error, projectId }, 'Start from could not read the project');
        return [];
      }
    },
    sessionsSettings: () => sessionsSettings(state.db),
    setSessionsSettings: (input) => setSessionsSettings(state, input),
  };
}
