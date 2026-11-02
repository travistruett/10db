export { createClaudeAdapter } from './claude-adapter';
export {
  FAKE_ACCOUNT_EMAIL,
  FakeAdapter,
  FakeScriptBook,
  loadFakeScriptBook,
} from './fake-adapter';
export type { FakeShapeBehaviour, FakeShapeTurn } from './fake-shape';
export { checkAccount, type SeenAccount } from './account-check';
export { AccountProbeError, CompletionError, SessionEndReason } from './types';
export type {
  SessionAdapter,
  SessionEvent,
  SessionHandle,
  SessionSpec,
  ShapeSessionHandle,
  ShapeSessionSpec,
  ShapeToolRequest,
  ToolDecision,
  ToolRequest,
  TurnResult,
} from './types';
export {
  ProjectMcpError,
  readRepoMcp,
  resolveProjectMcp,
  skippedServersNote,
  splitProjectMcp,
  type ProjectMcp,
  type RepoMcp,
} from './project-mcp';
export { createUnavailableAdapter } from './unavailable-adapter';
