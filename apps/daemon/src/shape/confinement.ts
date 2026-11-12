import { isIP } from 'node:net';
import { join } from 'node:path';
import { ShapeToolName } from '@10db/contracts';
import { z } from 'zod';
import {
  isOverLongPath,
  judgePreToolUse,
  OVER_LONG_PATH_REFUSAL,
  runsInBackground,
  splitCommand,
  stringField,
  type FileAccessJudge,
  type GuardVerdict,
  type ProtectedPath,
} from '../guard';
import { readAccess, readPathsOf, type FileAccessContext } from '../sandbox';
import type { ShapeVerdict } from '../sessions';

// Shape spec §5.2. A Shape session's file tools read the project's checkout and its conversation's
// dropped files, and nothing else; this judge refuses the rest with no card. In its read-only lane
// sandbox it also runs commands: a read-only one without asking, any other through the lanes'
// permission broker (`ask`), as the conversation's calls to the project's MCP servers are. The
// sandbox, not this judge, keeps every command from writing the checkout.

/** The reviewers a Shape session may launch with `Agent` (§7). */
export const SHAPE_REVIEWERS = ['scope', 'engineering', 'rehearsal'] as const;

/**
 * The agent that reads the code for the session (§5.2): file tools and, in the sandbox, the same
 * commands. It touches neither the web nor an MCP server and launches nothing.
 */
export const SHAPE_CODE_RESEARCHER = 'code-researcher';

/** The models a session may name for an agent it launches: the Agent tool's own aliases. */
export const SHAPE_AGENT_MODELS = ['opus', 'fable', 'sonnet', 'haiku'] as const;

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
  /**
   * Every root 10db keeps sandboxes' temp dirs and files in: no Shape session reads there, even
   * inside a checkout that holds one.
   */
  readonly sandboxRoots: readonly string[];
  /**
   * Present when the session runs in its read-only lane sandbox: its commands are judged by the
   * guard, as a lane's are. Absent, it runs no command and calls no MCP server but 10db's.
   */
  readonly commands?: {
    readonly protectedPaths: readonly ProtectedPath[];
    readonly fileAccess: FileAccessJudge;
  };
  /** The folders the session's setup opened read-only, as its sandbox kept them; none without one. */
  readonly setupReads?: readonly string[];
  /** The Agent tool aliases the project's account takes, which an agent may be launched on; empty when it takes none; every alias when absent. */
  readonly agentModels?: readonly string[];
}

/** One tool call as the PreToolUse hook sees it; the SDK sets `agentId` only inside a subagent. */
export interface ShapeCall {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly agentId?: string | undefined;
  readonly agentType?: string | undefined;
  /** Where the call runs, from the hook; absent means the checkout. */
  readonly cwd?: string | undefined;
}

const READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob']);
const WEB_TOOLS: ReadonlySet<string> = new Set(['WebSearch', 'WebFetch']);
const MCP_PREFIX = 'mcp__10db__';
const COMMAND_TOOLS: ReadonlySet<string> = new Set(['Bash']);
const SHAPE_TOOLS: ReadonlySet<string> = new Set(Object.values(ShapeToolName));
/** The tool only a reviewer calls; every other Shape tool is the main session's. */
const REVIEWER_TOOL: string = ShapeToolName.ReportFinding;

const deny = (reason: string): GuardVerdict => ({ decision: 'deny', reason });
/** A place no file is: a Shape session has no Claude Code config or temp dir of its own to read. */
const NOWHERE = '/var/empty/10db-shape';
const ask = (reason: string): GuardVerdict => ({ decision: 'ask', reason });
const ALLOW: GuardVerdict = { decision: 'allow' };

/** The agents that may run a command: the session itself, and the code researchers it launches. */
const runsCommands = (call: ShapeCall): boolean =>
  call.agentId === undefined || call.agentType === SHAPE_CODE_RESEARCHER;

const BACKGROUND_REFUSAL =
  'A planning session runs its commands in the foreground only, so each ends before the turn does. Run it without run_in_background.';
const UNSANDBOXED_REFUSAL =
  'A planning session runs commands only inside its read-only sandbox. Run it without dangerouslyDisableSandbox.';
const NOT_READ_ONLY =
  'This command is not one 10db reads as read-only, so the builder decides whether it runs. It runs in a sandbox that cannot change the checkout.';

