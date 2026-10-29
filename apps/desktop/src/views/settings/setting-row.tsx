import { Box, Divider, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { Children, Fragment, type ReactNode } from 'react';

/** A titled card of settings rows, with a hairline between rows. */
export function SettingsCard({
  title,
  children,
}: {
  readonly title?: string;
  readonly children: ReactNode;
}) {
  // Rows hidden by a condition render as null; Children.toArray drops them, so no divider doubles up.
  const rows = Children.toArray(children);
  return (
    <Stack gap="xs">
      {title ? <Title order={5}>{title}</Title> : null}
      <Paper withBorder radius="md">
        {rows.map((row, i) => (
          <Fragment key={i}>
            {i > 0 ? <Divider /> : null}
            {row}
          </Fragment>
        ))}
      </Paper>
    </Stack>
  );
}

export interface SettingRowProps {
  readonly label: string;
  /** One line on what the setting does, in the builder's words. */
  readonly description?: ReactNode;
  /** The control; it carries the label for assistive tech (`aria-label`). */
  readonly children: ReactNode;
  /** A control too wide for the right column, such as a list, goes under the text instead. */
  readonly stacked?: boolean;
}

/** One setting: its name and one line on the left, its control on the right. */
export function SettingRow({ label, description, children, stacked = false }: SettingRowProps) {
  const text = (
    <Box flex={1} miw={0}>
      <Text size="sm" fw={500}>
        {label}
      </Text>
      {description ? (
        <Text size="xs" c="dimmed">
          {description}
        </Text>
      ) : null}
    </Box>
  );
  return (
    <Box px="md" py="sm">
      {stacked ? (
        <Stack gap="xs">
          {text}
          {children}
        </Stack>
      ) : (
        <Group justify="space-between" wrap="nowrap" gap="xl">
          {text}
          <Box w={260} style={{ flex: 'none' }}>
            {children}
          </Box>
        </Group>
      )}
    </Box>
  );
}
