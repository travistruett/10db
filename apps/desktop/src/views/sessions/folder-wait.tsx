import { Button, Group, Text } from '@mantine/core';

// A chat's message that waits for a holder of the checkout. It runs when the holder is done; Stop drops it.

export interface FolderWaitProps {
  /** Who is changing files, each as a sentence part ("the task ‘Bump vite’"); empty when nothing is in the way. */
  readonly holders: readonly string[];
  /** The branch the checkout is on. */
  readonly branch: string | null;
  readonly onStop: () => void;
}

function andJoin(parts: readonly string[]): string {
  if (parts.length < 3) return parts.join(' and ');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1) ?? ''}`;
}

export function FolderWait({ holders, branch, onStop }: FolderWaitProps) {
  const who = andJoin(holders);
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
        {holders.length === 0
          ? 'Your message runs once the checkout is free.'
          : `${who.charAt(0).toUpperCase()}${who.slice(1)} ${holders.length === 1 ? 'is' : 'are'} changing files${branch === null ? '' : ` on ${branch}`}. Your message runs once ${holders.length === 1 ? 'it’s' : 'they’re'} done.`}
      </Text>
      <Button size="xs" variant="subtle" onClick={onStop} style={{ flex: 'none' }}>
        Stop
      </Button>
    </Group>
  );
}
