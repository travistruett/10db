import { TaskStatus, type TaskDto, type TaskId, type WorkstreamDto } from '@10db/contracts';
import { Badge, Code, Group, Paper, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { StateBadge } from '../factory/state-badge';
import { StepCell } from '../factory/step-cell';
import { PullRequestLink } from './pull-request-link';

export interface TaskCardProps {
  readonly task: TaskDto;
  /** The task's workstream while it is active or failed; a finished one isn't repeated on the card. */
  readonly workstream: WorkstreamDto | undefined;
  /** Titles and statuses of the project's tasks, for the dependency marker. */
  readonly peers: ReadonlyMap<TaskId, Pick<TaskDto, 'title' | 'status'>>;
  readonly menu: ReactNode;
  /** The drag handle. */
  readonly handle?: ReactNode;
  /** The pull request of the batch that shipped a finished task. */
  readonly pullRequest?: string | undefined;
}

/** A board card: title, areas, unfinished dependencies, live workstream state (spec §10) and a shipped pull request. */
export function TaskCard({ task, workstream, peers, menu, handle, pullRequest }: TaskCardProps) {
  const waits = task.dependsOn.flatMap((id) => {
    const peer = peers.get(id);
    return peer && peer.status !== TaskStatus.Done ? [peer.title] : [];
  });
  return (
    <Paper withBorder radius="md" p="xs">
      <Stack gap={4}>
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Group gap={4} wrap="nowrap">
            {handle}
            <Text size="sm" fw={500}>
              {task.title}
            </Text>
          </Group>
          {menu}
        </Group>
        <Group gap={4}>
          {task.areas.map((area) => (
            <Code key={area}>{area}</Code>
          ))}
          {task.status === TaskStatus.Cancelled ? (
            <Badge size="xs" color="gray" variant="light">
              Cancelled
            </Badge>
          ) : null}
        </Group>
        {waits.length > 0 ? (
          <Text size="xs" c="dimmed">{`Waits on ${waits.join(', ')}`}</Text>
        ) : null}
        {workstream ? (
          <Group gap="xs" align="flex-start">
            <StateBadge state={workstream.state} />
            <StepCell workstream={workstream} />
          </Group>
        ) : null}
        {pullRequest ? (
          <Group gap="xs">
            <PullRequestLink url={pullRequest} />
          </Group>
        ) : null}
      </Stack>
    </Paper>
  );
}
