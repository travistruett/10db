import type {
  AccountRefusal,
  DeniedBy,
  Effort,
  ModelMarkBasis,
  SessionId,
  ShapeId,
  SupportedAccountKind,
  ToolCallView,
  TrustPolicy,
  WorkstreamId,
} from '@10db/contracts';
import type { AccountExpectation } from '../environment';
import type { GuardVerdict } from '../guard';
import type { LaneSandboxSpec, SandboxedMcpServer } from '../sandbox';
import type { SeenAccount } from './account-check';
import type { AgentCapabilities } from './capabilities';
import type { RemoteMcpServer } from './project-mcp';
import type { DeniedCall, ReportedMode } from '../trust';

export interface ToolRequest {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly toolUseId: string | null;
  /**
   * Claude Code's auto-mode classifier blocked the call and handed it to a person. No stored grant or
   * carried allowance may answer it.
   */
  readonly escalated: boolean;
  readonly signal: AbortSignal;
  /**
   * The hook's `cwd` for this same call, where a relative path is read from. An earlier Bash call's
   * `cd` moves it off the lane's copy. Absent where no hook ran for the call.
   */
  readonly cwd?: string;
  /**
   * Every tool name the session's init message listed, project MCP tools included. A card for a project
   * MCP tool offers "every tool of this server" over the ones listed here. Absent where the adapter has none.
   */
  readonly listedTools?: readonly string[];
}

export type ToolDecision =
  | { readonly behavior: 'allow'; readonly updatedInput?: Record<string, unknown> }
  | {
      readonly behavior: 'deny';
      readonly message: string;
      readonly interrupt?: boolean;
      /** The builder, on a card's Deny; 10db for every other refusal. */
      readonly by: DeniedBy;
    };

/** A repo MCP server as a session takes it: a stdio server only as its launch under the lane sandbox. */
export type SessionMcpServer = SandboxedMcpServer | RemoteMcpServer;

/** Default: what no allow rule covers asks 10db. Auto: Claude Code's classifier decides first. */
export type LanePermissionMode = 'default' | 'auto';

/** A session's setup as the adapters take it: the plugin dirs Claude loads, the skill roots Codex lists. */
export interface SessionSetupDirs {
  readonly plugins: readonly string[];
  readonly skillRoots: readonly string[];
}

/** Which kind of session an `AgentSessionSpec` opens: a task's lane, or the engine's attended conversation. */
export const AgentProfileKind = { Lane: 'lane', Explore: 'explore' } as const;
export type AgentProfileKind = (typeof AgentProfileKind)[keyof typeof AgentProfileKind];

