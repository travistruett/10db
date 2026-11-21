import { isAbsolute, join, relative, resolve } from 'node:path';
import { ChatToolName, JudgeKind, ShapeToolName, type WorkPlace } from '@10db/contracts';
import { isWithinOnEveryReading, stringField } from '../guard';
import type { ShapeVerdict } from '../sessions';
import { expandHome } from '../sandbox';
import { judgePlanTool, judgeShapeCall, type ShapeAccess, type ShapeReviewTurn } from '../shape';
import { firstChangeOf } from './first-change';
import { CHAT_GIT_REFUSAL, JUDGED_CHAT_TOOL_ASK, JUDGED_CHAT_TOOLS } from './git-rule';

// Sessions spec §7.1, trust line §5: what a chat's PreToolUse hook settles before the judge sees a
// call. A chat reads the project and its pictures, runs commands in its read-only sandbox, searches the
// web where a judge sees each call, launches Claude Code's own agents and calls its own builder tools.
// It edits files only while its turn holds Your folder (`ChatPlace`), on the real path of each file.

const READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob']);
const WEB_TOOLS: ReadonlySet<string> = new Set(['WebSearch', 'WebFetch']);
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const AGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);
const OWN_PREFIX = 'mcp__10db__';
const CHAT_TOOLS: ReadonlySet<string> = new Set(Object.values(ChatToolName));
const PLAN_TOOLS: ReadonlySet<string> = new Set(Object.values(ShapeToolName));

const deny = (reason: string): ShapeVerdict => ({ decision: 'deny', reason });
const ALLOW: ShapeVerdict = { decision: 'allow' };

/** What a chat's agent reads when it reaches for a tool that writes with no place to write. */
export const CHAT_WRITES_LATER =
  'This session reads the project and changes nothing in it yet. Say what you would change, and offer to file it as a task.';
/** What a chat on an account with no judge reads when it reaches for the web. */
export const CHAT_NO_WEB =
  "The web needs a judge that sees each call, and this project's account has none yet, so this chat reads the project only.";

/** What a session's agent reads when its first change is refused while the builder chooses where it goes. */
export const WAITING_FOR_CHOICE = 'Waiting for the builder to choose where this work happens.';

/** What a session's agent reads when it changes files while its new branch is being made. */
export const CHAT_MOVING = 'This session is moving to its own branch. Wait for the move to finish.';

/**
 * What a session's guard reads of where it works at each call: the place can change between calls, so each
 * read is live. `root` is the folder its files are judged inside, and `checkout` is the builder's.
 */
export interface ChatPlace {
  /** Null while the session only reads. */
  readonly place: WorkPlace | null;
  /** Whether the chat's turn may write its root now: Here, holding the checkout; a branch, while a turn runs. */
  holds(): boolean;
  /** Whether this is the chat's current session: an older one, or one that has closed, never is. */
  current(): boolean;
  /** Whether this session was opened able to write. */
  readonly writable: boolean;
  /** Who keeps the turn from holding the checkout, in words. */
  heldBy(): string;
  /** The folder this session's edits must stay inside. */
  readonly root: string;
  /** The builder's checkout. */
  readonly checkout: string;
  /** The first change was asked for: records the question and stops the turn. */
  firstChange(): void;
}

/** What a chat's agent reads when it calls a tool after its turn ended, or from another session. */
export const CHAT_TURN_ENDED =
  'This turn has ended and given your checkout back, so nothing it started may act.';

/** What a chat's agent reads when it edits while another holder has the builder's checkout. */
export const chatFolderInUse = (holder: string): string => `Your checkout is in use by ${holder}.`;

/** The path a file tool names, with `~` read as the home folder and the rest resolved from the call's directory. */
function editedPath(call: ChatCall, access: ShapeAccess): string | null {
  if (typeof call.input !== 'object' || call.input === null) return null;
  // The field is the tool's own: another field in the same input is never read, as Claude Code reads it.
  const named = stringField(
    call.input,
    call.toolName === 'NotebookEdit' ? 'notebook_path' : 'file_path',
  );
  if (named === null || named === '') return null;
  return resolve(call.cwd ?? access.checkout, expandHome(named, access.home));
}

