import {
  NotFoundError,
  type ChatId,
  type DoItPreviewDto,
  type DoItRequest,
  type DoItResult,
} from '@10db/contracts';
import { getProject } from '@10db/db';
import type { TakeoverService } from '../takeover';
import type { ApiServices } from '../api';
import {
  patchSessionsSettings,
  sessionsSettings,
  sessionStarts,
  setSessionsSettings,
  startFacts,
  ChatArchiveWarning,
  ChatWorkConflict,
  type ChatService,
  type ChatWorkService,
  type StartGit,
} from '../chat';
import type { StateStore } from '../events';
import { folderView, type FolderHold } from '../folder-hold';
import type { Logger } from '../log';
import type { PendingOpens } from '../pass';

// Sessions spec §10: a chat's own routes. Its conversation is served by the conversation routes.

export type ChatApiServices = Pick<
  ApiServices,
  | 'openChats'
  | 'recentChats'
  | 'createChat'
  | 'patchChat'
  | 'archiveChat'
  | 'archivePreview'
  | 'unarchiveChat'
  | 'chooseChatWork'
  | 'chatWorkState'
  | 'stopChatWaiting'
  | 'askChatBrief'
  | 'cancelChatBrief'
  | 'doItPreview'
  | 'doIt'
  | 'projectFolder'
  | 'chatModels'
  | 'sessionStarts'
  | 'sessionsSettings'
  | 'setSessionsSettings'
  | 'patchSessionsSettings'
  | 'openTakeover'
  | 'takeoverCommand'
  | 'handBack'
  | 'takeoverOf'
  | 'takeoverPreview'
>;

export function createChatApiServices(deps: {
  readonly state: StateStore;
  readonly chat: ChatService;
  readonly work: ChatWorkService;
  readonly takeover: TakeoverService;
  readonly folderHold: FolderHold;
  readonly pendingOpens: Pick<PendingOpens, 'view'>;
  readonly git: StartGit;
  /** What the Do It sheet shows for a chat. */
  readonly doItPreview: (chatId: ChatId) => Promise<DoItPreviewDto>;
  /** Hands the chat's work on, in the place the request names. */
  readonly doIt: (chatId: ChatId, input: DoItRequest) => Promise<DoItResult>;
  readonly now: () => Date;
  readonly log: Logger;
}): ChatApiServices {
  const { state, chat } = deps;
  return {
    openChats: () => chat.open(),
    recentChats: (projectId, limit) => chat.recent(projectId, limit),
    createChat: (input) => chat.create(input),
    patchChat: (id, input) => chat.patch(id, input),
    async archiveChat(id, request) {
      try {
        return { archived: true, chat: await chat.archive(id, request) };
      } catch (error) {
        // More at risk than the builder was told: the fresh list is the answer, and nothing changed.
        if (error instanceof ChatArchiveWarning) return { archived: false, preview: error.preview };
        throw error;
      }
    },
    archivePreview: (id) => chat.archivePreview(id),
    unarchiveChat: (id) => chat.unarchive(id),
    async chooseChatWork(id, choice) {
      try {
        return { settled: true, work: await deps.work.choose(id, choice.place) };
      } catch (error) {
        // A choice that lost answers with the state that won, which the bar shows.
        if (error instanceof ChatWorkConflict && error.work !== null)
          return { settled: false, work: error.work };
        throw error;
      }
    },
    chatWorkState: (id, signal) => deps.work.state(id, signal),
    stopChatWaiting(id) {
      chat.stopWaiting(id);
      return chat.get(id);
    },
    askChatBrief(id, input) {
      chat.askBrief(id, input.draft);
      return chat.briefOf(id);
    },
    async cancelChatBrief(id) {
      await chat.cancelBrief(id);
      return chat.briefOf(id);
    },
    doItPreview: deps.doItPreview,
    doIt: deps.doIt,
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
        deps.pendingOpens.view(projectId),
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
    patchSessionsSettings: (input) => patchSessionsSettings(state, input),
    openTakeover: (id) => deps.takeover.open(id),
    takeoverCommand: (id) => deps.takeover.command(id),
    handBack: (id) => deps.takeover.handBack(id),
    takeoverOf(id) {
      const found = deps.takeover.takeoverOf(id);
      if (found === null) throw new NotFoundError('Takeover', id);
      return found;
    },
    takeoverPreview: (id) => deps.takeover.preview(id),
  };
}
