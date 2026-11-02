import { join } from 'node:path';
import { ShapeToolName } from '@10db/contracts';
import { isOverLongPath, OVER_LONG_PATH_REFUSAL, stringField, type GuardVerdict } from '../guard';
import { readAccess, readPathsOf, type FileAccessContext } from '../sandbox';

// Shape spec §5.2. A Shape session reads the project's checkout and its conversation's dropped
// files, and nothing else. It runs no command, so there is no sandbox to hold one; this judge is the
// confinement. It answers `deny` where a lane's judge answers `ask`, so nothing reaches the broker.

/** The reviewers a Shape session may launch with `Agent` (§7). */
export const SHAPE_REVIEWERS = ['scope', 'engineering', 'rehearsal'] as const;
export type ShapeReviewer = (typeof SHAPE_REVIEWERS)[number];

/** Where a Shape session may read. */
export interface ShapeAccess {
  /** The project's checkout. */
  readonly checkout: string;
  readonly home: string;
  /** Paths no session reads: 10db's data directory, account configs, sign-ins. */
  readonly protectedReads: readonly string[];
  /** The checkout's secret files by exact real path. */
  readonly secretFiles?: readonly string[];
  /** The conversation's dropped files (§5.4). */
  readonly filesDir: string;
  /** The sandbox temp root, where other sessions' directories and ledgers are. */
  readonly tempRoot: string;
}

/** One tool call as the PreToolUse hook sees it; the SDK sets `agentId` only inside a subagent. */
export interface ShapeCall {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly agentId?: string | undefined;
  readonly agentType?: string | undefined;
}

const READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob']);
const MCP_PREFIX = 'mcp__10db__';
const SHAPE_TOOLS: ReadonlySet<string> = new Set(Object.values(ShapeToolName));
/** The tool only a reviewer calls; every other Shape tool is the main session's. */
const REVIEWER_TOOL: string = ShapeToolName.ReportFinding;

const deny = (reason: string): GuardVerdict => ({ decision: 'deny', reason });
const ALLOW: GuardVerdict = { decision: 'allow' };

function fileAccessContext(access: ShapeAccess): FileAccessContext {
  return {
    checkout: access.checkout,
    home: access.home,
    protectedReads: access.protectedReads,
    ...(access.secretFiles === undefined ? {} : { secretFiles: access.secretFiles }),
    readList: [access.filesDir],
    // Nothing of Claude Code's is readable: a large result is read back through a narrower search.
    configDir: join(access.tempRoot, 'no-claude-config'),
    providerSessionId: null,
    sandboxTemp: { root: access.tempRoot, own: join(access.tempRoot, 'no-own-temp-dir') },
  };
}

function judgeRead(call: ShapeCall, access: ShapeAccess): GuardVerdict {
  const ctx = fileAccessContext(access);
  const paths = readPathsOf(call.toolName, call.toolInput);
  if (paths.length === 0) return deny(`${call.toolName} named no path 10db could read.`);
  let current = call.toolName;
  try {
    for (current of paths) {
      if (isOverLongPath(current)) return deny(OVER_LONG_PATH_REFUSAL);
      const { access: where } = readAccess(current, ctx, call.toolName !== 'Read');
      // `allowed` is the read list, which holds only the conversation's files directory here.
      if (where === 'inside' || where === 'allowed') continue;
      return deny(
        where === 'contains-protected'
          ? `${current} holds a protected path, so a search of it is refused. Search a narrower directory.`
          : `${current} is outside this project's checkout and the conversation's files, or is protected; a Shape session reads only those.`,
      );
    }
  } catch {
    return deny(`${current} could not be judged, so it is refused.`);
  }
  return ALLOW;
}

function judgeAgent(call: ShapeCall): GuardVerdict {
  if (call.agentId !== undefined) return deny('A reviewer cannot launch another agent.');
  const type = stringField(call.toolInput, 'subagent_type');
  return type !== null && (SHAPE_REVIEWERS as readonly string[]).includes(type)
    ? ALLOW
    : deny(`A Shape session launches only its reviewers (${SHAPE_REVIEWERS.join(', ')}).`);
}

function judgeShapeTool(call: ShapeCall): GuardVerdict {
  const name = call.toolName.slice(MCP_PREFIX.length);
  if (!SHAPE_TOOLS.has(name)) return deny(`${call.toolName} is not a Shape tool.`);
  const isReviewer = call.agentId !== undefined;
  if (name === REVIEWER_TOOL)
    return isReviewer ? ALLOW : deny('Only a reviewer reports a finding; the main session cannot.');
  return isReviewer ? deny(`A reviewer cannot call ${name}; it reports findings only.`) : ALLOW;
}

/**
 * The PreToolUse answer for a Shape session's tool call, or its subagent's: `allow` or `deny`, never
 * `ask`. Anything not listed is refused, so a tool a later Claude Code adds is too.
 */
export function judgeShapeCall(call: ShapeCall, access: ShapeAccess): GuardVerdict {
  if (READ_TOOLS.has(call.toolName)) return judgeRead(call, access);
  if (call.toolName === 'Agent') return judgeAgent(call);
  if (call.toolName.startsWith(MCP_PREFIX)) return judgeShapeTool(call);
  return deny(
    `${call.toolName} is not available: a Shape session is read-only. It reads the project and talks; it changes nothing.`,
  );
}
