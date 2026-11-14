import { ChatToolName, JudgeKind } from '@10db/contracts';
import { stringField } from '../guard';
import type { ShapeVerdict } from '../sessions';
import { judgeShapeCall, type ShapeAccess } from '../shape';

// Sessions spec §7.1, trust line §5: what a chat's PreToolUse hook settles before the judge sees a
// call. A chat reads the project and its pictures, runs commands in its read-only sandbox, searches the
// web where a judge sees each call, launches Claude Code's own agents and calls its own builder tools.
// It writes nothing until M6, so every tool that writes is refused.

const READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob']);
const WEB_TOOLS: ReadonlySet<string> = new Set(['WebSearch', 'WebFetch']);
const AGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);
const OWN_PREFIX = 'mcp__10db__';
const CHAT_TOOLS: ReadonlySet<string> = new Set(Object.values(ChatToolName));

const deny = (reason: string): ShapeVerdict => ({ decision: 'deny', reason });
const ALLOW: ShapeVerdict = { decision: 'allow' };

/** What a chat's agent reads when it reaches for a tool that writes. */
export const CHAT_WRITES_LATER =
  'This chat reads the project and changes nothing in it yet. Say what you would change, and offer to file it as a task.';
/** What a chat on an account with no judge reads when it reaches for the web. */
export const CHAT_NO_WEB =
  "The web needs a judge that sees each call, and this project's account has none yet, so this chat reads the project only.";

/** A call as the hook sees it; `agentId` is set inside a subagent. */
export interface ChatCall {
  readonly toolName: string;
  readonly input: unknown;
  readonly agentId?: string | undefined;
  readonly agentType?: string | undefined;
  readonly cwd?: string | undefined;
}

/**
 * The PreToolUse answer for a chat's call or its subagent's. A subagent of a chat is Claude Code's
 * own, so it reads and runs commands as the chat does.
 */
export function judgeChatCall(call: ChatCall, access: ShapeAccess): ShapeVerdict {
  const asSession = {
    toolName: call.toolName,
    toolInput: call.input,
    ...(call.cwd === undefined ? {} : { cwd: call.cwd }),
  };
  if (READ_TOOLS.has(call.toolName) || call.toolName === 'Bash')
    return judgeShapeCall(asSession, access);
  if (WEB_TOOLS.has(call.toolName))
    return access.judge === JudgeKind.Native
      ? judgeShapeCall(asSession, access)
      : deny(CHAT_NO_WEB);
  if (call.toolName === 'Skill') return ALLOW;
  if (AGENT_TOOLS.has(call.toolName)) {
    // `isolation` makes a git worktree of the checkout, a write, or runs the agent out of this hook's sight.
    const isolated =
      typeof call.input === 'object' &&
      call.input !== null &&
      stringField(call.input, 'isolation') !== null;
    return isolated ? deny('A chat launches its agents in place, with no isolation set.') : ALLOW;
  }
  if (call.toolName.startsWith(OWN_PREFIX))
    return CHAT_TOOLS.has(call.toolName.slice(OWN_PREFIX.length))
      ? ALLOW
      : deny(`${call.toolName} is not one of this chat's tools.`);
  // A tool of one of the project's approved servers is judged as Plan's are.
  if (call.toolName.startsWith('mcp__')) return judgeShapeCall(asSession, access);
  return deny(CHAT_WRITES_LATER);
}
