import type { InboxItemDto } from '@10db/contracts';
import { Button, Group, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { useNow } from '../../shell/relative';
import { shortAgo } from '../factory/short-ago';
import { TakeBackModal } from './take-back-modal';
import { ThreadLink } from './thread-link';
import { WaitingDetail, WhoCell } from './waiting-row';

/**
 * The content for a Waiting row: who the question is out with and since when, the message and the builder's
 * own answers, and Take It Back, which asks first since it posts in the Slack thread.
 */
export function WaitingContent({ item }: { readonly item: InboxItemDto }) {
  const now = useNow();
  const [takingBack, setTakingBack] = useState(false);
  const send = item.send;
  return (
    <Stack gap="sm">
      <Text fw={600}>{item.title}</Text>
      <Group gap="lg" align="flex-start">
        <WhoCell item={item} />
        <Stack gap={0}>
          {send?.sentAt == null ? null : (
            <Text size="sm" c="dimmed">{`sent ${shortAgo(send.sentAt, now)}`}</Text>
          )}
          {send?.remindedAt == null ? null : (
            <Text size="xs" c="dimmed">{`reminded ${shortAgo(send.remindedAt, now)}`}</Text>
          )}
        </Stack>
      </Group>
      <WaitingDetail item={item} />
      <Group gap="sm">
        <Button
          size="xs"
          variant="default"
          onClick={() => {
            setTakingBack(true);
          }}
        >
          Take It Back
        </Button>
        {send?.permalink == null ? null : <ThreadLink permalink={send.permalink} />}
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
