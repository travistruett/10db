import type { ExternalLink, LinearPostId } from '@10db/contracts';
import { Provider } from '@10db/contracts';
import type { GuardVerdict } from '../guard';
import { mcpToolPrefix } from '../sessions';
import { OUTBOUND_PATTERNS, SECRET_PATTERN_NAMES } from '../stakeholders';
import type { ReporterPicture } from './reporter-pictures';

/** The claude.ai connector's prefix, used whenever the connector list is unread. */
const CONNECTOR_PREFIX = 'mcp__claude_ai_Linear__';

const REPORT_TOOLS: ReadonlySet<string> = new Set(['mcp__10db__report_linear_post']);
/** The upload tool, allowed only in a run that was offered pictures. */
const UPLOAD_TOOL = 'mcp__10db__upload_linear_picture';

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
  prepare_file_upload: ['filename', 'contentType', 'size'],
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
  /** The task's PR: the only URL a `10db` link may point at. */
  readonly prUrl: string | null;
  /** The pictures the brief offered this run; the only files it may upload. */
  readonly pictures: readonly ReporterPicture[];
  /** Pattern names refused this run. */
  readonly withheld: Set<string>;
  /** Per owed update, the comment 10db built from the agent's body: the only comment text the run may write. */
  readonly comments: Map<LinearPostId, StagedComment>;
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

/** What a write that passed names: the post whose comment it carries, when it is a comment. */
interface WriteJudged {
  readonly wrote?: LinearPostId;
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
      `${tool} takes only ${allowed.join(', ')}; it was given ${extra.join(', ')} too. Send exactly the arguments report_linear_post returned.`,
    );
  switch (tool) {
    case 'save_issue': {
      if (field(input, 'id') !== issueId)
        return refuse(`id must be the linked issue's Linear id ${issueId}.`);
      const state = field(input, 'state');
      if (state !== undefined && typeof state !== 'string')
        return refuse('state must be the status name, a string.');
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
          return refuse(
            `links may hold one link, titled 10db, to the task's pull request${run.prUrl === null ? ' (it has none yet)' : ` ${run.prUrl}`}.`,
          );
      }
      return {};
    }
    case 'save_comment': {
      const given = field(input, 'issueId');
      if (given !== issueId)
        return refuse(
          given === run.link.id
            ? `issueId must be the issue's Linear id ${issueId}, not its key ${run.link.id}.`
            : `issueId must be the linked issue's Linear id ${issueId}; this run writes to that issue only.`,
        );
      const body = field(input, 'body');
      if (typeof body !== 'string') return refuse('body must be a string.');
      const staged = [...run.comments].find(([, comment]) => comment.text === body);
      if (staged === undefined)
        return refuse(
          'body is not a comment 10db built. Call report_linear_post with the post id and your comment body, then pass the arguments it returns to save_comment unchanged.',
        );
      if (staged[1].written)
        return refuse(`the comment for ${staged[0]} was already written; do not write it again.`);
      return { wrote: staged[0] };
    }
    case 'prepare_file_upload':
      // A signed URL alone sends nothing: only 10db's upload tool sends a file, and only an offered picture.
      return run.pictures.length > 0 && field(input, 'contentType') === 'image/png'
        ? {}
        : refuse(
            'prepare uploads only for the PNG pictures the brief lists (contentType image/png).',
          );
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

/** Pure: the rule for one call of the reporter. The caller applies `withheld` to the run. */
export function judgeReporterCall(
  run: Readonly<ReporterRun>,
  call: { toolName: string; input: unknown },
): { verdict: GuardVerdict; withheld?: string; wrote?: LinearPostId } {
  const { toolName } = call;
  if (toolName.startsWith('mcp__10db__')) {
    if (run.readOnly) return { verdict: deny('A snapshot run may only read Linear.') };
    if (toolName === UPLOAD_TOOL) {
      const input = asRecord(call.input);
      const id = input === null ? undefined : field(input, 'pictureId');
      return {
        verdict: run.pictures.some((p) => p.id === id)
          ? allow()
          : deny('Upload only a picture your brief lists, by its id.'),
      };
    }
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
        `This call is refused: ${tool} is not a tool this run may call; it only updates the linked issue ${run.link.issueId}.`,
      ),
    };
  const input = asRecord(call.input);
  if (input === null)
    return { verdict: deny('This call is refused: the arguments must be an object.') };
  const judged = judgeWrite(run, tool, allowed, input);
  if ('refusal' in judged) return { verdict: deny(judged.refusal) };
  if (secret !== null) {
    return {
      verdict: deny(`Withheld: the text matches ${secret}; nothing is written.`),
      withheld: secret,
    };
  }
  return judged.wrote === undefined
    ? { verdict: allow() }
    : { verdict: allow(), wrote: judged.wrote };
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
