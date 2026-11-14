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
  | 'chatModels'
  | 'sessionStarts'
  | 'sessionsSettings'
  | 'setSessionsSettings'
>;

export function createChatApiServices(deps: {
  readonly state: StateStore;
  readonly chat: ChatService;
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
