import { Button, Group, Text } from '@mantine/core';

// Sessions UI spec §7.3: a chat's message that chose to wait for Your folder. It runs when the folder frees;
// Send Now Reading Only runs it at once, changing nothing, and Stop drops it.

export interface FolderWaitProps {
  /** The holders, as a sentence part: "the task ‘Bump vite’". */
  readonly holders: string;
  readonly onSendNow: () => void;
  readonly onStop: () => void;
}

export function FolderWait({ holders, onSendNow, onStop }: FolderWaitProps) {
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
        Waits for Your folder: in use by {holders}
      </Text>
      <Group gap="xs" wrap="nowrap" style={{ flex: 'none' }}>
        <Button size="xs" variant="default" onClick={onSendNow}>
          Send Now Reading Only
        </Button>
        <Button size="xs" variant="subtle" onClick={onStop}>
          Stop
        </Button>
      </Group>
    </Group>
  );
}
