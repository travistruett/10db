import { Group, Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';
import { HelpHint } from './help-hint';

/**
 * A section's heading: its title with an optional info button whose card holds the longer explanation, one
 * short dimmed line under it, and the section's one primary action at the right.
 */
export function SectionHeading({
  title,
  line,
  help,
  action,
}: {
  readonly title: string;
  /** One short line under the title. */
  readonly line?: string;
  /** The longer explanation, in a card opened from an info button beside the title. */
  readonly help?: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <Group justify="space-between" align="flex-start" wrap="nowrap">
      <Stack gap={2}>
        <Group gap={4} wrap="nowrap">
          <Title order={4} size="md" fw={600}>
            {title}
          </Title>
          {help === undefined ? null : <HelpHint label={title}>{help}</HelpHint>}
        </Group>
        {line === undefined ? null : (
          <Text size="xs" c="dimmed">
            {line}
          </Text>
        )}
      </Stack>
      {action}
    </Group>
  );
}