/** What every session carries, whatever it is for. */
export interface AgentSessionCore {
  readonly sessionId: SessionId;
  readonly cwd: string;
  /** The first message; later ones come from `send`. */
  readonly prompt: string;
  /** Pictures that go with the first message as image blocks. */
  readonly images?: readonly ShapeImage[];
  /**
   * The client uuid the prompt carries, when it holds a builder message: the turn that takes it lists
   * it (Claude Code's `user_message_uuids`, the `clientId` of Codex's user message item), the evidence
   * it was consumed (Workbench spec §6.3).
   */
  readonly promptUuid?: string;
  readonly model: string;
  readonly effort: Effort;
  readonly resumeProviderSessionId: string | null;
  readonly env: Readonly<Record<string, string>>;
  /** The account the session must prove it is, before its prompt (accounts spec §5). */
  readonly account: AccountExpectation;
  /**
   * The project's and the builder's instructions, read when the session started (`session-setup`). A
   * lane takes them as its custom system prompt, Plan after its own; Codex as developer instructions.
   */
  readonly instructions?: string | null;
  /**
   * What the lane sandbox kept of the session's setup: Claude's plugin dirs and Codex's skill roots.
   * Absent without a sandbox.
   */
  readonly setup?: SessionSetupDirs;
  readonly mcp: {
    readonly url: string;
    readonly token: string;
    readonly toolTimeoutMs: number;
  };
  /**
   * The lane sandbox: Claude Code runs the session's commands under its profile, loads no settings
   * file and asks before every call no allow rule covers. Null, the session runs unsandboxed (a lane)
   * or has no Bash (an explore session).
   */
  readonly sandbox: LaneSandboxSpec | null;
  /**
   * What the session is held to, whoever judges it (trust line §3): the limits, its environment, the
   * coordination lines of its surface and whether a person is in it. Claude renders it for auto mode.
   */
  readonly policy: TrustPolicy;
  /** The repo's approved MCP servers, already expanded; passed next to 10db's server. */
  readonly projectMcpServers: Readonly<Record<string, SessionMcpServer>>;
  /**
   * Runs before every tool call, before permission rules. An explore session's call also names the
   * subagent that made it; a lane's guard answers a plain `GuardVerdict`, which is a `ShapeVerdict`.
   */
  preToolUse(req: ShapeToolRequest): ShapeVerdict;
  /** Called for questions and for tool calls no allow rule covers. */
  canUseTool(req: ToolRequest): Promise<ToolDecision>;
  /** Runs after a call has returned, with its result: how the daemon measures what a Read added. */
  readonly postToolUse?: (req: ShapeToolResult) => void;
  /** Runs when a call failed: what the daemon counted for a Read that returned nothing comes back. */
  readonly toolFailed?: (req: ShapeToolRequest) => void;
}

/** A task's session: one workstream's sequence-th run. */
export interface LaneProfile {
  readonly kind: typeof AgentProfileKind.Lane;
  readonly workstreamId: WorkstreamId;
  readonly sequence: number;
  readonly allowedTools: readonly string[];
  /**
   * The permission mode a sandboxed session runs in, read from the app-wide setting when the session
   * starts. Unset means the adapter's default. An unsandboxed session always runs in `default`.
   */
  readonly lanePermissionMode?: LanePermissionMode;
}

/**
 * A Shape conversation's session (Shape spec §5.1, §5.2): it loads no settings or plugins, has no
 * lane, claim or area, and runs in `default` mode. Its commands run in a read-only lane sandbox; a
 * call its PreToolUse hook doesn't settle reaches `canUseTool`, the lanes' permission broker.
 */
export interface ExploreProfile {
  readonly kind: typeof AgentProfileKind.Explore;
  readonly shapeId: ShapeId;
  /** Appended to Claude Code's own system prompt. */
  readonly systemPrompt: string;
  /** The built-in tools the session has; every other built-in is left out. */
  readonly tools: readonly string[];
  /** Calls approved without a prompt: the read tools and the Shape tools. */
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly agents: Readonly<Record<string, ShapeAgentDefinition>>;
}

/** Everything an adapter needs to open a session: the core every session shares, and what it is for. */
export type LaneSessionSpec = AgentSessionCore & { readonly profile: LaneProfile };
export type ExploreSessionSpec = AgentSessionCore & { readonly profile: ExploreProfile };
export type AgentSessionSpec = LaneSessionSpec | ExploreSessionSpec;

/** A tool call as a Shape session's PreToolUse hook sees it; `agentId` is set only inside a subagent. */
export interface ShapeToolRequest {
  readonly toolName: string;
  readonly input: unknown;
  readonly agentId?: string | undefined;
  readonly agentType?: string | undefined;
  /** The hook's `cwd`: where the call runs, which an earlier Bash call's `cd` may have moved. */
  readonly cwd?: string | undefined;
  /**
   * The permission mode the agent reported with this call: Claude Code's `auto`, or anything else.
   * Absent where the agent reports none (Codex, the fake, a Plan session until it runs in auto mode).
   */
  readonly reportedMode?: ReportedMode;
}

/** A tool call that has run, as a Shape session's PostToolUse hook sees it, with what it returned. */
export interface ShapeToolResult extends ShapeToolRequest {
  readonly response: unknown;
}

