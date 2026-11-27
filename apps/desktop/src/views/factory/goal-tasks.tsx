import { Alert, Badge, Box, Group, Skeleton, Stack, Text, Tooltip } from '@mantine/core';
import { Link, useNavigate } from '@tanstack/react-router';
import { useLoadingDelayElapsed } from '../../shell/page-loading';
import { PullRequestLink } from '../board/pull-request-link';
import { ContextGauge } from './context-gauge';
import { RelativeTime } from './relative-time';
import { StatusDot } from './status-dot';
import type { TaskRow } from './task-rows';

/** A task's link: its drawer over Factory, with the page's own filters kept. */
function drawerSearch(row: TaskRow) {
  return <T extends object>(prev: T) => ({ ...prev, task: row.taskId });
}

export interface GoalTasksProps {
  readonly rows: readonly TaskRow[];
  readonly loading: boolean;
  readonly error: string | null;
}

/** The width of a row's last-activity column. */
const ACTIVITY_WIDTH = 88;

/** The task rows while they load: a state dot, a title, a state and a time on each, as the rows have. */
function TaskRowsLoading() {
  const late = useLoadingDelayElapsed();
  if (!late) return null;
  return (
    <Stack gap={2} role="status" aria-label="Loading tasks">
      {[0, 1, 2].map((i) => (
        <Group key={i} gap="sm" wrap="nowrap" py={4}>
          <Skeleton height={8} width={8} circle style={{ flex: 'none' }} />
          <Box style={{ flex: 1 }}>
            <Skeleton height={14} width={`${String(55 - i * 10)}%`} />
          </Box>
          <Skeleton height={12} width={64} style={{ flex: 'none' }} />
          <Skeleton height={12} width={ACTIVITY_WIDTH} style={{ flex: 'none' }} />
        </Group>
      ))}
    </Stack>
  );
}

/**
 * The goal's tasks as one list. Each row is a state dot, the title, its state, a pull request
 * link and the last activity; only a running row adds its step, model and context. A row opens the
 * task's drawer over Factory. A failed run is retried from Needs you, and a run is cancelled from its
 * card or drawer, so a row has no buttons of its own.
 */
export function GoalTasks({ rows, loading, error }: GoalTasksProps) {
  const navigate = useNavigate({ from: '/factory' });
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
      {loading ? <TaskRowsLoading /> : null}
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
                void navigate({ search: drawerSearch(row) });
              }}
            >
              <StatusDot color={row.color} />
              <Text size="sm" style={{ flex: 1, minWidth: 0 }} lineClamp={1}>
                <Link from="/factory" to="/factory" search={drawerSearch(row)}>
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
                    Shared Branch
                  </Badge>
                ) : null}
                {row.prUrl ? <PullRequestLink url={row.prUrl} /> : null}
                <Box w={ACTIVITY_WIDTH} ta="right" c="dimmed">
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
