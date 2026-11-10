import type { InboxItemId } from '@10db/contracts';
import { Button, Group, Text } from '@mantine/core';
import { useRetryTurn } from '../../daemon/pass-queries';

export interface RetryTurnProps {
  /** The failed turn's flag, which Retry Turn answers. */
  readonly itemId: InboxItemId;
  /** What happened and what Retry Turn does. */
  readonly line: string;
}

/** A failed page's line at the foot of its thread, with Retry Turn, which sends the last message again. */
export function RetryTurn({ itemId, line }: RetryTurnProps) {
  const retry = useRetryTurn();
  return (
    <Group gap="sm" px="md" py="xs" wrap="nowrap" align="center">
      <Text size="sm" c="red" style={{ flex: 1, minWidth: 0 }}>
        {retry.error?.message ?? line}
      </Text>
      <Button
        variant="default"
        loading={retry.isPending}
        onClick={() => {
          retry.mutate(itemId);
        }}
      >
        Retry Turn
      </Button>
    </Group>
  );
}
