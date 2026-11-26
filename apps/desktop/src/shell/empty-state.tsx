import { Button, Group, Paper, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import type { Icon } from '@tabler/icons-react';
import type { ReactNode } from 'react';

/** The one thing to do about an empty place; a caller that goes to another page navigates in `onClick`. */
export interface EmptyStateAction {
  readonly label: string;
  readonly icon?: Icon;
  /** `filled` for the page's main step; the default is the quiet one. */
  readonly emphasis?: 'filled' | 'quiet';
  readonly onClick: () => void;
}

/**
 * The one look of a place with nothing to show yet: a dashed box with an icon, a short title, one line on why,
 * and the action that fills it as a real button. An empty place with something to do always says what in its
 * button, never in a link inside a sentence.
 */
export function EmptyState({
  icon: IconMark,
  title,
  children,
  action,
  extra,
}: {
  readonly icon: Icon;
  readonly title: string;
  /** One line on why it is empty. */
  readonly children?: ReactNode;
  readonly action?: EmptyStateAction;
  /** A second step beside the action, for a place with two ways to fill it. */
  readonly extra?: ReactNode;
}) {
  const ActionIcon = action?.icon;
  const left = ActionIcon === undefined ? undefined : <ActionIcon size={16} stroke={1.75} />;
  return (
    <Paper
      radius="md"
      px="xl"
      py={40}
      style={{ border: '1px dashed var(--mantine-color-default-border)' }}
      bg="transparent"
    >
      <Stack align="center" gap="xs" maw={460} mx="auto" ta="center">
        <ThemeIcon variant="light" color="gray" size={40} radius="xl">
          <IconMark size={22} stroke={1.5} />
        </ThemeIcon>
        <Title order={4}>{title}</Title>
        {children === undefined ? null : (
          <Text size="sm" c="dimmed">
            {children}
          </Text>
        )}
        {action === undefined && extra === undefined ? null : (
          <Group mt="xs" gap="sm" justify="center">
            {action === undefined ? null : (
              <Button
                variant={action.emphasis === 'filled' ? 'filled' : 'light'}
                leftSection={left}
                onClick={action.onClick}
              >
                {action.label}
              </Button>
            )}
            {extra}
          </Group>
        )}
      </Stack>
    </Paper>
  );
}