/**
 * What a Shape session's PreToolUse hook answers. An allowed call may run with `updatedInput` instead
 * of what the model wrote: how 10db stamps a reviewer's report with the subagent's type.
 */
export type ShapeVerdict =
  GuardVerdict | { readonly decision: 'allow'; readonly updatedInput: Record<string, unknown> };

/**
 * A subagent, passed to Claude Code as a programmatic agent. With no `model` it runs on the session's
 * own; the session may still name one per call (the Agent tool's `model`).
 */
export interface ShapeAgentDefinition {
  readonly description: string;
  readonly prompt: string;
  readonly tools: readonly string[];
  /** A model alias or full ID; absent means the session's own. */
  readonly model?: string;
}

export const SessionEndReason = {
  Completed: 'completed',
  Stopped: 'stopped',
  Error: 'error',
  RateLimited: 'rate_limited',
  /** The credentials or the repo's settings failed a billing check; trying again cannot change that. */
  BillingRefused: 'billing_refused',
  /** Claude Code is not the account it should be, or its credentials failed; the account is paused. */
  AccountRefused: 'account_refused',
  /** Claude Code could not start the session's sandbox; trying again cannot change that. */
  SandboxRefused: 'sandbox_refused',
  /** The account cannot run the model the session asked for; another model on the same account can. */
  ModelRefused: 'model_refused',
} as const;
export type SessionEndReason = (typeof SessionEndReason)[keyof typeof SessionEndReason];

export const PlanStepStatus = {
  Pending: 'pending',
  InProgress: 'in_progress',
  Completed: 'completed',
} as const;
export type PlanStepStatus = (typeof PlanStepStatus)[keyof typeof PlanStepStatus];

/** One step of the plan an agent keeps for its turn: Claude's todo list, Codex's turn plan. */
export interface PlanStep {
  readonly text: string;
  readonly status: PlanStepStatus;
}

/** A slash command the agent offers in the session. */
export interface AgentCommand {
  readonly name: string;
  readonly description: string;
  readonly argumentHint?: string;
}

/** How a turn ended: normally, at the session's turn limit, or with an error (including a spent budget). */
export type TurnResult = 'success' | 'max_turns' | 'error';

