import { Badge, Group, Paper, Stack, Text, Tooltip, VisuallyHidden } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import type { ReactNode } from 'react';

export interface BoardColumnProps {
  readonly label: string;
  readonly count: number;
  /** System columns follow task state; the builder can't rename or delete them. */
  readonly locked: boolean;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}

/** One column: a titled list whose items are task cards. */
export function BoardColumn({ label, count, locked, children, footer }: BoardColumnProps) {
  return (
    <Paper withBorder radius="md" p="xs" miw={220}>
      <Stack gap="xs">
        <Group justify="space-between">
          <Group gap={4}>
            <Text fw={600} size="sm">
              {label}
            </Text>
            {locked ? (
              <Tooltip label="Follows the task's state">
                <span>
                  <IconLock size={14} stroke={1.5} aria-hidden="true" />
                  <VisuallyHidden>Follows the task's state</VisuallyHidden>
                </span>
              </Tooltip>
            ) : null}
          </Group>
          <Badge size="sm" variant="light" color="gray">
            {count}
          </Badge>
        </Group>
        <Stack
          component="ul"
          gap="xs"
          m={0}
          p={0}
          style={{ listStyle: 'none' }}
          aria-label={`${label} tasks`}
        >
          {children}
        </Stack>
        {footer}
      </Stack>
    </Paper>
  );
}
