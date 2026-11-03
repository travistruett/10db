import type { BatchDto, GoalId, TaskDto, TaskId, WorkstreamDto } from '@10db/contracts';
import {
  Alert,
  Button,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core';
import { Link, useNavigate } from '@tanstack/react-router';
import { useRetryWorkstream } from '../../daemon/queries';
import { canRetryRun, failureLine } from '../board/task-state';
import { ContextGauge } from './context-gauge';
import { RelativeTime } from './relative-time';
import { StateBadge } from './state-badge';
import { StepCell } from './step-cell';
import { canRetry } from './workstream-state';

/** The Board link of a task: its drawer, and its goal as the filter when it has one. */
function boardSearch(ws: WorkstreamDto, goalId: GoalId | null): { task: TaskId; goal?: GoalId } {
  return goalId === null ? { task: ws.taskId } : { task: ws.taskId, goal: goalId };
}

export interface GoalSessionsProps {
  /** The goal these sessions belong to; null for tasks not in a goal, which open the Board unfiltered. */
  readonly goalId: GoalId | null;
  /** The goal's workstreams, one per task (its latest run). */
  readonly workstreams: readonly WorkstreamDto[];
  /** The project's tasks and batches, which say whether `retryWorkstream` would accept a retry. */
  readonly tasks: readonly TaskDto[];
  readonly batches: readonly BatchDto[];
  readonly loading: boolean;
  readonly error: string | null;
}

/**
 * A goal's sessions: its workstreams, each failed one with what happened, and with what Retry will do
 * and its Retry button only when `retryWorkstream` would accept it. A run is cancelled from its
 * task's card menu or drawer on the Board, not from every row here.
 */
export function GoalSessions({
  goalId,
  workstreams,
  tasks,
  batches,
  loading,
  error,
}: GoalSessionsProps) {
  const retry = useRetryWorkstream();
  const navigate = useNavigate();

  // A task that has not loaded yet is not known to be retryable, so it promises nothing.
  function retryable(ws: WorkstreamDto): boolean {
    const task = tasks.find((t) => t.id === ws.taskId);
    return (
      task !== undefined &&
      canRetryRun(
        task,
        ws,
        batches.find((b) => b.id === ws.batchId),
      )
    );
  }

  function openOnBoard(ws: WorkstreamDto): void {
    void navigate({ to: '/board', search: boardSearch(ws, goalId) });
  }

  return (
    <Stack gap="xs">
      <Title order={3} size="h5">
        Sessions
      </Title>
      {error ? (
        <Alert color="red" title="Couldn't load the sessions">
          {error}
        </Alert>
      ) : null}
      {retry.error ? (
        <Alert color="red" title="The daemon refused that">
          {retry.error.message}
        </Alert>
      ) : null}
      {loading ? <Loader size="sm" aria-label="Loading sessions" /> : null}
      {!loading && error === null && workstreams.length === 0 ? (
        <Text size="sm" c="dimmed">
          No task has run yet.
        </Text>
      ) : null}
      {workstreams.length > 0 ? (
        <Table.ScrollContainer minWidth={640}>
          <Table verticalSpacing="xs" aria-label="Sessions">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Task</Table.Th>
                <Table.Th>State</Table.Th>
                <Table.Th>Step</Table.Th>
                <Table.Th>Context</Table.Th>
                <Table.Th>Sessions</Table.Th>
                <Table.Th>Last activity</Table.Th>
                <Table.Th>
                  <VisuallyHidden>Actions</VisuallyHidden>
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {workstreams.map((ws) => (
                <Table.Tr
                  key={ws.id}
                  style={{ cursor: 'pointer' }}
                  onClick={(event) => {
                    // The task's link and Retry act on their own; the rest of the row opens the task.
                    if (event.target instanceof Element && event.target.closest('a, button')) {
                      return;
                    }
                    openOnBoard(ws);
                  }}
                >
                  <Table.Td style={{ minWidth: '12rem', overflowWrap: 'anywhere' }}>
                    <Text size="sm" component="span">
                      <Link to="/board" search={boardSearch(ws, goalId)}>
                        {ws.taskHeadline || ws.taskTitle}
                      </Link>
                    </Text>
                    {canRetry(ws.state) ? (
                      <Tooltip
                        label={ws.failureReason}
                        disabled={!ws.failureReason}
                        withArrow
                        multiline
                        maw={360}
                        openDelay={300}
                      >
                        <Text size="xs" c="red">
                          {failureLine(ws, retryable(ws))}
                        </Text>
                      </Tooltip>
                    ) : null}
                  </Table.Td>
                  <Table.Td style={{ whiteSpace: 'nowrap' }}>
                    <StateBadge state={ws.state} />
                  </Table.Td>
                  <Table.Td>
                    <StepCell workstream={ws} />
                  </Table.Td>
                  <Table.Td>
                    <ContextGauge pct={ws.contextPct} />
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{ws.sessionCount}</Text>
                  </Table.Td>
                  <Table.Td>
                    <RelativeTime at={ws.lastActivityAt} />
                  </Table.Td>
                  <Table.Td>
                    <Group gap="xs" justify="flex-end" wrap="nowrap">
                      {retryable(ws) ? (
                        <Button
                          size="xs"
                          variant="light"
                          loading={retry.isPending && retry.variables.id === ws.id}
                          onClick={() => {
                            retry.mutate({ id: ws.id });
                          }}
                        >
                          Retry
                        </Button>
                      ) : null}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : null}
    </Stack>
  );
}
