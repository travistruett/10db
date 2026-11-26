import {
  LinearVia,
  ToolCallStatus,
  type AccountId,
  type LinearSignInRowDto,
  type ToolCallView,
} from '@10db/contracts';
import { mcpToolPrefix } from '../sessions';

// Pure: whether a reporter run that left rows open was kept from Linear by its account's sign-in. A turn that
// made no Linear call is not evidence of a missing sign-in by itself; a hold needs a real sign-in failure, a
// check that says signed out, or nothing showing the account's Linear ever answered.

/** What says a run without a Linear answer is no sign-in problem: Linear answered earlier, or the check says signed in. */
export const ReachEvidence = { Answered: 'answered', SignedIn: 'signed_in' } as const;
export type ReachEvidence = (typeof ReachEvidence)[keyof typeof ReachEvidence];

export type ReachOutcome =
  /** The run reached Linear: its open rows fail as any run's do. */
  | { readonly kind: 'reached' }
  /** The account needs a Linear sign-in: the rows are held. */
  | { readonly kind: 'sign_in' }
  /** The run made no Linear call, though the account's Linear works: a try is spent. */
  | { readonly kind: 'retry'; readonly evidence: ReachEvidence };

/** The texts Linear's server and the agents give for a call refused for its sign-in. */
const AUTH_ERROR =
  /\b401\b|unauthori[sz]ed|unauthenticated|invalid_token|authentication required|needs? auth/i;

/**
 * The account's sign-in check says it has no Linear: a checked `none`, or a read of its server that says not
 * signed in. A status that couldn't be read is `signedIn: null`, which says nothing.
 */
export function checkSaysSignedOut(row: LinearSignInRowDto | null | undefined): boolean {
  if (row === null || row === undefined) return false;
  return (row.via === LinearVia.None && !row.unchecked) || row.signedIn === false;
}

/**
 * When the account's unbroken run of the conversation's newest sessions began, from its sessions newest first.
 * A task's one reporter conversation outlives a move to another account, and only what Linear answered since
 * the account took it over says anything about that account's sign-in. Null when the newest session isn't its own.
 */
export function accountRunStart(
  newestFirst: readonly { readonly accountId: AccountId; readonly startedAt: string }[],
  accountId: AccountId,
): string | null {
  let since: string | null = null;
  for (const session of newestFirst) {
    if (session.accountId !== accountId) break;
    since = session.startedAt;
  }
  return since;
}

type McpCall = Extract<ToolCallView, { kind: 'mcp' }>;

/** The calls on one of the run's Linear servers, by the adapters' shared `server` field. */
const linearCalls = (calls: readonly ToolCallView[], prefixes: readonly string[]): McpCall[] =>
  calls.filter(
    (call): call is McpCall =>
      call.kind === 'mcp' && prefixes.includes(`mcp__${mcpToolPrefix(call.server)}__`),
  );

const failedForSignIn = (call: McpCall): boolean =>
  call.status === ToolCallStatus.Failed &&
  [call.error, call.resultTail].some((text) => text !== null && AUTH_ERROR.test(text));

export function reachOutcome(input: {
  /** The guard allowed a Linear call this run. */
  readonly reachedLinear: boolean;
  readonly linearPrefixes: readonly string[];
  readonly signIn: LinearSignInRowDto | null;
  /** The run's own tool calls. */
  readonly runCalls: readonly ToolCallView[];
  /** The conversation's tool calls before the run, from sessions on the run's account (`accountRunStart`). */
  readonly earlierCalls: readonly ToolCallView[];
}): ReachOutcome {
  const run = linearCalls(input.runCalls, input.linearPrefixes);
  if (run.some((call) => call.status === ToolCallStatus.Done)) return { kind: 'reached' };
  if (run.some(failedForSignIn)) return { kind: 'sign_in' };
  if (input.reachedLinear) return { kind: 'reached' };
  if (checkSaysSignedOut(input.signIn)) return { kind: 'sign_in' };
  if (input.linearPrefixes.length === 0) return { kind: 'sign_in' };
  if (input.signIn?.signedIn === true) return { kind: 'retry', evidence: ReachEvidence.SignedIn };
  if (
    linearCalls(input.earlierCalls, input.linearPrefixes).some(
      (call) => call.status === ToolCallStatus.Done,
    )
  )
    return { kind: 'retry', evidence: ReachEvidence.Answered };
  return { kind: 'sign_in' };
}
