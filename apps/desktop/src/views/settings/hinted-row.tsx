import { Box, Group, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { HelpHint } from './help-hint';

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
        <HelpHint label={label}>{hint}</HelpHint>
      </Group>
      <Box style={{ flex: 'none' }}>{children}</Box>
    </Group>
  );
}
