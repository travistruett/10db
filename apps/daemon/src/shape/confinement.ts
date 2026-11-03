import { isIP } from 'node:net';
import { join } from 'node:path';
import { ShapeToolName } from '@10db/contracts';
import {
  isOverLongPath,
  namesPrivateHost,
  OVER_LONG_PATH_REFUSAL,
  stringField,
  type GuardVerdict,
} from '../guard';
import { readAccess, readPathsOf, type FileAccessContext } from '../sandbox';
import type { ShapeVerdict } from '../sessions';

// Shape spec §5.2. A Shape session reads the project's checkout and its conversation's dropped
// files, and nothing else. It runs no command, so there is no sandbox to hold one; this judge is the
// confinement. It answers `deny` where a lane's judge answers `ask`, so nothing reaches the broker.

/** The reviewers a Shape session may launch with `Agent` (§7). */
export const SHAPE_REVIEWERS = ['scope', 'engineering', 'rehearsal'] as const;

/**
 * The agent that reaches the web (§5.2). It is not a reviewer: it reports no finding and has no file
 * tool, so the agent holding the project's code is never the one that can send a request.
 */
export const SHAPE_RESEARCHER = 'researcher';

/** Most characters of the question the session hands the researcher, of a search and of a URL. */
export const RESEARCH_QUESTION_LIMIT = 1_500;
export const RESEARCH_QUERY_LIMIT = 300;
export const RESEARCH_URL_LIMIT = 2_000;

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
const WEB_TOOLS: ReadonlySet<string> = new Set(['WebSearch', 'WebFetch']);
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
  if (call.agentId !== undefined) return deny('A subagent cannot launch another agent.');
  const type = stringField(call.toolInput, 'subagent_type');
  if (type === SHAPE_RESEARCHER) {
    // The question is the only thing that reaches the researcher, and the researcher can send
    // requests: bounding it bounds what the session can hand across (§5.2).
    const question = stringField(call.toolInput, 'prompt');
    if (question === null || question.trim() === '')
      return deny('The researcher needs a question in words.');
    if (question.length > RESEARCH_QUESTION_LIMIT)
      return deny(
        `A question for the researcher is at most ${String(RESEARCH_QUESTION_LIMIT)} characters; ask it in words and leave the code out.`,
      );
    return ALLOW;
  }
  return type !== null && (SHAPE_REVIEWERS as readonly string[]).includes(type)
    ? ALLOW
    : deny(
        `A Shape session launches only its reviewers (${SHAPE_REVIEWERS.join(', ')}) and the researcher.`,
      );
}

const isResearcher = (call: ShapeCall): boolean =>
  call.agentId !== undefined && call.agentType === SHAPE_RESEARCHER;

/** Why a URL is not a public web page the researcher may fetch, or null when it is one. */
function publicPageProblem(raw: string): string | null {
  if (raw.length > RESEARCH_URL_LIMIT)
    return `A URL is at most ${String(RESEARCH_URL_LIMIT)} characters.`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${raw} is not a URL.`;
  }
  if (url.protocol !== 'https:') return 'The researcher fetches https pages only.';
  if (url.username !== '' || url.password !== '') return 'A URL with a login in it is refused.';
  if (url.port !== '' && url.port !== '443') return 'The researcher fetches port 443 only.';
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0)
    return 'The researcher fetches a named host, not an address.';
  if (namesPrivateHost(host))
    return `${host} is not on the public web; the daemon and the builder's network are out of reach.`;
  return null;
}

/**
 * The dimmed line for an allowed call that sends something to the researcher or out to the web: the
 * question, a search's query or a fetch's URL; null for any other call.
 */
export function researchLine(toolName: string, toolInput: unknown): string | null {
  if (toolName === 'WebSearch') return `WebSearch · ${stringField(toolInput, 'query') ?? ''}`;
  if (toolName === 'WebFetch') return `WebFetch · ${stringField(toolInput, 'url') ?? ''}`;
  if (toolName === 'Agent' && stringField(toolInput, 'subagent_type') === SHAPE_RESEARCHER)
    return `${SHAPE_RESEARCHER} · asked · ${stringField(toolInput, 'prompt') ?? ''}`;
  return null;
}

function judgeWeb(call: ShapeCall): GuardVerdict {
  if (!isResearcher(call))
    return deny(
      `${call.toolName} is not available here: only the researcher touches the web. Launch it with Agent, subagent_type "${SHAPE_RESEARCHER}", and ask it in words.`,
    );
  if (call.toolName === 'WebSearch') {
    const query = stringField(call.toolInput, 'query');
    if (query === null || query.trim() === '') return deny('A search needs a query.');
    if (query.length > RESEARCH_QUERY_LIMIT)
      return deny(`A search query is at most ${String(RESEARCH_QUERY_LIMIT)} characters.`);
    return ALLOW;
  }
  const url = stringField(call.toolInput, 'url');
  if (url === null) return deny('A fetch needs a url.');
  const problem = publicPageProblem(url);
  return problem === null ? ALLOW : deny(problem);
}

function judgeShapeTool(call: ShapeCall): ShapeVerdict {
  const name = call.toolName.slice(MCP_PREFIX.length);
  if (!SHAPE_TOOLS.has(name)) return deny(`${call.toolName} is not a Shape tool.`);
  const isReviewer = call.agentId !== undefined;
  if (name !== REVIEWER_TOOL)
    return isReviewer ? deny(`A reviewer cannot call ${name}; it reports findings only.`) : ALLOW;
  if (!isReviewer) return deny('Only a reviewer reports a finding; the main session cannot.');
  const reviewer = call.agentType;
  if (reviewer === undefined || !(SHAPE_REVIEWERS as readonly string[]).includes(reviewer))
    return deny(`Only a ${SHAPE_REVIEWERS.join(', ')} reviewer reports a finding.`);
  // The finding's reviewer is the subagent's type, set here over whatever the model wrote: the MCP
  // handler can't tell a reviewer from the session, since they share a connection.
  const input =
    typeof call.toolInput === 'object' && call.toolInput !== null
      ? (call.toolInput as Record<string, unknown>)
      : {};
  return { decision: 'allow', updatedInput: { ...input, reviewer } };
}

/**
 * The PreToolUse answer for a Shape session's tool call, or its subagent's: `allow` or `deny`, never
 * `ask`. Anything not listed is refused, so a tool a later Claude Code adds is too.
 */
export function judgeShapeCall(call: ShapeCall, access: ShapeAccess): ShapeVerdict {
  if (READ_TOOLS.has(call.toolName))
    return call.agentType === SHAPE_RESEARCHER && call.agentId !== undefined
      ? deny(
          'The researcher reads no files: it holds neither the project nor the conversation’s files, and answers from the web.',
        )
      : judgeRead(call, access);
  if (WEB_TOOLS.has(call.toolName)) return judgeWeb(call);
  if (call.toolName === 'Agent') return judgeAgent(call);
  if (call.toolName.startsWith(MCP_PREFIX)) return judgeShapeTool(call);
  return deny(
    `${call.toolName} is not available: a Shape session is read-only. It reads the project and talks; it changes nothing.`,
  );
}
