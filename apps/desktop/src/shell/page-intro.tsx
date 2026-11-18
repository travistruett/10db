import { Group, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';

/**
 * What a top-level view shows at the top of its content under the title row: an optional intro of one dim
 * line (13 px, a sentence at most) and an optional row for tabs (left) and filters (right) that the view fills. A row that is absent takes
 * no space, and with both absent nothing is drawn. The byline is cut to one line, so a text byline carries
 * its whole text as a tooltip.
 */
export function PageIntro({
  description,
  toolbar,
}: {
  readonly description?: ReactNode;
  /** The row under the byline: the view lays tabs out left and filters right. */
  readonly toolbar?: ReactNode;
}) {
  if (description === undefined && toolbar === undefined) return null;
  return (
    <Stack gap="xs">
      {description === undefined ? null : (
        <Text
          fz={13}
          c="dimmed"
          lineClamp={1}
          {...(typeof description === 'string' ? { title: description } : {})}
        >
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