export type SessionEvent =
  | { readonly type: 'started'; readonly providerSessionId: string; readonly pid: number | null }
  /** What the session is saying, for the live line; a tool call's activity comes from its `tool_call`. */
  | { readonly type: 'activity'; readonly kind: 'text'; readonly summary: string }
  /** Text the agent is writing; `offset` is the item's JS string length before this piece. */
  | {
      readonly type: 'text_delta';
      readonly itemId: string;
      readonly offset: number;
      readonly text: string;
    }
  /** Reasoning the agent shows as it thinks, offset as a text delta is. */
  | {
      readonly type: 'reasoning_delta';
      readonly itemId: string;
      readonly offset: number;
      readonly text: string;
    }
  /** A finished message: the whole text its deltas built. */
  | { readonly type: 'message'; readonly itemId: string; readonly text: string }
  /**
   * A tool call as it starts, changes and finishes, each time whole. `appended` is the output this
   * update added, when it came from a stream of output.
   */
  | { readonly type: 'tool_call'; readonly call: ToolCallView; readonly appended?: string }
  /** The slash commands the session offers, replacing the last list. */
  | { readonly type: 'commands'; readonly commands: readonly AgentCommand[] }
  /** The agent's plan for its turn, replacing the last one. */
  | { readonly type: 'plan_update'; readonly steps: readonly PlanStep[] }
  | {
      readonly type: 'context';
      readonly percentage: number;
      readonly totalTokens: number;
      readonly maxTokens: number;
    }
  | {
      readonly type: 'turn_complete';
      /** How the turn ended; absent counts as `success`. */
      readonly result?: TurnResult;
      /** What the model wrote in the turn's last message, when it wrote any (capped by the adapter). */
      readonly text?: string;
      /**
       * The client uuids of the messages the turn was handed and ended without taking, which the agent
       * dropped and will never run (Codex). Absent when there are none, or when the turn ended for the
       * handle's own `interrupt`, whose caller pushes again what its receipt does not name.
       */
      readonly dropped?: readonly string[];
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cachedTokens: number;
      readonly costUsd: number;
    }
  | {
      readonly type: 'rate_limit';
      readonly status: 'allowed' | 'allowed_warning' | 'rejected';
      readonly resetsAt: Date | null;
      /** The share of the limit used, 0 to 1; null when Claude Code didn't report one. */
      readonly utilization: number | null;
      /** Which limit: `five_hour`, `seven_day` and the rest; null when Claude Code didn't say. */
      readonly limitType: string | null;
    }
  | { readonly type: 'compacted'; readonly trigger: 'manual' | 'auto' }
  | {
      /**
       * Auto mode refused a call (Claude Code's classifier, or one of its own safety checks). Only a
       * Claude lane reports it; the run goes on, the agent having been told.
       */
      readonly type: 'judge_denied';
      readonly call: DeniedCall;
    }
  | {
      /**
       * The client uuids of the user messages the running turn has taken in so far, as an assistant
       * message stamps them (Claude Code) or a user message item records one (Codex): the evidence a
       * message was consumed, not only received.
       */
      readonly type: 'consumed';
      readonly uuids: readonly string[];
    }
  | {
      /**
       * The commands the session started in the background that are still running, replacing the
       * last report (an empty list: none is). A watcher the session did not start is left out.
       */
      readonly type: 'background_tasks';
      readonly tasks: readonly { readonly id: string; readonly description: string }[];
    }
  | {
      readonly type: 'ended';
      readonly reason: SessionEndReason;
      readonly message: string | null;
      readonly refusal?: AccountRefusal;
      /**
       * What a `model_refused` end rests on. Absent counts as `error`: final until the account's list changes.
       * `wording` is an error's text alone, which a later session settles.
       */
      readonly refusalBasis?: ModelMarkBasis;
    };

/**
 * What an interrupt reports: the uuids of the messages still queued, which will run unless cancelled,
 * or null when the agent gives no receipt (a Claude Code without `interrupt_receipt_v1`). Codex's
 * queue is 10db's own: the messages its session has not yet handed over.
 */
export type InterruptReceipt = { readonly stillQueued: readonly string[] } | null;

export interface SessionHandle {
  /** Ends with exactly one `ended` event. */
  readonly events: AsyncIterable<SessionEvent>;
  /**
   * Queues a user message; the agent sees it at its next opportunity. `images` go with it as content
   * blocks, and `uuid` is the client uuid a turn that takes it lists in `consumed`.
   */
  send(text: string, images?: readonly ShapeImage[], uuid?: string): void;
  /** Interrupts the turn that is running; the session stays open for the next message. */
  interrupt(): Promise<InterruptReceipt>;
  /** Ends the session cleanly; resolves once `ended` has been emitted. */
  stop(): Promise<void>;
}

/** A picture as Claude sees it: an image content block, base64 (Shape spec §5.4). */
export interface ShapeImage {
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  /** Base64 of the file's bytes. */
  readonly data: string;
  /**
   * The stored file the bytes were read from, when there is one: Codex takes a picture as a local
   * image it reads itself, and Claude Code takes the bytes.
   */
  readonly path?: string;
}

