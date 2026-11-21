import { Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';

/** A menu item's name with a dimmed line under it saying what it does. */
export function MenuHint({
  hint,
  children,
}: {
  readonly hint: string;
  readonly children: ReactNode;
}) {
  return (
    <Stack gap={0}>
      <Text size="sm">{children}</Text>
      <Text size="xs" c="dimmed" maw={260}>
        {hint}
      </Text>
    </Stack>
  );
}
