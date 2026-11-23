import { ActionIcon, Group, HoverCard, Stack, Text, Title } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import type { ReactNode } from 'react';

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
          {help === undefined ? null : (
            <HoverCard width={360} shadow="md" position="bottom-start" withArrow>
              <HoverCard.Target>
                <ActionIcon
                  type="button"
                  variant="subtle"
                  color="gray"
                  size="sm"
                  aria-label={`About ${title.toLowerCase()}`}
                >
                  <IconInfoCircle size={14} aria-hidden />
                </ActionIcon>
              </HoverCard.Target>
              <HoverCard.Dropdown>
                <Text size="sm">{help}</Text>
              </HoverCard.Dropdown>
            </HoverCard>
          )}
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
