import { isAbsolute, posix, resolve, sep } from 'node:path';
import { ClaimKind, type HazardDef } from '@10db/contracts';
import { z } from 'zod';
import { ENDLESS_FILES, runsInBackground, startsEndlessBackgroundLoop } from './background-loops';
import { isOwnFile } from './account-rules';
import { hazardHit } from './hazards';
import { judgeToolUse, stringField, type GuardInput, type GuardVerdict } from './judge';
import { realPathOf } from './paths';
import { laneReadOnlyWords } from './read-only';
import { firstUnread } from './unread-commands';
import { unreadableHazard } from './unread-hazards';

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
/** The web tools a lane's agent judges itself where it can (`GuardInput.webOn`). */
const WEB_TOOLS: ReadonlySet<string> = new Set(['WebSearch', 'WebFetch']);
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
    return unreadableHazard(command, hazards);
  } catch (cause) {
    if (isTooDeep(cause)) return command;
    throw cause;
  }
}

/**
 * Why a call the guard allows must still reach 10db's permission broker, or null when Claude Code's
 * permission mode may decide it.
 */
function brokerAsk(input: GuardInput, onlyReads: boolean): string | null {
  // No allow rule names them, so the call reaches auto mode's classifier before it could settle.
  if (input.webOn === true && WEB_TOOLS.has(input.toolName)) return null;
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
      return input.fileAccess.readAsk(input.toolName, input.toolInput, input.cwd);
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
  // A line made only of read-only commands names no program outside that closed set, so none of
  // them is a hazard, however a word such as `"[v]itest"` looks to the scanner.
  if (unclaimed.length === 0 || onlyReads) return null;
  const part = mayRunHazard(command, unclaimed);
  if (part === null) return null;
  const names = unclaimed.map((hazard) => `"${hazard.name}"`).join(', ');
  return `10db can't read whether "${part}" runs a hazard this task hasn't claimed (${names}), so the builder is asked. Spell the command out in plain words, or claim the hazard first.`;
}

const READS_ONLY =
  'Every part of this command only reads (decisions/2026-11-03-a-lane-runs-read-only-commands-without-a-card.md).';

const OWN_PICTURE =
  "A picture pasted into this task's thread is the session's to read (Workbench spec §13).";

/** Whether the call is a Read of a picture pasted into the session's own task. */
function readsOwnPicture(input: GuardInput): boolean {
  if (input.toolName !== 'Read' || input.ownSession?.filesDir === undefined) return false;
  const file = stringField(input.toolInput, 'file_path');
  const from = input.cwd !== undefined && isAbsolute(input.cwd) ? input.cwd : input.repoPath;
  return file !== null && isOwnFile(input.ownSession.filesDir, file, from);
}

/** A word longer than this is not split into the paths it may hold; the call keeps today's judgement. */
const MAX_OPTION_WORD = 256;

/**
 * The paths a word may name, or null for a word too long to split. A plain word is one path. A long
 * option names one only after its `=`. A short option's value may be attached (`-f/x`, `-nf/x`,
 * `-A3`) and the guard knows no program's options, so every tail of the word counts as a path: a
 * letter or two judged as a relative path is harmless, and none is missed.
 */
function pathsOf(word: string): string[] | null {
  if (word.startsWith('--')) {
    const value = /^--[A-Za-z][\w-]*=(.*)$/s.exec(word)?.[1];
    return value === undefined ? [] : [value];
  }
  if (!word.startsWith('-') || word.length === 1) return [word];
  if (word.length > MAX_OPTION_WORD) return null;
  const paths: string[] = [];
  for (let at = 1; at < word.length; at += 1) paths.push(word.slice(at));
  return paths;
}

/**
 * Whether a read of `real` may reach a device that yields bytes forever: it is one, or a directory
 * that holds one (`/dev`, and `/` above it), which a recursive read walks into.
 */
function holdsEndlessFile(real: string): boolean {
  const dir = real.endsWith('/') ? real : `${real}/`;
  for (const file of ENDLESS_FILES) if (file === real || file.startsWith(dir)) return true;
  return false;
}

/**
 * A device that yields bytes forever, or a tree holding one: a foreground read spins until the Bash
 * timeout. The path is read from the command's working directory (the hook's `cwd`, which an earlier call's `cd` may have moved off the lane's copy) as the kernel
 * opens it, links followed, and with `..` collapsed as text first; either reading naming one counts,
 * and so does a path that has no single real path, so a spelling is never a way past it.
 */
function isEndlessFile(path: string, cwd: string): boolean {
  if (holdsEndlessFile(posix.normalize(path))) return true;
  try {
    const base = resolve(cwd);
    return [
      realPathOf(isAbsolute(path) ? path : `${base}${sep}${path}`),
      realPathOf(resolve(base, path)),
    ].some(holdsEndlessFile);
  } catch {
    return true;
  }
}

/**
 * Whether a sandboxed lane's Bash command is made only of read-only commands and names no path a
 * lane may never read. It has no `cd` (a relative path would then mean another directory; one from
 * an earlier call is already in the hook's `cwd`, which every relative word is judged from) and
 * every word is judged as a path the way the file tools' reads are, so a secret file, a protected
 * directory and a search over one stay with today's judgement. A path outside the paths a lane may
 * read without asking is not judged here: the sandbox's read policy confines Bash to the paths it
 * lists, so a read outside them fails inside the sandbox whatever the classifier thinks.
 */
function onlyReads(input: GuardInput): boolean {
  if (input.toolName !== 'Bash' || input.fileAccess === undefined) return false;
  const command = stringField(input.toolInput, 'command');
  if (command === null) return false;
  const segments = laneReadOnlyWords(command);
  if (segments === null) return false;
  // Where the call really runs: an earlier call's `cd` carries into this one. A directory the hook
  // did not give as an absolute path is one a relative word cannot be judged from.
  const cwd = input.cwd ?? input.repoPath;
  if (!isAbsolute(cwd)) return false;
  const moved = resolve(cwd) !== resolve(input.repoPath);
  try {
    for (const [cmd = '', ...args] of segments) {
      if (cmd === 'cd') return false;
      for (const word of args) {
        if (word === '') continue;
        const paths = pathsOf(word);
        if (paths === null) return false;
        for (const path of paths) {
          if (path === '' || path.startsWith('~') || isEndlessFile(path, cwd)) return false;
          // The file-access judge reads a relative path from the copy's root, so away from it the
          // word is joined to the directory first (not collapsed: `..` after a link means something).
          const judged = moved && !isAbsolute(path) ? `${cwd}${sep}${path}` : path;
          if (input.fileAccess.read('LS', { path: judged }) !== 'ok') return false;
        }
      }
    }
  } catch {
    return false;
  }
  return true;
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
  const reads = onlyReads(input);
  const reason = brokerAsk(input, reads);
  if (reason !== null) return { decision: 'ask', reason };
  // The judge opened it, and the data directory holds it: no allow rule or classifier reaches it.
  if (readsOwnPicture(input)) return { decision: 'allow', settled: OWN_PICTURE };
  return reads ? { decision: 'allow', settled: READS_ONLY } : verdict;
}
