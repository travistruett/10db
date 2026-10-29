import { Box, Button, Group, Paper, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconX } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import type { SetupMark, SetupRow } from './claude-row';

const MARK_LABEL: Readonly<Record<SetupMark, string>> = {
  ok: 'Ready',
  warn: 'Needs attention',
  bad: 'Problem',
  pending: 'Checking',
};

function Mark({ mark }: { readonly mark: SetupMark }) {
  const icon =
    mark === 'ok' ? (
      <IconCheck size={16} stroke={1.5} />
    ) : mark === 'warn' ? (
      <IconAlertTriangle size={16} stroke={1.5} />
    ) : mark === 'bad' ? (
      <IconX size={16} stroke={1.5} />
    ) : null;
  const color =
    mark === 'ok' ? 'green' : mark === 'warn' ? 'yellow' : mark === 'bad' ? 'red' : 'gray';
  return (
    <ThemeIcon
      color={color}
      variant="light"
      radius="xl"
      size="md"
      role="img"
      aria-label={MARK_LABEL[mark]}
    >
      {icon}
    </ThemeIcon>
  );
}

/** A titled card of the setup check: a heading with its one Recheck, then one row per item. */
export function SetupSection({
  title,
  onRecheck,
  rechecking,
  children,
}: {
  readonly title: string;
  readonly onRecheck: () => void;
  readonly rechecking: boolean;
  readonly children: ReactNode;
}) {
  const headingId = `setup-${title.toLowerCase()}`;
  return (
    <Paper component="section" aria-labelledby={headingId} withBorder p="lg" radius="md">
      <Group justify="space-between" mb="md">
        <Title order={4} id={headingId}>
          {title}
        </Title>
        <Button size="xs" variant="default" loading={rechecking} onClick={onRecheck}>
          Recheck
        </Button>
      </Group>
      <Stack gap="lg">{children}</Stack>
    </Paper>
  );
}

/** One item of a card: its mark, its name, one dimmed line, and any actions under it. */
export function SetupItem({
  name,
  row,
  children,
}: {
  readonly name: string;
  readonly row: SetupRow;
  readonly children?: ReactNode;
}) {
  return (
    <Group wrap="nowrap" align="flex-start">
      <Mark mark={row.mark} />
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Text size="sm" fw={500}>
          {name}
        </Text>
        <Text size="sm" c="dimmed">
          {row.detail}
        </Text>
        {children}
      </Box>
    </Group>
  );
}
