import type { WorkstreamDto } from '@10db/contracts';
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
import { useRetryWorkstream } from '../../daemon/queries';
import { failureLine } from '../board/task-state';
import { ContextGauge } from './context-gauge';
import { RelativeTime } from './relative-time';
import { StateBadge } from './state-badge';
import { StepCell } from './step-cell';
import { canRetry } from './workstream-state';

export interface GoalSessionsProps {
  /** The goal's workstreams, one per task (its latest run). */
  readonly workstreams: readonly WorkstreamDto[];
  readonly loading: boolean;
  readonly error: string | null;
}

/**
 * A goal's sessions: its workstreams, each with Retry when it failed. A run is cancelled from its
 * task's card menu or drawer on the Board, not from every row here.
 */
export function GoalSessions({ workstreams, loading, error }: GoalSessionsProps) {
  const retry = useRetryWorkstream();

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
<<<<<<< 0880e9b3126edc6fa11b2c0e7d65235a95d158d5
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
              <Table.Tr key={ws.id}>
                <Table.Td>
                  <Text size="sm">{ws.taskTitle}</Text>
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
                        {failureLine(ws)}
                      </Text>
                    </Tooltip>
                  ) : null}
                </Table.Td>
                <Table.Td>
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
                    {canRetry(ws.state) ? (
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
||||||| 4186559
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
              <Table.Tr key={ws.id}>
                <Table.Td>
                  <Text size="sm">{ws.taskTitle}</Text>
                  {ws.failureReason ? (
                    <Text size="xs" c="red">
                      {ws.failureReason}
                    </Text>
                  ) : null}
                </Table.Td>
                <Table.Td>
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
                    {canRetry(ws.state) ? (
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
=======
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
>>>>>>> c06b12c9a5dd98bd707981d7e2bc3df65365bf2e
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {workstreams.map((ws) => (
                <Table.Tr key={ws.id}>
                  <Table.Td style={{ minWidth: '12rem', overflowWrap: 'anywhere' }}>
                    <Text size="sm">{ws.taskTitle}</Text>
                    {ws.failureReason ? (
                      <Text size="xs" c="red">
                        {ws.failureReason}
                      </Text>
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
                      {canRetry(ws.state) ? (
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
