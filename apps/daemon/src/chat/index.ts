// Sessions spec §7.1: a chat, a tab of its own over an attended conversation the explore engine runs.
// `createChatService` keeps its row and its messages; `chatHooks` says what its session is; its tools
// answer on `/mcp`; the files and Start from routes read the project for the screen.

export { createConversationFiles } from './conversation-files';
export { chatHooks, type ChatHooksDeps } from './hooks';
export { createChatLiveSessions } from './live-sessions';
export { chatsUnavailable, createChatService, type ChatService } from './service';
export { sessionStarts } from './session-starts';
export { sessionsSettings, setSessionsSettings } from './settings';
export { startFacts, type StartGit } from './start-facts';
export { createChatTools } from './tools';
