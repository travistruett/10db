import { Button, Group, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';

/**
 * What the content says when the list holds no row: the state's own words, or "No matches" with a way back
 * once a search or a filter narrows it.
 */
export function InboxEmpty({
  empty,
  narrowed,
  onClear,
}: {
  /** The state's words for an empty list. */
  readonly empty: string;
  readonly narrowed: boolean;
  readonly onClear: () => void;
}): ReactNode {
  if (!narrowed) return <Text c="dimmed">{empty}</Text>;
  return (
    <Stack gap="xs" align="flex-start">
      <Text c="dimmed">No matches</Text>
      <Group>
        <Button size="xs" variant="default" onClick={onClear}>
          Clear Filters
        </Button>
      </Group>
    </Stack>
  );
}
