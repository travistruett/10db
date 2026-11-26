import { Box, Group, Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';
import { HelpHint } from './help-hint';

/**
 * The one layout for a title with a dimmed line under it and an action at the right: the text takes the
 * room and wraps, the action keeps its full width, and a fixed gap sits between them.
 */
export function HeadingRow({
  heading,
  line,
  action,
  align = 'flex-start',
}: {
  readonly heading: ReactNode;
  readonly line?: string | undefined;
  readonly action?: ReactNode;
  readonly align?: 'flex-start' | 'flex-end';
}) {
  return (
    <Group justify="space-between" align={align} wrap="nowrap" gap="md">
      <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
        {heading}
        {line === undefined ? null : (
          <Text size="xs" c="dimmed">
            {line}
          </Text>
        )}
      </Stack>
      {action === undefined ? null : <Box style={{ flexShrink: 0 }}>{action}</Box>}
    </Group>
  );
}

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
    <HeadingRow
      line={line}
      action={action}
      heading={
        <Group gap={4} wrap="nowrap">
          <Title order={4} size="md" fw={600}>
            {title}
          </Title>
          {help === undefined ? null : <HelpHint label={title}>{help}</HelpHint>}
        </Group>
      }
    />
  );
}
