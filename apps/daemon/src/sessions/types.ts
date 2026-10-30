import type { AccountRefusal, Effort, Provider, SessionId, WorkstreamId } from '@10db/contracts';
import type { AccountExpectation } from '../environment';
import type { GuardVerdict } from '../guard';
import type { LaneSandboxSpec, SandboxedMcpServer } from '../sandbox';
import type { SeenAccount } from './account-check';
import type { RemoteMcpServer } from './project-mcp';

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
}

export type ToolDecision =
  | { readonly behavior: 'allow'; readonly updatedInput?: Record<string, unknown> }
  | { readonly behavior: 'deny'; readonly message: string; readonly interrupt?: boolean };

/** A repo MCP server as a session takes it: a stdio server only as its launch under the lane sandbox. */
export type SessionMcpServer = SandboxedMcpServer | RemoteMcpServer;

export interface SessionSpec {
  readonly sessionId: SessionId;
  readonly workstreamId: WorkstreamId;
  readonly sequence: number;
  readonly cwd: string;
  readonly prompt: string;
  readonly model: string;
  readonly effort: Effort;
  readonly resumeProviderSessionId: string | null;
  readonly env: Readonly<Record<string, string>>;
  /** The account the session must prove it is, before its prompt (accounts spec §5). */
  readonly account: AccountExpectation;
  /** The repo's approved MCP servers, already expanded; passed next to 10db's server. */
  readonly projectMcpServers: Readonly<Record<string, SessionMcpServer>>;
  readonly allowedTools: readonly string[];
  /**
   * The lane sandbox: Claude Code runs the session's commands under its profile, loads no settings
   * file and asks before every call no allow rule covers. Null or absent, the session runs unsandboxed.
   */
  readonly sandbox?: LaneSandboxSpec | null;
  readonly mcp: {
    readonly url: string;
    readonly token: string;
    readonly toolTimeoutMs: number;
  };
  /** The workspace guard: runs before every tool call, before permission rules. */
  preToolUse(req: { readonly toolName: string; readonly input: unknown }): GuardVerdict;
  /** Called for questions and for tool calls no allow rule covers. */
  canUseTool(req: ToolRequest): Promise<ToolDecision>;
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
} as const;
export type SessionEndReason = (typeof SessionEndReason)[keyof typeof SessionEndReason];

/** How a turn ended: normally, at the session's turn limit, or with an error (including a spent budget). */
export type TurnResult = 'success' | 'max_turns' | 'error';

export type SessionEvent =
  | { readonly type: 'started'; readonly providerSessionId: string; readonly pid: number | null }
  | { readonly type: 'activity'; readonly kind: 'text' | 'tool'; readonly summary: string }
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
      readonly type: 'ended';
      readonly reason: SessionEndReason;
      readonly message: string | null;
      readonly refusal?: AccountRefusal;
    };

export interface SessionHandle {
  /** Ends with exactly one `ended` event. */
  readonly events: AsyncIterable<SessionEvent>;
  /** Queues a user message; the agent sees it at its next opportunity. */
  send(text: string): void;
  /** Ends the session cleanly; resolves once `ended` has been emitted. */
  stop(): Promise<void>;
}

export interface AccountProbeSpec {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** Claude Code reported no account in time. */
export class AccountProbeError extends Error {
  override readonly name = 'AccountProbeError';
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
}

/** The model gave no answer: it was refused, it failed, or it did not answer in time. */
export class CompletionError extends Error {
  override readonly name = 'CompletionError';
}

export interface SessionAdapter {
  readonly provider: Provider;
  /** Sends `prompt` to the model once and resolves with its text; rejects with a `CompletionError`. */
  complete(spec: CompletionSpec): Promise<string>;
  start(spec: SessionSpec): SessionHandle;
  /** Starts Claude Code with no prompt only to read who it is. */
  probeAccount(probe: AccountProbeSpec): Promise<SeenAccount>;
}