/** Programs whose job is to outlive the command that starts them. */
const DETACHERS: ReadonlySet<string> = new Set(['nohup', 'setsid', 'disown']);

/**
 * Whether a command puts a job in the background, nested scripts included: a planning session's
 * process is not watched as a lane's is, so nothing it starts may outlive the command.
 */
function startsBackgroundJob(command: string): boolean {
  return splitCommand(command).some(
    (segment) => segment.separator === '&' || DETACHERS.has(segment.words[0] ?? ''),
  );
}

/** A command's input, as far as its flags go; anything else in it is the guard's to read. */
const CommandFlags = z.looseObject({});

/** A flag set in a command's input: any value but an absent, null or false one counts. */
function flagged(input: unknown, key: 'run_in_background' | 'dangerouslyDisableSandbox'): boolean {
  const parsed = CommandFlags.safeParse(input);
  if (!parsed.success) return false;
  return key === 'run_in_background'
    ? runsInBackground(parsed.data)
    : runsInBackground({ run_in_background: parsed.data[key] });
}

/**
 * A command, by the guard a lane's commands meet: what it refuses stays refused, a read-only command
 * runs without asking, and anything else is the builder's call through the broker.
 */
function judgeCommand(call: ShapeCall, access: ShapeAccess): GuardVerdict {
  const { commands } = access;
  if (commands === undefined)
    return deny(
      `${call.toolName} is not available: this planning session has no sandbox to run a command in.`,
    );
  if (!runsCommands(call))
    return deny(
      `${call.toolName} is not available to the ${call.agentType ?? 'this'} agent: only the session and its code researchers run commands.`,
    );
  if (flagged(call.toolInput, 'dangerouslyDisableSandbox')) return deny(UNSANDBOXED_REFUSAL);
  if (flagged(call.toolInput, 'run_in_background')) return deny(BACKGROUND_REFUSAL);
  const command = stringField(call.toolInput, 'command');
  if (command !== null && startsBackgroundJob(command)) return deny(BACKGROUND_REFUSAL);
  const verdict = judgePreToolUse({
    toolName: call.toolName,
    toolInput: call.toolInput,
    repoPath: access.checkout,
    ...(call.cwd === undefined ? {} : { cwd: call.cwd }),
    // A conversation claims nothing and holds no hazard; every command that is not read-only asks.
    areas: [],
    hazards: [],
    claims: [],
    readOnly: false,
    protectedPaths: commands.protectedPaths,
    fileAccess: commands.fileAccess,
  });
  if (verdict.decision === 'allow' && verdict.settled === undefined) return ask(NOT_READ_ONLY);
  return verdict;
}

/** A tool of one of the project's approved MCP servers: the conversation's own, asked about on each call. */
function judgeProjectTool(call: ShapeCall, access: ShapeAccess): GuardVerdict {
  if (access.commands === undefined)
    return deny(`${call.toolName} is not available: this planning session has 10db's tools only.`);
  if (call.agentId !== undefined)
    return deny(
      `${call.toolName} is the conversation's to call: an agent it launches reaches no MCP server.`,
    );
  return ask(`${call.toolName} reaches a project MCP server; 10db judges every call.`);
}

