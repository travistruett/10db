import { Button, Group, Text } from '@mantine/core';

// A chat's message that waits for a holder of the checkout. It runs when the holder is done; Stop drops it.

export interface FolderWaitProps {
  /** Who is changing files, as a sentence part ("the task ‘Bump vite’"); null when nothing is still in the way. */
  readonly holders: string | null;
  /** The branch the checkout is on. */
  readonly branch: string | null;
  readonly onStop: () => void;
}

export function FolderWait({ holders, branch, onStop }: FolderWaitProps) {
  return (
    <Group
      role="status"
      gap="xs"
      px="md"
      py="xs"
      justify="space-between"
      wrap="nowrap"
      style={{ flex: 'none' }}
    >
      <Text size="sm" c="dimmed" lineClamp={2}>
        {holders === null
          ? 'Your message runs once the checkout is free.'
          : `${holders.charAt(0).toUpperCase()}${holders.slice(1)} is changing files${branch === null ? '' : ` on ${branch}`}. Your message runs once it’s done.`}
      </Text>
      <Button size="xs" variant="subtle" onClick={onStop} style={{ flex: 'none' }}>
        Stop
      </Button>
    </Group>
  );
}
