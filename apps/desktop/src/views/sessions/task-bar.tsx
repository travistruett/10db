import { Box, Button, Group, Stack, Text, type ButtonProps } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { TaskId } from '@10db/contracts';
import { CodeSpans } from '../../shell/code-spans';

// Sessions UI §4, §8.4: a task's session bar: its title over "Task · where it works", and its actions.

export interface TaskBarProps {
  readonly title: string;
  /** "Task · Separate copy · `10db/retry-401`" or "Task · Your folder · lands on `main`". */
  readonly kindLine: string;
  readonly taskId: TaskId;
  /** The bar's own actions, left of Open on Board. */
  readonly actions?: ReactNode;
}

/** The common look of the bar's buttons. */
export const TASK_BAR_BUTTON: ButtonProps = { variant: 'default', size: 'xs' };

export function TaskBar({ title, kindLine, taskId, actions }: TaskBarProps) {
  return (
    <Box style={{ flex: 'none' }}>
      <Group h={44} px="md" justify="space-between" wrap="nowrap" gap="sm">
        <Stack gap={0} style={{ minWidth: 0 }}>
          <Text fw={600} size="sm" lineClamp={1}>
            {title}
          </Text>
          <Text size="xs" c="dimmed" lineClamp={1}>
            <CodeSpans text={kindLine} />
          </Text>
        </Stack>
        <Group gap="sm" wrap="nowrap" style={{ flex: 'none' }}>
          {actions}
          <Button
            {...TASK_BAR_BUTTON}
            renderRoot={(props) => <Link {...props} to="/board" search={{ task: taskId }} />}
          >
            Open on Board
          </Button>
        </Group>
      </Group>
    </Box>
  );
}
