import type {
  AgentAccountKind,
  ConversationId,
  Effort,
  ProjectId,
  SessionId,
  ShapeId,
} from '@10db/contracts';
import type { AccountExpectation } from '../environment';
import type { WaitObserver } from '../inbox';
import type { LaneSandboxSpec, SessionSetup } from '../sandbox';
import type { SessionMcpServer, ToolDecision, ToolRequest } from '../sessions';
import type { ShapeAccess } from './confinement';

// What a Plan conversation's session is built from: the launch the project's account resolves, and
// what its read-only sandbox, servers and permission broker are prepared with.

/** What a conversation's session launches with: the project's checkout and the `plan` role's model. */
export interface ShapeLaunch {
  readonly cwd: string;
  readonly model: string;
  /** The model's own ID, which the account's list is keyed by; `model` is what the account launches it with. */
  readonly modelId: string;
  readonly effort: Effort;
  readonly env: Readonly<Record<string, string>>;
  readonly account: AccountExpectation;
  /** Where the session may read; the service adds the conversation's own files directory. */
  readonly access: Omit<ShapeAccess, 'filesDir'>;
  /** The Agent tool aliases the account takes, which the prompt names and the hook allows; none runs agents on the session's model. */
  readonly agentModels: readonly string[];
}

/**
 * What a session's commands and project tools are prepared from: the conversation and who asks. A
 * chat's session is prepared the same way, with no Plan.
 */
export interface ShapePrepareInput {
  readonly projectId: ProjectId;
  /** The conversation whose cards the broker raises. */
  readonly conversationId: ConversationId;
  /** The Plan the conversation is, when it is one. */
  readonly shapeId?: ShapeId;
  readonly sessionId: SessionId;
  /** The kind of the account the session runs on, which names where its login is kept. */
  readonly accountKind: AgentAccountKind;
  /** The session's launch env, which the sandbox and the project's servers are built from. */
  readonly env: Readonly<Record<string, string>>;
  readonly resumeProviderSessionId: string | null;
  /** Aborts when the session ends: a card it still waits on is withdrawn. */
  readonly signal: AbortSignal;
  /** Told when a call waits on the builder's card. */
  readonly observer: WaitObserver;
}

/** A session's read-only sandbox, the project's approved MCP servers and its permission broker. */
export interface ShapePrepared {
  /** Null when the sandbox could not be built: the session then runs no command and has no project server. */
  readonly sandbox: LaneSandboxSpec | null;
  /** How the PreToolUse hook judges the session's commands; present with the sandbox. */
  readonly commands?: NonNullable<ShapeAccess['commands']>;
  readonly projectMcpServers: Readonly<Record<string, SessionMcpServer>>;
  /** A line for the prompt naming what was left out (servers, the sandbox) and why, or null. */
  readonly note: string | null;
  /** When the first AWS credentials a server was given expire (ISO), or null: the session moves on before. */
  readonly credentialsExpireAt: string | null;
  /** The project's and the builder's instructions, read when the session was prepared; null when none. */
  readonly instructions: string | null;
  /** What the sandbox kept of the session's setup (Settings › Trust); empty with no sandbox. */
  readonly setup: SessionSetup;
  /** The lanes' permission broker, for this conversation. */
  canUseTool(req: ToolRequest): Promise<ToolDecision>;
  /** Watches what runs under the session's Claude Code process, so its commands end with it. */
  trackProcesses(pid: number): void;
  /** Stops what the session's commands left running, then removes the sandbox; once the session has ended. */
  release(): Promise<void>;
}
