import type { StakeholderSendDto } from '@10db/contracts';
import { Stack, Text } from '@mantine/core';

/** The conversation so far, one line per message with its author, and an open proposal. */
export function ConversationView({ send }: { readonly send: StakeholderSendDto }) {
  const recipients = send.people.filter((p) => p.recipient).map((p) => p.name);
  return (
    <Stack gap={4}>
      {send.conversation.map((message) => (
        <Text
          key={message.ts}
          size="sm"
          style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
        >
          {`${message.name}: ${message.text}`}
        </Text>
      ))}
      {send.proposal === null ? null : (
        <Text size="sm" c="dimmed">
          {`Proposed ${send.proposal.choice}, waiting for ${recipients.join(' and ')}'s ✅`}
        </Text>
      )}
    </Stack>
  );
}