function fileAccessContext(access: ShapeAccess): FileAccessContext {
  return {
    checkout: access.checkout,
    home: access.home,
    protectedReads: access.protectedReads,
    ...(access.secretFiles === undefined ? {} : { secretFiles: access.secretFiles }),
    readList: [access.filesDir],
    // Nothing of Claude Code's is readable: a large result is read back through a narrower search.
    configDir: join(NOWHERE, 'no-claude-config'),
    providerSessionId: null,
    sandboxTemp: { roots: access.sandboxRoots, own: join(NOWHERE, 'no-own-temp-dir') },
    ...(access.setupReads === undefined ? {} : { setupReads: access.setupReads }),
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

/**
 * An agent the session launches. It runs in the foreground whatever the call asks, so it ends within
 * the turn that launched it, and only on a model the project's account offers.
 */
function judgeAgent(call: ShapeCall, access: ShapeAccess): ShapeVerdict {
  const verdict = judgeAgentType(call, access);
  if (verdict.decision !== 'allow') return verdict;
  const parsed = CommandFlags.safeParse(call.toolInput);
  return {
    decision: 'allow',
    updatedInput: { ...(parsed.success ? parsed.data : {}), run_in_background: false },
  };
}

function judgeAgentType(call: ShapeCall, access: ShapeAccess): GuardVerdict {
  if (call.agentId !== undefined) return deny('A subagent cannot launch another agent.');
  // `isolation` makes a git worktree of the checkout (a write) or runs the agent in a cloud
  // environment where this hook never sees its calls; either breaks the confinement below.
  const input = call.toolInput;
  if (
    typeof input === 'object' &&
    input !== null &&
    (input as Record<string, unknown>)['isolation'] !== undefined
  )
    return deny('A Shape session launches its agents in place, with no isolation set.');
  const type = stringField(call.toolInput, 'subagent_type');
  const model = stringField(call.toolInput, 'model');
  const offered: readonly string[] = access.agentModels ?? SHAPE_AGENT_MODELS;
  if (model !== null && !offered.includes(model))
    return deny(
      offered.length === 0
        ? "An agent runs on the session's model on this project's account; name no model."
        : `An agent runs on a model this project's account offers (${offered.join(', ')}), or on the session's model.`,
    );
  if (type === SHAPE_CODE_RESEARCHER) return ALLOW;
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
        `A Shape session launches only its reviewers (${SHAPE_REVIEWERS.join(', ')}), the researcher and the code researcher.`,
      );
}

const isResearcher = (call: ShapeCall): boolean =>
  call.agentId !== undefined && call.agentType === SHAPE_RESEARCHER;

/** Hosts that name a machine of the builder's own network, not the public web. */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet'];

/**
 * Why a URL names no host on the public web (an address, `localhost`, a `.local` name and the like,
 * which reach this Mac or its network), or null when it names one.
 */
export function privateHostProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${raw} is not a URL.`;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0) return `${host} is an address, not a named host.`;
  if (!host.includes('.') || host === 'localhost' || LOCAL_SUFFIXES.some((s) => host.endsWith(s)))
    return `${host} is not on the public web; the daemon and the builder's network are out of reach.`;
  return null;
}

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
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0)
    return 'The researcher fetches a named host, not an address.';
  return privateHostProblem(raw);
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

/** Most characters of a command or a tool's input that its dimmed line shows. */
const LINE_LIMIT = 300;
const clip = (text: string): string =>
  text.length > LINE_LIMIT ? `${text.slice(0, LINE_LIMIT)}…` : text;

/** A tool of a project MCP server: `mcp__<server>__<tool>`, any server but 10db's. */
const isProjectTool = (toolName: string): boolean =>
  toolName.startsWith('mcp__') &&
  !toolName.startsWith(MCP_PREFIX) &&
  toolName.split('__').length >= 3;

/**
 * The dimmed line for a command or a project tool call the hook let through or sent to the builder,
 * naming the agent that made it when one did; null for any other call.
 */
export function commandLine(
  toolName: string,
  toolInput: unknown,
  agentType: string | undefined,
): string | null {
  const by = agentType === undefined ? '' : `${agentType} · `;
  if (COMMAND_TOOLS.has(toolName))
    return `${by}Bash · ${clip(stringField(toolInput, 'command') ?? '')}`;
  if (isProjectTool(toolName)) return `${by}${toolName} · ${clip(JSON.stringify(toolInput ?? {}))}`;
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
 * The PreToolUse answer for a Shape session's tool call, or its subagent's. Only a command and a
 * project MCP tool may answer `ask`, and only in the sandbox; anything not listed is refused, so a
 * tool a later Claude Code adds is too.
 */
export function judgeShapeCall(call: ShapeCall, access: ShapeAccess): ShapeVerdict {
  if (READ_TOOLS.has(call.toolName))
    return call.agentType === SHAPE_RESEARCHER && call.agentId !== undefined
      ? deny(
          'The researcher reads no files: it holds neither the project nor the conversation’s files, and answers from the web.',
        )
      : judgeRead(call, access);
  if (WEB_TOOLS.has(call.toolName)) return judgeWeb(call);
  if (call.toolName === 'Agent') return judgeAgent(call, access);
  if (call.toolName.startsWith(MCP_PREFIX)) return judgeShapeTool(call);
  if (COMMAND_TOOLS.has(call.toolName)) return judgeCommand(call, access);
  // A server 10db registered, so one the builder approved for the project.
  if (isProjectTool(call.toolName)) return judgeProjectTool(call, access);
  return deny(
    `${call.toolName} is not available: a Shape session is read-only. It reads the project and talks; it changes nothing.`,
  );
}
