import type { ExternalLink, LinearBinding } from '@10db/contracts';
import { Provider } from '@10db/contracts';
import type { GuardVerdict } from '../guard';
import { mcpToolPrefix } from '../sessions';
import { OUTBOUND_PATTERNS, SECRET_PATTERN_NAMES } from '../stakeholders';

/** The claude.ai connector's prefix, used whenever the connector list is unread. */
const CONNECTOR_PREFIX = 'mcp__claude_ai_Linear__';

const REPORT_TOOLS: ReadonlySet<string> = new Set([
  'mcp__10db__report_linear_workspace',
  'mcp__10db__report_linear_post',
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
  save_issue: ['id', 'state', 'links'],
  save_comment: ['issueId', 'id', 'body'],
  prepare_attachment_upload: ['issue', 'filename', 'contentType', 'size', 'title', 'subtitle'],
  create_attachment_from_upload: ['issue', 'assetUrl', 'title', 'subtitle'],
};

const NEEDS_CONFIRMATION =
  'Confirm the workspace first: call get_workspace and get_team, then report_linear_workspace.';

/** The workspace and team ids a call names; card 1's `ReportLinearWorkspaceInput` has the same shape. */
interface WorkspaceClaim {
  readonly workspaceId: string;
  readonly teamId: string;
}

export interface ReporterRun {
  readonly linearPrefixes: readonly string[];
  readonly binding: LinearBinding;
  readonly link: ExternalLink;
  /** The task's PR: the only URL a `10db` link may point at. */
  readonly prUrl: string | null;
  workspaceConfirmed: boolean;
  /** From the task's recorded rows, plus this run's. */
  readonly knownCommentIds: Set<string>;
  /** Successful `whoami`, `get_workspace`, `get_team` and `list_teams` result texts. */
  readonly identityResults: string[];
  readonly uploads: { url: string; headers: Record<string, string>; assetUrl: string }[];
  /** Pattern names refused this run. */
  readonly withheld: Set<string>;
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

/** The Linear writes' bodies, checked against the issue this run reports on. */
function judgeWrite(
  run: Readonly<ReporterRun>,
  tool: string,
  input: Record<string, unknown>,
): string | null {
  const issueId = run.link.issueId;
  const keys = Object.keys(input);
  switch (tool) {
    case 'save_issue': {
      if (field(input, 'id') !== issueId) return 'wrong issue';
      if (!keys.every((k) => ['id', 'state', 'links'].includes(k))) return 'unlisted key';
      if (field(input, 'state') !== undefined && typeof field(input, 'state') !== 'string')
        return 'unlisted key';
      if ('links' in input) {
        const links = field(input, 'links');
        const entry = Array.isArray(links) && links.length === 1 ? asRecord(links[0]) : null;
        if (
          entry === null ||
          run.prUrl === null ||
          field(entry, 'title') !== '10db' ||
          field(entry, 'url') !== run.prUrl ||
          Object.keys(entry).some((k) => k !== 'title' && k !== 'url')
        )
          return 'links';
      }
      return null;
    }
    case 'save_comment': {
      if (typeof field(input, 'body') !== 'string') return 'unlisted key';
      const own =
        keys.every((k) => k === 'issueId' || k === 'body') && field(input, 'issueId') === issueId;
      const editId = field(input, 'id');
      const edit =
        keys.every((k) => k === 'id' || k === 'body') &&
        typeof editId === 'string' &&
        run.knownCommentIds.has(editId);
      return own || edit ? null : 'wrong issue';
    }
    case 'prepare_attachment_upload':
    case 'create_attachment_from_upload':
      return field(input, 'issue') === issueId &&
        keys.every((k) => WRITE_KEYS[tool]?.includes(k) === true)
        ? null
        : 'wrong issue';
    default:
      return 'tool';
  }
}

/** Pure: the rule for one call of the reporter. Card 4 applies `withheld` to the run. */
export function judgeReporterCall(
  run: Readonly<ReporterRun>,
  call: { toolName: string; input: unknown },
): { verdict: GuardVerdict; withheld?: string } {
  const { toolName } = call;
  if (toolName.startsWith('mcp__10db__')) {
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
  if (LINEAR_READS.has(tool)) return { verdict: allow() };
  const refusal = `This call is refused: the reporter may only update the linked issue ${run.link.issueId}.`;
  if (!(tool in WRITE_KEYS)) return { verdict: deny(refusal) };
  if (!run.workspaceConfirmed) return { verdict: deny(NEEDS_CONFIRMATION) };
  const input = asRecord(call.input);
  if (input === null || judgeWrite(run, tool, input) !== null) return { verdict: deny(refusal) };
  for (const text of stringsIn(input)) {
    const pattern = scanSecrets(text);
    if (pattern !== null) {
      return {
        verdict: deny(
          `Withheld: the text matches ${pattern}. Record the update as withheld with report_linear_post.`,
        ),
        withheld: pattern,
      };
    }
  }
  return { verdict: allow() };
}

/** Whether the ids the reporter claims are the binding's, and were seen in its own reads. */
export function confirmWorkspace(
  run: Readonly<ReporterRun>,
  input: WorkspaceClaim,
): 'confirmed' | 'not_seen' | 'mismatch' {
  if (input.workspaceId !== run.binding.workspaceId || input.teamId !== run.binding.teamId)
    return 'mismatch';
  const seen = (id: string): boolean => run.identityResults.some((text) => text.includes(id));
  return seen(input.workspaceId) && seen(input.teamId) ? 'confirmed' : 'not_seen';
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
