import { Group, Paper, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { useFocusTarget } from '../focus-target';

/**
 * One outside service in Settings › Integrations, in four parts: the service's mark and name with its state
 * and identity beside them, what 10db uses it for, its actions, and what stops without it. A link with
 * `?focus=<focusName>` lands on the card.
 */
export function IntegrationCard({
  mark,
  name,
  status,
  purpose,
  withoutIt,
  focusName,
  children,
}: {
  readonly mark: ReactNode;
  readonly name: string;
  /** The state and identity: a `ConnectionStatus`, or dimmed words while the state is still being read. */
  readonly status: ReactNode;
  readonly purpose: string;
  readonly withoutIt: string;
  readonly focusName: string;
  /** The actions: connect, replace, remove. */
  readonly children?: ReactNode;
}) {
  const { ref } = useFocusTarget(focusName);
  return (
    <Paper ref={ref} withBorder radius="md" p="md" aria-label={name} role="group">
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Group gap="sm" wrap="nowrap">
            {mark}
            <Text fw={600}>{name}</Text>
          </Group>
          {status}
        </Group>
        <Text size="sm">{purpose}</Text>
        {children}
        <Text size="xs" c="dimmed">
          {`Without it: ${withoutIt}`}
        </Text>
      </Stack>
    </Paper>
  );
}
