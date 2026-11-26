import { judgeHookCall, type HookInput, type OnDenied } from './codex-guard';
import {
  CodexApprovalDecision,
  CommandApprovalKind,
  type CommandApprovalRequest,
} from './codex-protocol';
import type { AgentSessionCore } from './types';

/** How 10db answers one escalation, and what the turn is told when it declines with a reason. */
export interface EscalationAnswer {
  readonly decision: CodexApprovalDecision;
  /** Steered into the turn after a decline: Codex's decline carries no text of its own. */
  readonly steer: string | null;
}

const NOT_A_COMMAND =
  'Only a command you run asks to run outside the sandbox; 10db declined this request.';
const NO_NETWORK =
  'Network access outside the sandbox is not available in this chat. Work without it, or say what it needs.';
const NO_COMMAND = 'The request named no command, so 10db declined it.';

/** Only the builder's yes on the card lets a command out: a guard's allow becomes an ask. */
const BUILDER_DECIDES = 'A command outside the sandbox is the builder’s to allow.';

const declined = (reason: string): EscalationAnswer => ({
  decision: CodexApprovalDecision.Decline,
  steer: `Note from 10db: ${reason}`,
});

/**
 * The spec the escalation is judged under: the chat's own guard, with no judge, and any allow it gives
 * handed to the broker, so no model and no rule answers an escape from the sandbox.
 */
function builderDecides(
  spec: Pick<AgentSessionCore, 'preToolUse' | 'canUseTool'>,
): Pick<AgentSessionCore, 'preToolUse' | 'canUseTool'> {
  return {
    preToolUse: (req) => {
      const verdict = spec.preToolUse(req);
      return verdict.decision === 'allow' ? { decision: 'ask', reason: BUILDER_DECIDES } : verdict;
    },
    canUseTool: (req) => spec.canUseTool(req),
  };
}

/**
 * Answers Codex's request to run a command its sandbox blocked outside the sandbox, as a Claude chat's
 * flagged command is answered: the chat's guard first (Here only, the turn holding the checkout, no
 * background run), then the builder's card, which reads the hold again at the yes. Anything else, and any
 * failure, declines.
 */
export async function answerCommandApproval(
  spec: Pick<AgentSessionCore, 'preToolUse' | 'canUseTool'>,
  input: {
    readonly request: CommandApprovalRequest;
    /** Where the command runs when the request names no directory. */
    readonly cwd: string;
    readonly signal: AbortSignal;
    readonly onDenied: OnDenied;
  },
): Promise<EscalationAnswer> {
  const { request } = input;
  // Codex reads a missing kind as a command, for older servers.
  if (request.kind !== undefined && request.kind !== CommandApprovalKind.Command)
    return declined(NOT_A_COMMAND);
  if (request.networkApprovalContext !== undefined && request.networkApprovalContext !== null)
    return declined(NO_NETWORK);
  const command = request.command ?? '';
  if (command.trim() === '') return declined(NO_COMMAND);
  const said = request.reason ?? '';
  const hook: HookInput = {
    tool_name: 'Bash',
    tool_input: {
      command,
      dangerouslyDisableSandbox: true,
      ...(said === '' ? {} : { description: said }),
    },
    tool_use_id: request.itemId,
    cwd: request.cwd ?? input.cwd,
  };
  const answer = await judgeHookCall(builderDecides(spec), hook, input.signal, input.onDenied);
  return answer.allow
    ? { decision: CodexApprovalDecision.Accept, steer: null }
    : declined(answer.reason);
}
