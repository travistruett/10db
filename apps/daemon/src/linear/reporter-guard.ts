import type { ExternalLink, LinearPostId } from '@10db/contracts';
import { Provider, ReporterToolName } from '@10db/contracts';
import type { GuardVerdict } from '../guard';
import { mcpToolPrefix } from '../sessions';
import { OUTBOUND_PATTERNS, SECRET_PATTERN_NAMES } from '../stakeholders';

/** The claude.ai connector's prefix, used whenever the connector list is unread. */
const CONNECTOR_PREFIX = 'mcp__claude_ai_Linear__';

const REPORT_TOOLS: ReadonlySet<string> = new Set([
  `mcp__10db__${ReporterToolName.ReportLinearPost}`,
]);

/** Linear tools that only read. `extract_images` is left out: it fetches URLs. */
const LINEAR_READS: ReadonlySet<string> = new Set([
  'whoami',
  'get_workspace',
  'get_team',
  'list_teams',
  'get_issue',
  'list_comments',
  'list_issue_statuses',
  'get_issue_status',
  'get_attachment',
]);

/** The keys each allowed Linear write may carry; any other key refuses the call. */
const WRITE_KEYS: Readonly<Record<string, readonly string[]>> = {
  save_issue: ['id', 'state'],
  save_comment: ['issueId', 'body'],
};

/** The only Linear tools a snapshot run calls: it reads the linked issue, its comments and its relations. */
const SNAPSHOT_READS: ReadonlySet<string> = new Set(['get_issue', 'list_comments']);

/** The comment 10db built for one owed update: the text `save_comment` must carry, and whether it went out. */
export interface StagedComment {
  readonly text: string;
  written: boolean;
}

export interface ReporterRun {
  /** A snapshot run reads and writes nothing: no 10db tool, no Linear write. */
  readonly readOnly: boolean;
  readonly linearPrefixes: readonly string[];
  readonly link: ExternalLink;
  /**
   * 10db writes the comments itself, through the account's Linear server: the agent calls no Linear comment write.
   * When false, the agent's `save_comment` carries the text 10db built.
   */
  readonly direct: boolean;
  /** Per owed update, the comment 10db built from the agent's body: the only comment text the run may write. */
  readonly comments: Map<LinearPostId, StagedComment>;
  /** The project's note steers status choices, so a status set is the agent's to choose, not 10db's pick. */
  readonly noteSteers: boolean;
  /** The statuses 10db picked this run (`report_linear_post`): with no steering note, the only ones that may be set. */
  readonly pickedStatuses: Set<string>;
}

const allow = (): GuardVerdict => ({ decision: 'allow' });
const deny = (reason: string): GuardVerdict => ({ decision: 'deny', reason });

const asRecord = (input: unknown): Record<string, unknown> | null =>
  typeof input === 'object' && input !== null && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input))
    : null;

const field = (record: Readonly<Record<string, unknown>>, key: string): unknown => record[key];

/** The first secret pattern a text hits, line by line; never what matched. */
export function scanSecrets(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (const { name, pattern } of OUTBOUND_PATTERNS) {
    if (!SECRET_PATTERN_NAMES.includes(name)) continue;
    if (lines.some((line) => pattern.test(line))) return name;
  }
  return null;
}

function* stringsIn(value: unknown): Generator<string> {
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) for (const item of value) yield* stringsIn(item);
  else if (typeof value === 'object' && value !== null)
    for (const item of Object.values(value)) yield* stringsIn(item);
}

/** What a write that passed names: the post whose comment it carries, or the status it sets. */
interface WriteJudged {
  readonly wrote?: LinearPostId;
  readonly statusSet?: string;
}

/**
 * Why a write is not the one this run may make (a sentence that says which part of the call is wrong), or what
 * it writes. Every key must be in the tool's list.
 */
function judgeWrite(
  run: Readonly<ReporterRun>,
  tool: string,
  allowed: readonly string[],
  input: Record<string, unknown>,
): { readonly refusal: string } | WriteJudged {
  const issueId = run.link.issueId;
  const refuse = (why: string): { readonly refusal: string } => ({
    refusal: `This call is refused: ${why}`,
  });
  const extra = Object.keys(input).filter((k) => !allowed.includes(k));
  if (extra.length > 0)
    return refuse(
      `${tool} takes only ${allowed.join(', ')}; it was given ${extra.join(', ')} too.`,
    );
  switch (tool) {
    case 'save_issue': {
      if (field(input, 'id') !== issueId)
        return refuse(`id must be the linked issue's Linear id ${issueId}.`);
      const state = field(input, 'state');
      if (state === undefined) return refuse('save_issue is for setting the status: give state.');
      if (typeof state !== 'string') return refuse('state must be a status name.');
      if (!run.noteSteers && !run.pickedStatuses.has(state))
        return refuse(
          "state is not a status 10db picked for this run. Only the save_issue in report_linear_post's next can be set.",
        );
      return { statusSet: state };
    }
    case 'save_comment': {
      if (run.direct)
        return refuse(
          '10db writes the comments itself: report_linear_post already wrote it, so do not call save_comment.',
        );
      const given = field(input, 'issueId');
      if (given !== issueId)
        return refuse(
          given === run.link.id
            ? `issueId must be the issue's Linear id ${issueId}, not its key ${run.link.id}.`
            : `issueId must be the linked issue's Linear id ${issueId}; this run writes to that issue only.`,
        );
      const body = field(input, 'body');
      if (typeof body !== 'string') return refuse('body must be a string.');
      // Two updates can end in the same words (two verdicts of one attempt): each save_comment takes the next
      // one not yet written, so a text built twice is written twice.
      const built = [...run.comments].filter(([, comment]) => comment.text === body);
      if (built.length === 0)
        return refuse(
          'body is not a comment 10db built. Call report_linear_post with the post id and your comment body, then pass the arguments it returns to save_comment unchanged.',
        );
      const staged = built.find(([, comment]) => !comment.written);
      if (staged === undefined)
        return refuse(
          `the comment for ${built[0]?.[0] ?? 'this update'} was already written; do not write it again.`,
        );
      return { wrote: staged[0] };
    }
    default:
      return refuse(`${tool} is not a tool this run may call.`);
  }
}

