import {
  MCP_APPROVAL_DETAIL,
  McpApprovalChoice,
  McpServerReview,
  McpTransport,
  McpVerdict,
  type InboxAnswer,
  type InboxItemDto,
  type InboxOption,
  type ProjectId,
} from '@10db/contracts';
import { recordMcpApproval, type WriteContext } from '@10db/db';
import type { InboxService } from './service';

/**
 * Characters that can hide, reorder or add lines to text the builder reads: C0 and C1 controls, the
 * Unicode line and paragraph separators, zero-width and joiner characters, and bidi controls.
 */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const PLAIN_WORD = /^[\w@%+=:,./-]+$/;

const showChar = (c: string): string => `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`;

/** Repo-controlled text with every unsafe character shown as `\u{…}`. Used where the text is not a word. */
const visible = (text: string): string => text.replace(UNSAFE_CHARS, showChar);

/**
 * The one way repo text reaches the card: a word that is plain is shown as is; anything else is quoted,
 * with quotes, backslashes and unsafe characters escaped, so the card shows what the text really holds.
 */
function word(text: string): string {
  if (PLAIN_WORD.test(text)) return text;
  const body = text.replace(/[\\"]/g, (c) => `\\${c}`).replace(UNSAFE_CHARS, showChar);
  return `"${body}"`;
}

const assignment = (entry: { name: string; value: string }): string =>
  `${word(entry.name)}=${word(entry.value)}`;

/** A host as the card names it: a wildcard says what it covers. */
function shownHost(host: string): string {
  if (!host.startsWith('*.')) return word(host);
  const domain = word(host.slice(2));
  return `*.${domain} (every subdomain of ${domain}, not ${domain} itself)`;
}

/** "a", "a and b", "a, b and c". */
function listed(items: readonly string[]): string {
  const last = items.at(-1) ?? '';
  return items.length < 2 ? last : `${items.slice(0, -1).join(', ')} and ${last}`;
}

/** What the sandbox lets a stdio server reach, and where an approved token can go. */
function networkLine(hosts: readonly string[]): string {
  const sandbox =
    'It runs in a sandbox: it reads what lane commands read, writes only its own temp dir and';
  if (hosts.length > 0) {
    return (
      `${sandbox} reaches only ${listed(hosts.map(shownHost))}, never localhost. ` +
      'Whatever it is given, an approved token included, can leave only through those hosts.'
    );
  }
  return (
    `${sandbox} reaches no host, not even localhost. A server that downloads its package when it starts, ` +
    "such as npx -y for a package the repo doesn't install, can't start there unless the repo's " +
    '.10db/mcp-hosts.json names the hosts it needs.'
  );
}

function approvalBody(review: McpServerReview): string {
  const lines = [
    `The repo's .mcp.json declares "${visible(review.name)}" (${review.transport}). Sessions in this project run without it until you approve it.`,
  ];
  if (review.transport === McpTransport.Stdio) {
    lines.push(
      `Runs: ${[...review.env.map(assignment), word(review.command ?? ''), ...review.args.map(word)].join(' ')}`,
    );
    if (review.env.length > 0) lines.push(`Sets: ${review.env.map(assignment).join(', ')}`);
    const replaced = review.env.map((e) => e.name).filter((n) => n === 'PATH' || n === 'HOME');
    lines.push(
      replaced.length > 0
        ? `Its env block replaces ${replaced.join(' and ')}, so what it runs is looked up and started as shown above. Otherwise it gets the variables lane commands get, with no credentials.`
        : 'It gets the variables lane commands get, with no credentials, plus what its env block sets.',
      networkLine(review.hosts),
    );
  } else {
    lines.push(`Connects to: ${word(review.url ?? '')}`);
    if (review.headers.length > 0)
      lines.push(`Sends headers: ${review.headers.map(assignment).join(', ')}`);
  }
  lines.push(
    review.variables.length > 0
      ? `Reads from your environment: ${review.variables.join(', ')}`
      : 'Reads nothing from your environment.',
  );
  if (review.sensitive.length > 0)
    lines.push(`These look like credentials: ${review.sensitive.join(', ')}`);
  lines.push(
    review.transport === McpTransport.Stdio && review.hosts.length > 0
      ? 'The approval covers this exact config and these hosts. Any change to either asks again.'
      : 'The approval covers this exact config. Any change to it asks again.',
  );
  return lines.join('\n');
}

function approvalOptions(review: McpServerReview): InboxOption[] {
  const vars =
    review.variables.length > 0
      ? `, expanding ${review.variables.join(', ')} from your environment`
      : '';
  return [
    { label: McpApprovalChoice.Approve, description: `Run it in this project's sessions${vars}` },
    {
      label: McpApprovalChoice.Deny,
      description: "Leave it out of this project's sessions until its config changes",
    },
  ];
}

/**
 * Raises the approval card for one exact config, or returns the open one. The card is project-wide, so
 * no workstream's end cancels it; it folds per server and config hash, so retries add nothing.
 */
export function requestMcpApproval(
  inbox: InboxService,
  projectId: ProjectId,
  review: McpServerReview,
): InboxItemDto {
  return inbox.flag({
    projectId,
    workstreamId: null,
    title: `Run the repo's MCP server "${visible(review.name)}"?`,
    body: approvalBody(review),
    options: approvalOptions(review),
    detail: { [MCP_APPROVAL_DETAIL]: review },
    foldKey: `project-mcp-approval:${projectId}:${review.name}:${review.configHash}`,
  });
}

/** In the answer's own transaction: the builder's verdict on that exact config. Other flags are left alone. */
export function applyMcpApproval(ctx: WriteContext, item: InboxItemDto, answer: InboxAnswer): void {
  const review = McpServerReview.safeParse(item.detail?.[MCP_APPROVAL_DETAIL]);
  if (!review.success) return;
  const approve = answer.choice === McpApprovalChoice.Approve;
  recordMcpApproval(ctx, {
    projectId: item.projectId,
    serverName: review.data.name,
    configHash: review.data.configHash,
    verdict: approve ? McpVerdict.Approved : McpVerdict.Denied,
    variables: approve ? review.data.variables : [],
    hosts: approve ? review.data.hosts : [],
    sourceInboxId: item.id,
  });
}