export interface AccountProbeSpec {
  /** The account's kind, which picks the agent that reports who it is. */
  readonly kind: SupportedAccountKind;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** The agent reported no account in time. */
export class AccountProbeError extends Error {
  override readonly name = 'AccountProbeError';
}

/** An agent could not start a browser sign-in; the message is safe to show the builder. */
export class AccountLoginError extends Error {
  override readonly name = 'AccountLoginError';
}

/** How a browser sign-in ended. The message never holds what the agent printed. */
export type AccountLoginOutcome =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

/** How long the builder has to finish a browser sign-in before the agent is stopped. */
export const LOGIN_MS = 10 * 60_000;

/** A browser sign-in the agent is waiting on. The agent writes the login; 10db only opens the page. */
export interface AccountLogin {
  /**
   * The page the builder signs in on, for an agent that names one for 10db to open; null for one that
   * opens the browser itself. Never logged.
   */
  readonly authUrl: string | null;
  /** Settles once, when the sign-in ends in any way, and never rejects. */
  readonly outcome: Promise<AccountLoginOutcome>;
  /**
   * Abandons the sign-in and frees the agent. `outcome` then settles as a failure, unless the agent
   * reported the sign-in finished first: its login is written, so that is a success.
   */
  cancel(): Promise<void>;
}

/** One question to a model: no tool, no settings, no project files. */
export interface CompletionSpec {
  /** An empty folder of 10db's own: Claude Code starts here and finds nothing to read. */
  readonly cwd: string;
  readonly prompt: string;
  readonly model: string;
  readonly env: Readonly<Record<string, string>>;
  /** The account the model must be, checked before the prompt is sent. */
  readonly account: AccountExpectation;
  /** Aborting it ends the question at once: Claude Code is stopped and the call rejects. */
  readonly signal?: AbortSignal;
  /** How long the answer may take before it is given up on; 2 minutes unless given. */
  readonly timeoutMs?: number;
  /** How hard the model thinks, as a step's effort; the model's own default unless given. */
  readonly effort?: Effort;
}

/** A conversation to read back, on the account and in the checkout it ran in. */
export interface ConversationReadSpec {
  readonly account: AccountExpectation;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  /** The conversation, as the agent names it: a Codex thread's id. */
  readonly providerSessionId: string;
  /** The client uuids looked for: those of the messages pushed and never seen taken. */
  readonly wanted: readonly string[];
  /** When the oldest of those messages was written (ISO): a turn that ended before holds none. */
  readonly since: string;
  /** Ends the read at once, as a stop of the lane does. */
  readonly signal?: AbortSignal;
}

/**
 * A conversation could not be read back, so what it holds is not known. The message names the
 * conversation and how the read failed, never what the agent printed.
 */
export class ConversationUnreadError extends Error {
  override readonly name = 'ConversationUnreadError';
}

/** The model gave no answer: it was refused, it failed, or it did not answer in time. */
export class CompletionError extends Error {
  override readonly name = 'CompletionError';
}

export interface AgentAdapter {
  /**
   * What this agent can do on the account, and for the model a session opens with (null: none yet).
   * Answers from a table, so it works while the agent's copy is still downloading.
   */
  capabilities(account: Pick<AccountExpectation, 'kind'>, model: string | null): AgentCapabilities;
  /** Sends `prompt` to the model once and resolves with its text; rejects with a `CompletionError`. */
  complete(spec: CompletionSpec): Promise<string>;
  /** Opens a session of the spec's profile: a task's lane, or a Shape conversation (Shape spec §5.1). */
  open(spec: AgentSessionSpec): SessionHandle;
  /** Starts the account's agent with no prompt only to read who it is. */
  probeAccount(probe: AccountProbeSpec): Promise<SeenAccount>;
  /**
   * Which of the `wanted` client uuids the conversation's turns took, read back without running a
   * turn: how a message pushed and never seen taken is told taken or not before the conversation is
   * resumed (Workbench spec §12). Rejects with a `ConversationUnreadError` when it can't tell for
   * every one, or is stopped; an agent with no such read always does.
   */
  readClientUuids(spec: ConversationReadSpec): Promise<readonly string[]>;
  /**
   * Starts the account's browser sign-in with its own agent; rejects with an `AccountLoginError` when it
   * cannot start. Only a kind that signs in with a login has one.
   */
  startLogin(login: AccountProbeSpec): Promise<AccountLogin>;
}
