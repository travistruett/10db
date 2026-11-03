import type { GoalId } from '@10db/contracts';
import { Alert, Badge, Box, Group, Loader, Stack, Text, Tooltip } from '@mantine/core';
import { Link, useNavigate } from '@tanstack/react-router';
import { PullRequestLink } from '../board/pull-request-link';
import { ContextGauge } from './context-gauge';
import { RelativeTime } from './relative-time';
import { StatusDot } from './status-dot';
import type { TaskRow } from './task-rows';

/** The Board link of a task: its drawer, and its goal as the filter. */
function boardSearch(row: TaskRow, goalId: GoalId) {
  return { task: row.taskId, goal: goalId };
}

export interface GoalTasksProps {
  readonly goalId: GoalId;
  readonly rows: readonly TaskRow[];
  readonly loading: boolean;
  readonly error: string | null;
}

/**
 * The goal's tasks as one list. Each row is a state dot, the headline, its state, a pull request
 * link and the last activity; only a running row adds its step, model and context. A row opens the
 * task's drawer on the Board. A failed run is retried from Needs you, and a run is cancelled from its
 * card or drawer, so a row has no buttons of its own.
 */
export function GoalTasks({ goalId, rows, loading, error }: GoalTasksProps) {
  const navigate = useNavigate();
  return (
    <Stack gap={4}>
      <Text size="xs" c="dimmed" fw={600} tt="uppercase">
        Tasks
      </Text>
      {error ? (
        <Alert color="red" title="Couldn't load the tasks">
          {error}
        </Alert>
      ) : null}
      {loading ? <Loader size="sm" aria-label="Loading tasks" /> : null}
      {!loading && error === null && rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          This goal has no tasks yet.
        </Text>
      ) : null}
      {rows.length > 0 ? (
        <Stack gap={2} role="list" aria-label="Tasks">
          {rows.map((row) => (
            <Group
              key={row.taskId}
              role="listitem"
              gap="sm"
              wrap="nowrap"
              py={4}
              style={{ cursor: 'pointer' }}
              onClick={(event) => {
                // The task's link and the pull request link act on their own.
                if (event.target instanceof Element && event.target.closest('a, button')) return;
                void navigate({ to: '/board', search: boardSearch(row, goalId) });
              }}
            >
              <StatusDot color={row.color} />
              <Text size="sm" style={{ flex: 1, minWidth: 0 }} lineClamp={1}>
                <Link to="/board" search={boardSearch(row, goalId)}>
                  {row.label}
                </Link>
              </Text>
              <Group gap="sm" wrap="nowrap" style={{ flex: 'none' }}>
                <Tooltip label={row.detail} disabled={!row.detail} withArrow multiline maw={360}>
                  <Text size="sm" c={row.color === 'red' ? 'red' : 'dimmed'}>
                    {row.state}
                  </Text>
                </Tooltip>
                {row.running ? <ContextGauge pct={row.running.contextPct} /> : null}
                {row.shared ? (
                  <Badge size="sm" variant="light" color="gray" tt="none" fw={500}>
                    Shared branch
                  </Badge>
                ) : null}
                {row.prUrl ? <PullRequestLink url={row.prUrl} /> : null}
                <Box w={88} ta="right" c="dimmed">
                  {row.activity === null ? null : <RelativeTime at={row.activity} />}
                </Box>
              </Group>
            </Group>
          ))}
        </Stack>
      ) : null}
    </Stack>
  );
}
