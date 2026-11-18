import type { InboxItemDto } from '@10db/contracts';
import { Stack, Text } from '@mantine/core';
import { useCardContext } from '../../daemon/inbox-queries';

/**
 * The last of a question's task conversation, up to three lines: who said it and what. The text is the
 * agent's or the builder's own, so it is drawn as text only. Nothing shows while it loads, when it fails,
 * or when there is none; a card of any other kind reads nothing.
 */
export function CardContext({ item }: { readonly item: InboxItemDto }) {
  const context = useCardContext(item);
  const messages = context.data?.messages ?? [];
  if (messages.length === 0) return null;
  return (
    <Stack gap={4}>
      <Text size="xs" fw={600} c="dimmed">
        Last messages
      </Text>
      {messages.map((message) => (
        <Text key={`${message.at}:${message.author}:${message.text}`} size="sm" lineClamp={2}>
          {`${message.author === 'builder' ? 'You' : 'Agent'}: ${message.text}`}
        </Text>
      ))}
    </Stack>
  );
}
