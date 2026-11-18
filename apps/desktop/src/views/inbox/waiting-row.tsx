import type { InboxItemDto } from '@10db/contracts';
import { Button, Group, Stack, Text } from '@mantine/core';
import { useAnswerInbox } from '../../daemon/queries';
import { cardAnswer } from './card-answer';
import { ConversationView } from './conversation-view';
import { defaultRecording } from './record-decision';

/** "Mark Ellis", "Mark Ellis + Ana Ortiz": who the question is out with. */
export function recipientsOf(item: InboxItemDto): string {
  return (item.send?.people ?? [])
    .filter((p) => p.recipient)
    .map((p) => p.name)
    .join(' + ');
}

/** Who the question is out with, and who else joined in. */
export function WhoCell({ item }: { readonly item: InboxItemDto }) {
  const people = item.send?.people ?? [];
  const others = people.filter((p) => !p.recipient).map((p) => p.name);
  return (
    <Stack gap={0}>
      <Text size="sm" fw={600}>
        {recipientsOf(item)}
      </Text>
      {others.length === 0 ? null : (
        <Text size="xs" c="dimmed">
          {`with ${others.join(', ')}`}
        </Text>
      )}
    </Stack>
  );
}

/** What a Waiting row shows: the message as sent, the conversation since, and the builder's own answers. */
export function WaitingDetail({ item }: { readonly item: InboxItemDto }) {
  const answer = useAnswerInbox();
  const send = item.send;
  if (send === null) return null;
  return (
    <Stack gap="sm" px="md" py="xs">
      <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
        {send.text}
      </Text>
      <ConversationView send={send} />
      <Text size="xs" c="dimmed">
        Answer it yourself:
      </Text>
      <Group gap="xs">
        {item.options.map((option) => (
          <Button
            key={option.label}
            size="xs"
            variant="default"
            aria-label={`Answer Myself: ${option.label}`}
            loading={answer.isPending}
            onClick={() => {
              answer.mutate({
                id: item.id,
                answer: cardAnswer(item, option.label, '', defaultRecording(item)),
              });
            }}
          >
            {option.label}
          </Button>
        ))}
      </Group>
      {answer.isError ? (
        <Text size="xs" c="red">
          {answer.error.message}
        </Text>
      ) : null}
    </Stack>
  );
}
