export { createClaudeAdapter } from './claude-adapter';
export { FakeAdapter, FakeScriptBook, loadFakeScriptBook } from './fake-adapter';
export type {
  SessionAdapter,
  SessionEvent,
  SessionHandle,
  SessionSpec,
  ToolDecision,
  ToolRequest,
} from './types';
export { createUnavailableAdapter } from './unavailable-adapter';
