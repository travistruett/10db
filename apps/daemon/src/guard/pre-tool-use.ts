import { ClaimKind, type HazardDef } from '@10db/contracts';
import { z } from 'zod';
import { runsInBackground, startsEndlessBackgroundLoop } from './background-loops';
import { hazardHit } from './hazards';
import { judgeToolUse, stringField, type GuardInput, type GuardVerdict } from './judge';
import { firstUnread } from './unread-commands';
import { hazardPrograms, unreadableHazard } from './unread-hazards';

/**
 * Tools whose `allowed_domains` names hosts the command may reach. In auto mode Claude Code's
 * classifier alone reviews the list and the sandbox lets the command reach them, with no network
 * prompt and so no card; in default mode it ignores the list. WebSearch's field of that name only
 * filters results.
 */
const HOST_LIST_TOOLS: ReadonlySet<string> = new Set(['Bash', 'Monitor']);
const ToolInputRecord = z.record(z.string(), z.unknown());
const HostList = z.looseObject({ allowed_domains: z.array(z.unknown()).min(1) });

/**
 * WebFetch reaches its host from Claude Code's own process, outside the sandbox's network proxy and
 * its one card per host, so the broker judges every one.
 */
const BROKER_JUDGES: Readonly<Record<string, string>> = {
  WebFetch:
    'WebFetch reaches its host from Claude Code itself, outside the sandbox; 10db judges every WebFetch.',
};

/**
 * A Monitor call that may run without the broker: its command runs inside the sandbox like a Bash
 * command's (probed: a write outside the profile's paths fails in Monitor as in Bash), so it gets
 * Bash's checks. Any other input key (`ws` opens a socket from Claude Code's own process, outside the
 * sandbox's network proxy), or no command, goes to the broker.
 */
const MONITOR_INPUT_KEYS: ReadonlySet<string> = new Set(['command', 'description', 'timeout_ms']);

/**
 * Tools that reach a host or an MCP server from Claude Code's own process, outside the sandbox's
 * network proxy: web search, MCP resources, and the tools of a repo's MCP servers.
 */
const OUT_OF_PROXY_TOOLS: ReadonlySet<string> = new Set([
  'WebSearch',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
]);
const READ_FAMILY: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'LS']);
const EDIT_FAMILY: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * The tools Claude Code's classifier may decide, each still subject to the checks below. Every other
 * tool name, including one added by a later Claude Code, goes to the broker: some of them act from
 * Claude Code's own unsandboxed process (EnterWorktree runs `git worktree add`) or outlive the lane
 * (CronCreate, ScheduleWakeup, RemoteTrigger).
 */
const CLASSIFIER_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'NotebookRead',
  'Bash',
  'Monitor',
  'BashOutput',
  'KillShell',
  'TaskStop',
  'TodoWrite',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  'Task',
  'Agent',
  'Skill',
  'AskUserQuestion',
  'ToolSearch',
  'EnterPlanMode',
  'ExitPlanMode',
]);

function actsOutsideSandboxProxy(toolName: string): boolean {
  if (OUT_OF_PROXY_TOOLS.has(toolName)) return true;
  return toolName.startsWith('mcp__') && !toolName.startsWith('mcp__10db__');
}

/** A command nested deeply enough to overflow the stack in a shell scanner is one nothing can read. */
function isTooDeep(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'RangeError';
}

/** The part of the command that may run a hazard in `hazards`, or null when it can run none. */
function mayRunHazard(command: string, hazards: readonly HazardDef[]): string | null {
  try {
    const hit = hazardHit(command, hazards);
    if (hit !== null) return hit.words.join(' ');
    const unread = firstUnread(command, hazards)?.text;
    if (unread !== undefined) return unread;
    // The checks `firstUnread` lacks: a word the shell fills in after a program with hazard forms,
    // a wrapper or feeder in front of one, a parse that is uncertain, and eval's text.
    return unreadableHazard(command, hazardPrograms(hazards));
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
  if (actsOutsideSandboxProxy(input.toolName)) {
    return `${input.toolName} acts outside the sandbox's network proxy; 10db judges every call.`;
  }
  if (!CLASSIFIER_TOOLS.has(input.toolName) && !input.toolName.startsWith('mcp__10db__')) {
    return `${input.toolName} is not a tool the classifier may decide for a lane; 10db judges it.`;
  }
  if (input.fileAccess !== undefined) {
    if (READ_FAMILY.has(input.toolName)) {
      return input.fileAccess.readAsk(input.toolName, input.toolInput);
    }
    if (EDIT_FAMILY.has(input.toolName)) {
      const path =
        stringField(input.toolInput, 'file_path') ?? stringField(input.toolInput, 'notebook_path');
      return path === null
        ? 'The path of this edit could not be read.'
        : input.fileAccess.writeAsk(path);
    }
  }
  if (input.toolName === 'Monitor') {
    const keys = Object.keys(ToolInputRecord.safeParse(input.toolInput).data ?? { '': 0 });
    if (!keys.every((key) => MONITOR_INPUT_KEYS.has(key))) {
      return 'Monitor carries an input beyond its command (a WebSocket opens from Claude Code itself); 10db judges it.';
    }
  } else if (input.toolName !== 'Bash') return null;
  const command = stringField(input.toolInput, 'command');
  if (command === null) {
    return input.toolName === 'Monitor' ? 'Monitor carried no command to read.' : null;
  }
  // A background call never blocks the lane, so a loop with no end holds a core while it goes on.
  // A Monitor command always runs beside the lane.
  const background =
    input.toolName === 'Monitor' ||
    runsInBackground(ToolInputRecord.safeParse(input.toolInput).data ?? {});
  if (startsEndlessBackgroundLoop(command, { background })) {
    return `"${command}" starts something that never ends in the background, so the builder is asked.`;
  }
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
