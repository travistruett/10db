import { ActionIcon, Box, Group, HoverCard, Text } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import type { ReactNode } from 'react';

/** A small info icon that opens the longer help for a label on hover or focus. */
export function InfoHint({
  label,
  children,
}: {
  /** What the help is about, for assistive tech. */
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <HoverCard width={320} withArrow shadow="md" openDelay={150}>
      <HoverCard.Target>
        <ActionIcon variant="subtle" color="gray" size="sm" aria-label={`About ${label}`}>
          <IconInfoCircle size={14} stroke={1.5} />
        </ActionIcon>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <Text size="sm">{children}</Text>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

/** One setting on a line: its label with an info icon on the left, its control on the right. */
export function HintedRow({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Group justify="space-between" wrap="nowrap" gap="xl" px="md" py="sm">
      <Group gap={4} wrap="nowrap">
        <Text size="sm" fw={500} style={{ whiteSpace: 'nowrap' }}>
          {label}
        </Text>
        <InfoHint label={label}>{hint}</InfoHint>
      </Group>
      <Box style={{ flex: 'none' }}>{children}</Box>
    </Group>
  );
}
