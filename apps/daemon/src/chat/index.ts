// Sessions spec §7.1: a chat, a tab of its own over an attended conversation the explore engine runs.
// `createChatService` keeps its row and its messages; `chatHooks` says what its session is; the
// files and Start from routes read the project for the screen.

export { judgeChatCall } from './confinement';
export { createConversationFiles, TASK_FILES_LATER } from './conversation-files';
export { rankFiles } from './file-rank';
export { CHAT_MCP_TOOLS, chatFolder, chatHooks, chatProfile, type ChatHooksDeps } from './hooks';
export { createChatLiveSessions, type ChatLive, type ChatLiveSessions } from './live-sessions';
export { CHAT_SYSTEM_PROMPT } from './prompt';
export { CHAT_TOOL_POLICY, ChatToolPolicy } from './tool-policy';
export {
  BUILDER_KEPT_RECORD,
  BUILDER_KEPT_TASK,
  BUILDER_STOPPED,
  createChatTools,
  type BuilderTools,
  type ChatToolsDeps,
} from './tools';
export {
  CHAT_ARCHIVED,
  CHANGE_MODEL_BETWEEN_TURNS,
  chatsUnavailable,
  createChatService,
  firstMessageTitle,
  MODEL_NOT_OFFERED,
  type ChatMessageInput,
  type ChatService,
} from './service';
export { sessionStarts, type StartFacts } from './session-starts';
export { sessionsSettings, setSessionsSettings } from './settings';
export { startFacts, type StartGit } from './start-facts';
