import type { InboxItemDto } from '@10db/contracts';
import { Button, Group, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { useNow } from '../../shell/relative';
import { shortAgo } from '../factory/short-ago';
import { TakeBackModal } from './take-back-modal';
import { recipientsOf, WaitingDetail } from './waiting-row';
import { WaitingTaskLink } from './waiting-task-link';

/**
 * The content for a Waiting row: who the question is out with and since when, the task it holds up, the
 * message and the builder's own answers, and Withdraw Question, which asks first since it posts in the Slack thread. There is no link to
 * the thread: it is @10db's direct message with them, which the builder can't open.
 */
export function WaitingContent({ item }: { readonly item: InboxItemDto }) {
  const now = useNow();
  const [takingBack, setTakingBack] = useState(false);
  const send = item.send;
  const others = (send?.people ?? []).filter((p) => !p.recipient).map((p) => p.name);
  return (
    <Stack gap="sm">
      <Text fw={600}>{item.title}</Text>
      <Text size="sm" c="dimmed">
        {[
          `Asked ${recipientsOf(item)}`,
          others.length === 0 ? null : `with ${others.join(', ')}`,
          send?.sentAt == null ? null : shortAgo(send.sentAt, now),
          send?.remindedAt == null ? null : `reminded ${shortAgo(send.remindedAt, now)}`,
        ]
          .filter((part) => part !== null)
          .join(' · ')}
      </Text>
      <WaitingTaskLink item={item} />
      <WaitingDetail item={item} />
      <Group gap="sm">
        <Button
          size="xs"
          variant="subtle"
          color="gray"
          onClick={() => {
            setTakingBack(true);
          }}
        >
          Withdraw Question
        </Button>
      </Group>
      <TakeBackModal
        item={item}
        opened={takingBack}
        onClose={() => {
          setTakingBack(false);
        }}
      />
    </Stack>
  );
}
