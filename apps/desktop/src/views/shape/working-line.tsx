import { Group, Loader, Text } from '@mantine/core';

export interface WorkingLineProps {
  /** A turn is on its way or running: sent and not yet answered, or between Claude's outputs. */
  readonly working: boolean;
  /** The turn waits on a card in the Inbox, which is not Claude working. */
  readonly waitingForAnswer: boolean;
}

/**
 * One line under the transcript that says what the turn is doing, so the quiet before Claude's
 * first output, and between outputs, is not mistaken for nothing happening. It sits outside the
 * windowed transcript, so a scroll never unmounts it.
 */
export function WorkingLine({ working, waitingForAnswer }: WorkingLineProps) {
  if (!working && !waitingForAnswer) return null;
  return (
    <Group role="status" gap="xs" px="md" pb="xs" wrap="nowrap" style={{ flex: 'none' }}>
      {waitingForAnswer ? null : <Loader size="xs" type="dots" aria-hidden="true" />}
      <Text size="sm" c="dimmed">
        {waitingForAnswer ? 'Waiting for your answer in the Inbox…' : 'Claude is working…'}
      </Text>
    </Group>
  );
}
