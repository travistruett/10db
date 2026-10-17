import { Group, Paper, Text } from '@mantine/core';
import { IconPlugConnectedX } from '@tabler/icons-react';
import { absoluteTime, fromNow, useNow } from './relative';

/** Shown above the current view while the daemon is unreachable; the view stays usable for reading. */
export function ReconnectingBanner({ since }: { readonly since: number }) {
  const now = useNow();
  return (
    <Paper role="status" withBorder p="xs" mb="md" bg="var(--mantine-color-yellow-light)">
      <Group gap="xs">
        <IconPlugConnectedX size={16} stroke={1.5} aria-hidden />
        <Text size="sm" title={absoluteTime(since)}>
          Reconnecting to the daemon… Work keeps running. Lost the connection {fromNow(since, now)}.
        </Text>
      </Group>
    </Paper>
  );
}