/** Judges an edit: the root must be writable now, the file inside it, and its real path not git state or protected. */
function judgeEdit(
  call: ChatCall,
  access: ShapeAccess,
  folder: ChatPlace | undefined,
): ShapeVerdict {
  if (folder === undefined) return deny(CHAT_WRITES_LATER);
  if (!folder.holds()) return deny(chatFolderInUse(folder.heldBy()));
  // A branch session with no worktree on disk has only the checkout to write in, and never writes there.
  if (folder.place === 'branch' && !folder.writable) return deny(CHAT_WRITES_LATER);
  const judge = access.commands?.fileAccess;
  const path = editedPath(call, access);
  if (judge === undefined || path === null) return deny(`${call.toolName} could not be judged.`);
  try {
    // Every reading must land inside: a link, even a dangling one, is followed through its target.
    if (!isWithinOnEveryReading(folder.root, path)) {
      // A session that moved to its worktree is pointed at the same file there.
      const inCheckout = relative(folder.checkout, path);
      if (
        folder.root !== folder.checkout &&
        inCheckout !== '' &&
        !inCheckout.startsWith('..') &&
        !isAbsolute(inCheckout)
      )
        return deny(
          `This session works in ${folder.root} now. The same file is at ${join(folder.root, inCheckout)}.`,
        );
      return deny(`${path} is outside your checkout.`);
    }
    const verdict = judge.write(path);
    if (verdict !== 'ok') return deny(verdict.refuse);
    // A chat has no card for an edit the lane's guard would ask about (a Claude Code configuration path).
    const asked = judge.writeAsk(path);
    return asked === null ? ALLOW : deny(`${asked} A chat never edits it.`);
  } catch {
    return deny(`${path} could not be resolved to one real path; 10db refuses it.`);
  }
}

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
export function judgeChatCall(
  call: ChatCall,
  access: ShapeAccess,
  folder?: ChatPlace,
  review?: () => readonly ShapeReviewTurn[],
): ShapeVerdict {
  const asSession = {
    toolName: call.toolName,
    toolInput: call.input,
    ...(call.cwd === undefined ? {} : { cwd: call.cwd }),
  };
  if (folder !== undefined) {
    // A session that only reads or is being asked where to work keeps no call once the chat has another
    // session (a background agent's, however long it stays warm).
    if ((folder.place === null || folder.place === 'choosing') && !folder.current())
      return deny(CHAT_TURN_ENDED);
    // A session that can write keeps no call while its turn can't write (a background agent's or a job's).
    if (folder.writable && !folder.holds()) return deny(CHAT_TURN_ENDED);
    if (folder.place === 'moving' && firstChangeOf(call) !== null) return deny(CHAT_MOVING);
    // The first change asks where the work happens, and is refused until the builder answers.
    if ((folder.place === null || folder.place === 'choosing') && firstChangeOf(call) !== null) {
      folder.firstChange();
      return deny(WAITING_FOR_CHOICE);
    }
  }
  if (EDIT_TOOLS.has(call.toolName)) return judgeEdit(call, access, folder);
  if (READ_TOOLS.has(call.toolName)) return judgeShapeCall(asSession, access);
  if (call.toolName === 'Bash')
    return judgeShapeCall(asSession, { ...access, gitWriteRefusal: CHAT_GIT_REFUSAL });
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
  if (call.toolName.startsWith(OWN_PREFIX)) {
    const own = call.toolName.slice(OWN_PREFIX.length);
    // Every session has Plan's tools; who calls which is Plan's judge's (`report_finding` only from a reviewer).
    if (PLAN_TOOLS.has(own))
      return judgePlanTool(
        {
          toolName: call.toolName,
          toolInput: call.input,
          agentId: call.agentId,
          agentType: call.agentType,
        },
        review,
      );
    if (!CHAT_TOOLS.has(own)) return deny(`${call.toolName} is not one of this chat's tools.`);
    // Only 10db's judge settles these. Claude's auto mode lets a push, a pull request and a merge through unasked,
    // so on it, and on the rules floor, the builder is asked.
    if (JUDGED_CHAT_TOOLS.has(own) && access.judge !== JudgeKind.Tendb)
      return { decision: 'ask', reason: JUDGED_CHAT_TOOL_ASK };
    return ALLOW;
  }
  // A tool of one of the project's approved servers is judged as Plan's are.
  if (call.toolName.startsWith('mcp__')) return judgeShapeCall(asSession, access);
  return deny(`${call.toolName} is not a tool this chat uses.`);
}
