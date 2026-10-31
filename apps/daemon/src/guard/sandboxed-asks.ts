import type { HazardDef } from '@10db/contracts';
import { z } from 'zod';
import { startsEndlessBackgroundLoop } from './background-loops';
import { hazardHit } from './hazards';
import type { GuardVerdict } from './judge';

/** The Monitor input keys a card-free call may carry; any other (`ws`, or one added later) is asked about. */
export const MONITOR_INPUT_KEYS: ReadonlySet<string> = new Set([
  'command',
  'description',
  'timeout_ms',
]);

/** A PreToolUse answer that hands the call to the broker, which raises a card or applies a stored rule. */
export interface SandboxedAsk {
  readonly decision: 'ask';
  readonly reason: string;
}

/** What a PreToolUse hook answers: the guard's allow or deny, or a sandboxed lane's ask. */
export type PreToolUseVerdict = GuardVerdict | SandboxedAsk;

const ToolInput = z.record(z.string(), z.unknown());
const ask = (reason: string): SandboxedAsk => ({ decision: 'ask', reason });

/**
 * Whether Claude Code runs a Bash call in the background itself (`run_in_background`). Anything but
 * an absent or false flag counts, so a spelling Claude Code reads as true is never missed: a value
 * it refuses fails the call before it runs, so asking about it costs nothing.
 */
export function runsInBackground(input: Readonly<Record<string, unknown>>): boolean {
  const flag = input['run_in_background'];
  return flag !== undefined && flag !== null && flag !== false && flag !== 'false';
}

/** A call to a tool whose traffic does not pass through the sandbox's network proxy. */
function actsOutsideSandboxProxy(toolName: string): boolean {
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return true;
  return toolName.startsWith('mcp__') && !toolName.startsWith('mcp__10db__');
}

/** The command's reason to ask: a hazard it runs, a loop that never ends, or text too deep to scan. */
function commandAsk(
  command: string,
  background: boolean,
  hazards: readonly HazardDef[],
): SandboxedAsk | null {
  try {
    const hit = hazardHit(command, hazards);
    if (hit !== null) return ask(`This command runs the "${hit.name}" hazard.`);
    if (startsEndlessBackgroundLoop(command, { background })) {
      return ask('This command runs something that never ends in the background.');
    }
  } catch (cause) {
    // A command nested deeply enough to overflow the stack is one nothing can read.
    if (cause instanceof Error && cause.name === 'RangeError') {
      return ask('This command is too deeply nested for 10db to read.');
    }
    throw cause;
  }
  return null;
}

/**
 * What a sandboxed lane's PreToolUse hook hands to the broker. In auto mode Claude Code's classifier
 * settles every call no rule asks about, and it never reaches the broker, so the calls that need a
 * card are named here: a hazard command, a background loop with no end, a Monitor call with an input
 * key beyond command, description and timeout_ms (`ws` opens a socket from Claude Code's own process,
 * outside the sandbox's network proxy), and the tools that act outside that proxy (WebFetch,
 * WebSearch and repo MCP tools). The broker then applies stored rules and raises today's cards.
 */
export function sandboxedAsk(
  req: { readonly toolName: string; readonly input: unknown },
  hazards: readonly HazardDef[],
): SandboxedAsk | null {
  if (actsOutsideSandboxProxy(req.toolName)) {
    return ask(`${req.toolName} acts outside the sandbox's network proxy.`);
  }
  if (req.toolName !== 'Bash' && req.toolName !== 'Monitor') return null;
  const input = ToolInput.safeParse(req.input);
  if (!input.success) return ask(`${req.toolName} input was not understood.`);
  if (req.toolName === 'Monitor') {
    const extra = Object.keys(input.data).find((key) => !MONITOR_INPUT_KEYS.has(key));
    if (extra !== undefined) return ask(`Monitor input carries "${extra}".`);
  }
  const command = input.data['command'];
  if (typeof command !== 'string') return ask(`${req.toolName} carried no command to read.`);
  return commandAsk(command, runsInBackground(input.data), hazards);
}
