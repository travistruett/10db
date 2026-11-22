import type { ExternalLink, LinearBinding, ReportLinearWorkspaceInput } from '@10db/contracts';
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
  save_comment: ['issueId', 'body'],
  prepare_attachment_upload: ['issue', 'filename', 'contentType', 'size', 'title', 'subtitle'],
  create_attachment_from_upload: ['issue', 'assetUrl', 'title', 'subtitle'],
};

const NEEDS_CONFIRMATION =
  'Confirm the workspace first: call get_workspace and get_team, then report_linear_workspace.';

export interface ReporterRun {
  readonly linearPrefixes: readonly string[];
  readonly binding: LinearBinding;
  readonly link: ExternalLink;
  /** The task's PR: the only URL a `10db` link may point at. */
  readonly prUrl: string | null;
  workspaceConfirmed: boolean;
  /** Successful `whoami`, `get_workspace`, `get_team` and `list_teams` results, by tool. */
  readonly identityResults: { tool: string; text: string }[];
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

/** Why a write is not the one this run may make, or null. Every key must be in the tool's list. */
function judgeWrite(
  run: Readonly<ReporterRun>,
  tool: string,
  allowed: readonly string[],
  input: Record<string, unknown>,
): string | null {
  const issueId = run.link.issueId;
  if (!Object.keys(input).every((k) => allowed.includes(k))) return 'unlisted key';
  switch (tool) {
    case 'save_issue': {
      if (field(input, 'id') !== issueId) return 'wrong issue';
      const state = field(input, 'state');
      if (state !== undefined && typeof state !== 'string') return 'unlisted key';
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
    case 'save_comment':
      return typeof field(input, 'body') === 'string' && field(input, 'issueId') === issueId
        ? null
        : 'wrong issue';
    default:
      return field(input, 'issue') === issueId ? null : 'wrong issue';
  }
}

/** The first secret pattern any string in a call's input hits. */
function secretIn(input: unknown): string | null {
  for (const text of stringsIn(input)) {
    const pattern = scanSecrets(text);
    if (pattern !== null) return pattern;
  }
  return null;
}

/** Pure: the rule for one call of the reporter. The caller applies `withheld` to the run. */
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
  const secret = secretIn(call.input);
  if (LINEAR_READS.has(tool)) {
    return {
      verdict:
        secret === null
          ? allow()
          : deny(`The call carries text that matches ${secret}; it is refused.`),
    };
  }
  const refusal = `This call is refused: the reporter may only update the linked issue ${run.link.issueId}.`;
  const allowed = Object.hasOwn(WRITE_KEYS, tool) ? WRITE_KEYS[tool] : undefined;
  if (allowed === undefined) return { verdict: deny(refusal) };
  if (!run.workspaceConfirmed) return { verdict: deny(NEEDS_CONFIRMATION) };
  const input = asRecord(call.input);
  if (input === null || judgeWrite(run, tool, allowed, input) !== null)
    return { verdict: deny(refusal) };
  if (secret !== null) {
    return {
      verdict: deny(
        `Withheld: the text matches ${secret}. Record the update as withheld with report_linear_post.`,
      ),
      withheld: secret,
    };
  }
  return { verdict: allow() };
}

/** Whether `id` appears in `text` as a whole id, not inside a longer token. */
function hasId(text: string, id: string): boolean {
  let at = text.indexOf(id);
  while (at !== -1) {
    const before = text[at - 1];
    const after = text[at + id.length];
    if (
      (before === undefined || !/[A-Za-z0-9-]/.test(before)) &&
      (after === undefined || !/[A-Za-z0-9-]/.test(after))
    )
      return true;
    at = text.indexOf(id, at + 1);
  }
  return false;
}

/** Whether the ids the reporter claims are the binding's, and were seen in its own reads. */
export function confirmWorkspace(
  run: Readonly<ReporterRun>,
  input: ReportLinearWorkspaceInput,
): 'confirmed' | 'not_seen' | 'mismatch' {
  if (input.workspaceId !== run.binding.workspaceId || input.teamId !== run.binding.teamId)
    return 'mismatch';
  const seen = (tools: readonly string[], id: string): boolean =>
    run.identityResults.some((r) => tools.includes(r.tool) && hasId(r.text, id));
  return seen(['whoami', 'get_workspace'], input.workspaceId) &&
    seen(['get_team', 'list_teams'], input.teamId)
    ? 'confirmed'
    : 'not_seen';
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
