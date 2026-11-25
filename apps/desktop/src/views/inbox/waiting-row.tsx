import type { InboxItemDto } from '@10db/contracts';
import { Blockquote, Stack, Text } from '@mantine/core';
import { ConversationView } from './conversation-view';
import { SlackText } from './slack-preview';

/** "Mark Ellis", "Mark Ellis + Ana Ortiz": who the question is out with. */
export function recipientsOf(item: InboxItemDto): string {
  return (item.send?.people ?? [])
    .filter((p) => p.recipient)
    .map((p) => p.name)
    .join(' + ');
}

/**
 * The message as sent, quoted so it reads as what they got rather than as 10db talking to the builder,
 * then the conversation since.
 */
export function WaitingDetail({ item }: { readonly item: InboxItemDto }) {
  const send = item.send;
  if (send === null) return null;
  return (
    <Stack gap="sm">
      <Blockquote py="xs" px="md" cite={`What ${recipientsOf(item)} got in Slack`}>
        <Text size="sm" component="div">
          <SlackText text={send.text} />
        </Text>
      </Blockquote>
      <ConversationView send={send} />
    </Stack>
  );
}
