import { Group, Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';

/**
 * The header a top-level view shares with the others: the title with the view's actions on the same
 * row, an optional one-line byline under it, and an optional row for tabs (left) and filters (right)
 * that the view fills. A row that is absent takes no space.
 */
export function PageHeader({
  title,
  description,
  actions,
  toolbar,
  titleAside,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  /** Buttons for the title row's right end. */
  readonly actions?: ReactNode;
  /** The row under the byline: the view lays tabs out left and filters right. */
  readonly toolbar?: ReactNode;
  /** A note that sits beside the title, such as a sync status. */
  readonly titleAside?: ReactNode;
}) {
  return (
    <Stack gap="xs">
      <Group justify="space-between" align="center" wrap="nowrap">
        <Group gap="md" align="center" wrap="nowrap" style={{ minWidth: 0 }}>
          <Title order={2}>{title}</Title>
          {titleAside}
        </Group>
        {actions === undefined ? null : (
          <Group gap="sm" wrap="nowrap">
            {actions}
          </Group>
        )}
      </Group>
      {description === undefined ? null : (
        <Text size="sm" c="dimmed" lineClamp={1}>
          {description}
        </Text>
      )}
      {toolbar === undefined ? null : (
        <Group justify="space-between" align="center">
          {toolbar}
        </Group>
      )}
    </Stack>
  );
}
