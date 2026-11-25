import type {
  ConversationId,
  Effort,
  ProjectId,
  Provider,
  SessionId,
  ShapeId,
} from '@10db/contracts';
import type { AccountExpectation } from '../environment';
import type { LimitNotes, WaitObserver } from '../inbox';
import type { LaneSandboxSpec, SessionSetup } from '../sandbox';
import type { SessionMcpServer, ToolDecision, ToolRequest, YourSessionServer } from '../sessions';
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
  /**
   * What a Full access chat's Claude session needs of the account: read only when the chat has Full access,
   * since reading it checks a keyed account's secret.
   */
  readonly fullAccess?: () => FullAccessLaunch;
}

/** How the project's account reaches Claude Code when a chat runs outside the sandbox. */
export interface FullAccessLaunch {
  /** The Keychain command that reads an API key, or null where the account has none. */
  readonly apiKeyHelper: string | null;
  /** A key sits in the session's env: a Bedrock key. */
  readonly keyInEnv: boolean;
  /** The account's config folder is the builder's own, so Claude Code loads their setup itself. */
  readonly defaultConfigDir: boolean;
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
  /** The harness the account runs, which names where its login is kept. */
  readonly harness: Provider;
  /** The session's launch env, which the sandbox and the project's servers are built from. */
  readonly env: Readonly<Record<string, string>>;
  readonly resumeProviderSessionId: string | null;
  /** Aborts when the session ends: a card it still waits on is withdrawn. */
  readonly signal: AbortSignal;
  /** Told when a call waits on the builder's card. */
  readonly observer: WaitObserver;
  /**
   * The session's turn holds Your folder, so its commands may write the checkout (never git state). Absent, the
   * sandbox is read-only, as Plan's always is.
   */
  readonly writes?: boolean;
  /** The plan's folder: open to the file tools, and a read-only kernel grant of exactly it. */
  readonly planFiles?: string;
  /**
   * The folder the session works in when it is not the project's checkout (a session's own worktree): the
   * sandbox roots there, and the checkout is denied to it.
   */
  readonly checkout?: string;
  /** The limits 10db's judge stopped calls at, which the broker asks with the trust line's three answers. */
  readonly limits?: LimitNotes;
  /** A chat's session: the builder's no reaches it as a chat's denial text, which invites another way. */
  readonly chat?: true;
  /**
   * Set only by a chat that is not Full access: its sandbox lets a command ask to run outside it, the
   * broker asks the builder, and `mayRun` says why the call may not (null: it may) at the call and at the yes.
   */
  readonly unsandboxedAsk?: {
    readonly mayRun: () => string | null;
    /** Counts the calls let through that could change something; a remembered command lasts until it moves. */
    readonly changes: () => number;
    /** Counts a command the builder allowed to run outside the sandbox: it may have changed anything. */
    readonly bump: () => void;
    /** Whether a background task or job is running now, which may still write. */
    readonly background: () => boolean;
    /** False once the session started something in the background: no command is remembered after that. */
    readonly remembers: () => boolean;
  };
}

/** A session's read-only sandbox, the project's approved MCP servers and its permission broker. */
export interface ShapePrepared {
  /** Null when the sandbox could not be built: the session then runs no command and has no project server. */
  readonly sandbox: LaneSandboxSpec | null;
  /** How the PreToolUse hook judges the session's commands; present with the sandbox. */
  readonly commands?: NonNullable<ShapeAccess['commands']>;
  readonly projectMcpServers: Readonly<Record<string, SessionMcpServer>>;
  /** The builder's own approved MCP servers, planned as the session was prepared; each call is judged. */
  readonly yourMcpServers: Readonly<Record<string, YourSessionServer>>;
  /** Whether the Your MCP servers switch is on, so a plan session may take the builder's claude.ai connectors. */
  readonly claudeConnectors?: boolean;
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
  /** Remembers what the session runs now (its agent and servers), at its first command. */
  markOwn(): void;
  /** Stops the jobs its commands left running since the mark, with the session still open. */
  endJobs(): Promise<void>;
  /** Stops what the session's commands left running, then removes the sandbox; once the session has ended. */
  release(): Promise<void>;
}
