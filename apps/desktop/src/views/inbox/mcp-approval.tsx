import {
  MCP_APPROVAL_DETAIL,
  McpApprovalChoice,
  McpServerReview,
  type InboxItemDto,
} from '@10db/contracts';
import { Alert, Code, Stack, Text } from '@mantine/core';

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
      <div>
        <Text size="xs" c="dimmed">
          What approving runs
        </Text>
        <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {body}
        </Code>
      </div>
      <div>
        <Text size="xs" c="dimmed">
          Reads these variables from your environment
        </Text>
        <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {reads}
        </Code>
      </div>
      {review.sensitive.length > 0 ? (
        <Alert color="yellow" title="These look like credentials">
          {`Approving passes ${review.sensitive.join(', ')} to this server.`}
        </Alert>
      ) : null}
    </Stack>
  );
}
