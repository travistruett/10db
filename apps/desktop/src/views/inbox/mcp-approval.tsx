import {
  MCP_APPROVAL_DETAIL,
  McpApprovalChoice,
  McpServerReview,
  McpTransport,
  type InboxItemDto,
} from '@10db/contracts';
import { Alert, Code, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';

/** The server under review when `item` is an MCP approval card, else null. */
export function mcpReview(item: InboxItemDto): McpServerReview | null {
  const parsed = McpServerReview.safeParse(item.detail?.[MCP_APPROVAL_DETAIL]);
  return parsed.success ? parsed.data : null;
}

/** The words for an approval card's two stable choices. */
export const MCP_APPROVAL_LABELS: Readonly<Record<string, string>> = {
  [McpApprovalChoice.Approve]: 'Approve for this project',
  [McpApprovalChoice.Deny]: 'Deny',
};

/**
 * What approving would run or contact. The daemon builds `body` with every repo-controlled string
 * escaped; it is shown as text, never re-derived from the raw review fields.
 */
export function McpApprovalDetails({
  review,
  body,
}: {
  readonly review: McpServerReview;
  readonly body: string;
}) {
  const reads = review.variables.length > 0 ? review.variables.join('\n') : 'Nothing';
  return (
    <Stack gap="xs">
      <Listing label="What approving runs">{body}</Listing>
      <Listing label="Reads these variables from your environment">{reads}</Listing>
      {review.transport === McpTransport.Stdio ? (
        <Listing label="Reaches these hosts">
          {review.hosts.length > 0 ? review.hosts.join('\n') : 'No host'}
        </Listing>
      ) : null}
      {review.sensitive.length > 0 ? (
        <Alert color="yellow" title="These look like credentials">
          {`Approving passes ${review.sensitive.join(', ')} to this server.`}
        </Alert>
      ) : null}
    </Stack>
  );
}

function Listing({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {children}
      </Code>
    </div>
  );
}
