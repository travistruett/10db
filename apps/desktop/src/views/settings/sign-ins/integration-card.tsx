import { Group, Paper, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { useFocusTarget } from '../focus-target';

/**
 * One outside service on Settings › Integrations: the service's mark and name on the left, at most one control
 * on the right (a ⋯ menu, a button), then its one dim state line and whatever the service needs under it. A link
 * with `?focus=<focusName>` lands on the card.
 */
export function IntegrationCard({
  mark,
  name,
  control,
  focusName,
  children,
}: {
  readonly mark: ReactNode;
  readonly name: string;
  readonly control?: ReactNode;
  readonly focusName: string;
  /** The state line, then anything the card needs under it. */
  readonly children?: ReactNode;
}) {
  const { ref } = useFocusTarget<HTMLDivElement>(focusName);
  return (
    <Paper ref={ref} withBorder radius="md" p="md" aria-label={name} role="group">
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap" mih={30}>
          <Group gap="sm" wrap="nowrap">
            {mark}
            <Text fw={600}>{name}</Text>
          </Group>
          {control}
        </Group>
        {children}
      </Stack>
    </Paper>
  );
}

/** The card's one state line. */
export function StateText({ children }: { readonly children: ReactNode }) {
  return (
    <Text size="sm" c="dimmed">
      {children}
    </Text>
  );
}
