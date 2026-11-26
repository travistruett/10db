// Sessions spec §7.1: a chat, a tab of its own over an attended conversation the explore engine runs.
// `createChatService` keeps its row and its messages; `chatHooks` says what its session is; its tools
// answer on `/mcp`; the files route reads the project for the screen.

export {
  BRANCH_RUNS_INSIDE,
  CHAT_TURN_ENDED,
  chatFolderInUse,
  judgeChatCall,
  type ChatPlace,
} from './confinement';
export { createConversationFiles } from './conversation-files';
export { chatFolder, chatHooks, type ChatHooksDeps } from './hooks';
export { createChatLiveSessions } from './live-sessions';
export {
  ChatArchiveWarning,
  createChatService,
  type ChatService,
  type ChatWorktrees,
} from './service';
export { branchFor } from './chat-worktree';
export {
  applyChatWorkAnswer,
  ChatWorkConflict,
  createChatWorkService,
  type ChatMoveDeps,
  type ChatWorkService,
} from './work-service';
export { chatRoot } from './work-root';
export { createChatWorkStateReader, type ChatWorkStateReader } from './work-state';
export { createTitleRowGit, type TitleRowGit } from './title-row-git';
export { patchSessionsSettings, sessionsSettings, setSessionsSettings } from './settings';
export { createChatTools } from './tools';
export { finishSeals } from './finish-seals';
export { taskSession } from './task-session';
