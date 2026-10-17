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

/** A shell-like rendering of one word, quoted only when it needs to be. Text only, never run. */
const shellWord = (word: string): string =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : JSON.stringify(word);

function approvalBody(review: McpServerReview): string {
  const lines = [
    `The repo's .mcp.json declares "${review.name}" (${review.transport}). Sessions in this project run without it until you approve it.`,
  ];
  if (review.transport === McpTransport.Stdio) {
    lines.push(`Runs: ${[review.command ?? '', ...review.args].map(shellWord).join(' ')}`);
    if (review.envNames.length > 0) lines.push(`Sets: ${review.envNames.join(', ')}`);
    lines.push(
      'It gets PATH and HOME, plus what its env block sets, and nothing else from your environment.',
    );
  } else {
    lines.push(`Connects to: ${review.url ?? ''}`);
    if (review.headerNames.length > 0)
      lines.push(`Sends headers: ${review.headerNames.join(', ')}`);
  }
  lines.push(
    review.variables.length > 0
      ? `Reads from your environment: ${review.variables.join(', ')}`
      : 'Reads nothing from your environment.',
  );
  if (review.sensitive.length > 0)
    lines.push(`These look like credentials: ${review.sensitive.join(', ')}`);
  lines.push('The approval covers this exact config. Any change to it asks again.');
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
    title: `Run the repo's MCP server "${review.name}"?`,
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
    sourceInboxId: item.id,
  });
}
