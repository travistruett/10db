import { readFileSync } from 'node:fs';
import { ModelMarkBasis, type SessionId } from '@10db/contracts';
import { z } from 'zod';
import type { InterruptReceipt } from './types';

const Json: z.ZodType = z.json();

export const FakeStep = z.discriminatedUnion('do', [
  z.object({ do: z.literal('context'), percentage: z.number().min(0).max(100) }),
  z.object({ do: z.literal('activity'), summary: z.string() }),
  z.object({
    do: z.literal('tool'),
    toolName: z.string(),
    input: z.record(z.string(), Json),
    /** The permission mode the agent reports with the call, as Claude Code's hook does; absent reports none. */
    reportedMode: z.enum(['auto', 'other']).optional(),
  }),
  z.object({ do: z.literal('mcp'), tool: z.string(), args: z.record(z.string(), Json) }),
  z.object({ do: z.literal('await_message'), contains: z.string() }),
  /** Waits until the test calls `signal` with this name, so a test can place the next step exactly. */
  z.object({ do: z.literal('await_signal'), name: z.string() }),
  /**
   * A turn takes in every message the session holds that it has not taken yet, the prompt's first:
   * their client uuids come as `consumed`, as an assistant message stamps `user_message_uuids`.
   */
  z.object({ do: z.literal('consume') }),
  z.object({
    do: z.literal('turn_complete'),
    result: z.enum(['success', 'max_turns', 'error']).optional(),
    /** What the model wrote in the turn's last message. */
    text: z.string().optional(),
    /**
     * The turn ends without taking what it holds, and drops it, as a Codex turn that fails or that
     * the guard interrupts does: their client uuids come as the completion's `dropped`.
     */
    drops: z.boolean().optional(),
  }),
  z.object({
    do: z.literal('rate_limit'),
    status: z.enum(['allowed', 'allowed_warning', 'rejected']),
    resetsInSeconds: z.number().nullable(),
    utilization: z.number().optional(),
    limitType: z.string().optional(),
  }),
  z.object({ do: z.literal('compact') }),
  /** Auto mode refuses a call: the session reports it, as a Claude lane does, and the run goes on. */
  z.object({
    do: z.literal('judge_denied'),
    toolName: z.string(),
    summary: z.string(),
    reason: z.string(),
    by: z.enum(['classifier', 'safety_check']),
  }),
  /** The commands running in the background now (none: they all finished). */
  z.object({ do: z.literal('background'), tasks: z.array(z.string()) }),
  z.object({ do: z.literal('crash'), message: z.string() }),
  z.object({ do: z.literal('billing_refused'), message: z.string() }),
  /** The account cannot run the model the session was launched on; `wording` is an error's text alone. */
  z.object({ do: z.literal('model_refused'), basis: z.enum(ModelMarkBasis).optional() }),
  z.object({
    do: z.literal('auth_error'),
    error: z.enum([
      'authentication_failed',
      'oauth_org_not_allowed',
      'cloud_credential_error',
      'billing_error',
      'account_on_hold',
    ]),
  }),
  z.object({ do: z.literal('hang') }),
  z.object({ do: z.literal('end'), reason: z.enum(['completed', 'rate_limited']).optional() }),
]);
export type FakeStep = z.infer<typeof FakeStep>;

/** The steps that do a turn's work: one of them running means a turn is. */
export const TURN_STEPS: ReadonlySet<FakeStep['do']> = new Set([
  'consume',
  'tool',
  'mcp',
  'activity',
]);

/** Task title → one step list per session, indexed by the session's sequence within its workstream. */
export const FakeScriptBook = z.record(z.string(), z.array(z.array(FakeStep)));
export type FakeScriptBook = z.infer<typeof FakeScriptBook>;

/** Reads a script book from a JSON file, validating it at the file boundary. */
export function loadFakeScriptBook(path: string): FakeScriptBook {
  return FakeScriptBook.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export interface FakeObservation {
  readonly sessionId: SessionId;
  readonly sequence: number;
  readonly title: string;
  readonly step: number;
  readonly kind: 'denied_by_guard' | 'tool_allowed' | 'tool_denied' | 'mcp_result';
  readonly detail: Record<string, unknown>;
}

/** A message the runner sent a lane session, with how many images and the uuid it carried. */
export interface FakeSent {
  sessionId: SessionId;
  text: string;
  images: number;
  uuid: string | null;
}

/** A lane session's interrupt, with what it answered. */
export interface FakeInterrupt {
  sessionId: SessionId;
  receipt: InterruptReceipt;
}
