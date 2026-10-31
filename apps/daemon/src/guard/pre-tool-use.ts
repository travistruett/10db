import { ClaimKind, type HazardDef } from '@10db/contracts';
import { z } from 'zod';
import { hazardHit } from './hazards';
import { judgeToolUse, stringField, type GuardInput, type GuardVerdict } from './judge';
import { firstUnread } from './unread-commands';

/**
 * Tools whose `allowed_domains` names hosts the command may reach. In auto mode Claude Code's
 * classifier alone reviews the list and the sandbox lets the command reach them, with no network
 * prompt and so no card; in default mode it ignores the list. WebSearch's field of that name only
 * filters results.
 */
const HOST_LIST_TOOLS: ReadonlySet<string> = new Set(['Bash', 'Monitor']);
const HostList = z.looseObject({ allowed_domains: z.array(z.unknown()).min(1) });

/**
 * Tools that reach a host from Claude Code's own process, outside the sandbox's network proxy and
 * its one card per host. A Monitor command is not judged by the guard either; the permission
 * broker judges both, and runs a lane's watch of its own output without a card.
 */
const BROKER_JUDGES: Readonly<Record<string, string>> = {
  Monitor:
    'Monitor runs a command or opens a WebSocket from Claude Code itself; 10db judges every Monitor call.',
  WebFetch:
    'WebFetch reaches its host from Claude Code itself, outside the sandbox; 10db judges every WebFetch.',
};

/** A command nested deeply enough to overflow the stack in a shell scanner is one nothing can read. */
function isTooDeep(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'RangeError';
}

/** The part of the command that may run a hazard in `hazards`, or null when it can run none. */
function mayRunHazard(command: string, hazards: readonly HazardDef[]): string | null {
  try {
    const hit = hazardHit(command, hazards);
    if (hit !== null) return hit.words.join(' ');
    return firstUnread(command, hazards)?.text ?? null;
  } catch (cause) {
    if (isTooDeep(cause)) return command;
    throw cause;
  }
}

/**
 * Why a call the guard allows must still reach 10db's permission broker, or null when Claude Code's
 * permission mode may decide it.
 */
function brokerAsk(input: GuardInput): string | null {
  const judged = BROKER_JUDGES[input.toolName];
  if (judged !== undefined) return judged;
  if (input.toolName !== 'Bash') return null;
  const command = stringField(input.toolInput, 'command');
  if (command === null) return null;
  const unclaimed = input.hazards.filter(
    (hazard) =>
      hazard.commands.length > 0 &&
      !input.claims.some((c) => c.kind === ClaimKind.Hazard && c.name === hazard.name),
  );
  if (unclaimed.length === 0) return null;
  const part = mayRunHazard(command, unclaimed);
  if (part === null) return null;
  const names = unclaimed.map((hazard) => `"${hazard.name}"`).join(', ');
  return `10db can't read whether "${part}" runs a hazard this task hasn't claimed (${names}), so the builder is asked. Spell the command out in plain words, or claim the hazard first.`;
}

/**
 * The PreToolUse hook's answer for a managed session: the guard's verdict, and `ask` for a call it
 * allows that 10db's permission broker must still see: a command that may run a hazard the task
 * hasn't claimed, which only the broker can card, and the tools that reach a host outside the
 * sandbox. An `ask` sends the call to `canUseTool` whatever an allow rule says, so neither an allow
 * rule nor auto mode's classifier approves it first; in default mode those calls reach the broker
 * anyway. A command that brings its own host list is refused, so each new host still meets the
 * sandbox's prompt and its card.
 */
export function judgePreToolUse(input: GuardInput): GuardVerdict {
  const verdict = judgeToolUse(input);
  if (verdict.decision !== 'allow') return verdict;
  if (HOST_LIST_TOOLS.has(input.toolName) && HostList.safeParse(input.toolInput).success) {
    return {
      decision: 'deny',
      reason:
        'allowed_domains would let the command reach hosts the project does not list with no card. Run it without allowed_domains: a host the project does not list raises a card for the builder when the command reaches it.',
    };
  }
  const reason = brokerAsk(input);
  return reason === null ? verdict : { decision: 'ask', reason };
}