/** The first secret pattern any string in a call's input hits. */
export function secretIn(input: unknown): string | null {
  for (const text of stringsIn(input)) {
    const pattern = scanSecrets(text);
    if (pattern !== null) return pattern;
  }
  return null;
}

/**
 * Pure: the rule for one call of the reporter. `withheld` names the one post whose comment carried a secret and
 * the pattern it matched; the caller withholds that row only.
 */
export function judgeReporterCall(
  run: Readonly<ReporterRun>,
  call: { toolName: string; input: unknown },
): {
  verdict: GuardVerdict;
  withheld?: { readonly postId: LinearPostId; readonly pattern: string };
  wrote?: LinearPostId;
  /** The status an allowed `save_issue` sets. */
  statusSet?: string;
} {
  const { toolName } = call;
  if (toolName.startsWith('mcp__10db__')) {
    if (run.readOnly) return { verdict: deny('A snapshot run may only read Linear.') };
    return {
      verdict: REPORT_TOOLS.has(toolName)
        ? allow()
        : deny('The reporter may only call its own report tools.'),
    };
  }
  const prefix = run.linearPrefixes.find((p) => toolName.startsWith(p));
  if (prefix === undefined) {
    return {
      verdict:
        toolName === 'ToolSearch'
          ? allow()
          : deny('The reporter writes to Linear only; its facts are in its brief.'),
    };
  }
  const tool = toolName.slice(prefix.length);
  const secret = secretIn(call.input);
  if (run.readOnly && !SNAPSHOT_READS.has(tool))
    return {
      verdict: deny(
        'A snapshot run may only read the linked issue, its comments and its relations.',
      ),
    };
  if (LINEAR_READS.has(tool)) {
    return {
      verdict:
        secret === null
          ? allow()
          : deny(`The call carries text that matches ${secret}; it is refused.`),
    };
  }
  const allowed = Object.hasOwn(WRITE_KEYS, tool) ? WRITE_KEYS[tool] : undefined;
  if (allowed === undefined)
    return {
      verdict: deny(
        `This call is refused: ${tool} is not a tool this run may call. The reporter's Linear writes are its comment on the linked issue, through report_linear_post, and the status 10db picks; 10db sets links and pictures itself.`,
      ),
    };
  const input = asRecord(call.input);
  if (input === null)
    return { verdict: deny('This call is refused: the arguments must be an object.') };
  const judged = judgeWrite(run, tool, allowed, input);
  if ('refusal' in judged) return { verdict: deny(judged.refusal) };
  if (secret !== null) {
    const verdict = deny(`Withheld: the text matches ${secret}; nothing is written.`);
    return judged.wrote === undefined
      ? { verdict }
      : { verdict, withheld: { postId: judged.wrote, pattern: secret } };
  }
  return {
    verdict: allow(),
    ...(judged.wrote === undefined ? {} : { wrote: judged.wrote }),
    ...(judged.statusSet === undefined ? {} : { statusSet: judged.statusSet }),
  };
}

/** The Linear tools a posting run's brief names: what an update reads and writes. */
const POSTING_LINEAR_TOOLS: readonly string[] = [
  'get_issue',
  'list_comments',
  'list_issue_statuses',
  'save_comment',
  'save_issue',
];

/**
 * The full names of the tools a run needs, from the rule's own lists: a snapshot's reads, or a posting run's reads,
 * writes and report tools. The brief names them so a session whose tools are deferred searches for them by name.
 */
export function runToolNames(run: Readonly<ReporterRun>): string[] {
  const linear = run.readOnly ? [...SNAPSHOT_READS] : [...POSTING_LINEAR_TOOLS];
  const tenDb = run.readOnly ? [] : [...REPORT_TOOLS];
  return [...run.linearPrefixes.flatMap((prefix) => linear.map((tool) => prefix + tool)), ...tenDb];
}

/**
 * The tool-name prefixes (`mcp__<server>__`) Linear's tools carry. Claude and Codex both name a server's
 * tool `mcp__<server>__<tool>` (the Codex hook's name is split the same way in `codex-refused-calls.ts`),
 * with the server's name made safe by `mcpToolPrefix`.
 */
export function linearToolPrefixes(via: {
  connector: boolean;
  entries: readonly string[];
  harness: Provider;
}): string[] {
  const prefixes = via.entries.map((name) => `mcp__${mcpToolPrefix(name)}__`);
  if (via.connector && via.harness === Provider.Claude) prefixes.unshift(CONNECTOR_PREFIX);
  return [...new Set(prefixes)];
}
