import type { InboxItemDto } from '@10db/contracts';
import { ActionIcon, Button, Group, Menu, Stack, Text } from '@mantine/core';
import { IconDots } from '@tabler/icons-react';
import { useState } from 'react';
import { useAnswerInbox } from '../../daemon/queries';
import { cardAnswer } from './card-answer';
import { ConversationView } from './conversation-view';
import { ActionsCell } from './inbox-table';
import { defaultRecording } from './record-decision';
import { TakeBackModal } from './take-back-modal';
import { ThreadLink } from './thread-link';

/** "Mark Ellis", "Mark Ellis + Ana Ortiz": who the question is out with, and who else joined in. */
export function WhoCell({ item }: { readonly item: InboxItemDto }) {
  const people = item.send?.people ?? [];
  const recipients = people.filter((p) => p.recipient).map((p) => p.name);
  const others = people.filter((p) => !p.recipient).map((p) => p.name);
  return (
    <Stack gap={0}>
      <Text size="sm" fw={600}>
        {recipients.join(' + ')}
      </Text>
      {others.length === 0 ? null : (
        <Text size="xs" c="dimmed">
          {`with ${others.join(', ')}`}
        </Text>
      )}
    </Stack>
  );
}

/**
 * A row's thread link and its menu: Answer Myself opens the row for its answers, and Take Back asks
 * first, since it posts in the Slack thread.
 */
export function WaitingActions({
  item,
  onAnswerMyself,
}: {
  readonly item: InboxItemDto;
  readonly onAnswerMyself: () => void;
}) {
  const [takingBack, setTakingBack] = useState(false);
  const permalink = item.send?.permalink ?? null;
  return (
    <ActionsCell>
      <Group gap="xs" justify="flex-end" wrap="nowrap">
        {permalink === null ? null : <ThreadLink permalink={permalink} />}
        <Menu position="bottom-end">
          <Menu.Target>
            <ActionIcon variant="subtle" aria-label="More for this question">
              <IconDots size={16} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={onAnswerMyself}>Answer Myself</Menu.Item>
            <Menu.Item
              onClick={() => {
                setTakingBack(true);
              }}
            >
              Take Back
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>
      <TakeBackModal
        item={item}
        opened={takingBack}
        onClose={() => {
          setTakingBack(false);
        }}
      />
    </ActionsCell>
  );
}

/** An open Waiting row: the message as sent, the conversation since, and the builder's own answers. */
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
