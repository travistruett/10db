import { ChatToolName } from '@10db/contracts';
import { runsOutsideSandbox } from '../guard';
import type { ChatCall } from './confinement';

// What counts as a session's first change: the call that makes it ask where the work happens. A shell write the
// sandbox refused is not one yet, since neither provider reports it to 10db (the session is told to make its
// first change with an edit instead, `chat/prompt.ts`).

/** The file tools. Codex's `apply_patch` reaches the guard as one `Edit` per hunk (`codex-guard.ts`). */
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const OWN_PREFIX = 'mcp__10db__';

/** The chat tools that change git in the builder's checkout. Push, pull request and merge are not among them. */
const GIT_TOOLS: ReadonlySet<string> = new Set([
  ChatToolName.MakeBranch,
  ChatToolName.SwitchBranch,
  ChatToolName.Pull,
  ChatToolName.CommitChanges,
]);

const AGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);

/**
 * Whether a call that was let through could change something after it: an edit, a command (but not the flagged
 * one itself, whose run is what a remembered yes repeats), an MCP tool or a 10db tool, or a subagent's launch.
 * Reads, searches, the web and Claude Code's bookkeeping don't.
 */
export function couldChange(call: Pick<ChatCall, 'toolName' | 'input'>): boolean {
  if (call.toolName === 'Bash') return !runsOutsideSandbox(call.input);
  return (
    EDIT_TOOLS.has(call.toolName) ||
    AGENT_TOOLS.has(call.toolName) ||
    call.toolName.startsWith('mcp__')
  );
}

/**
 * Whether a call is a first change: an edit, a command run outside the sandbox (it can write anywhere), or a
 * git tool that changes the checkout, by the agent or by one of its subagents. Everything else, a push, a
 * pull request and a merge included, is not.
 */
export function firstChangeOf(call: Pick<ChatCall, 'toolName' | 'input'>): 'edit' | 'git' | null {
  if (EDIT_TOOLS.has(call.toolName)) return 'edit';
  if (call.toolName === 'Bash' && runsOutsideSandbox(call.input)) return 'edit';
  if (call.toolName.startsWith(OWN_PREFIX) && GIT_TOOLS.has(call.toolName.slice(OWN_PREFIX.length)))
    return 'git';
  return null;
}
