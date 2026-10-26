import type { BillingMode, Effort, Provider, SessionId, WorkstreamId } from '@10db/contracts';
import type { GuardVerdict } from '../guard';
import type { ProjectMcpServer } from './project-mcp';

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
  /** The project's billing mode; the adapter refuses a session whose credentials don't match it. */
  readonly billingMode: BillingMode;
  /** The repo's approved MCP servers, already expanded; passed next to 10db's server. */
  readonly projectMcpServers: Readonly<Record<string, ProjectMcpServer>>;
  readonly allowedTools: readonly string[];
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
} as const;
export type SessionEndReason = (typeof SessionEndReason)[keyof typeof SessionEndReason];

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
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly costUsd: number;
    }
  | {
      readonly type: 'rate_limit';
      readonly status: 'allowed' | 'allowed_warning' | 'rejected';
      readonly resetsAt: Date | null;
    }
  | { readonly type: 'compacted'; readonly trigger: 'manual' | 'auto' }
  | {
      readonly type: 'ended';
      readonly reason: SessionEndReason;
      readonly message: string | null;
    };

export interface SessionHandle {
  /** Ends with exactly one `ended` event. */
  readonly events: AsyncIterable<SessionEvent>;
  /** Queues a user message; the agent sees it at its next opportunity. */
  send(text: string): void;
  /** Ends the session cleanly; resolves once `ended` has been emitted. */
  stop(): Promise<void>;
}

export interface SessionAdapter {
  readonly provider: Provider;
  start(spec: SessionSpec): SessionHandle;
}
