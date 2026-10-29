import { TaskStatus, type TaskDto, type TaskId, type WorkstreamDto } from '@10db/contracts';
import { Badge, Group, Paper, Stack, Text } from '@mantine/core';
import { StateBadge } from '../factory/state-badge';
import { StepCell } from '../factory/step-cell';
import { PullRequestLink } from './pull-request-link';

export interface TaskCardProps {
  readonly task: TaskDto;
  /** The task's workstream while it is active or failed; a finished one isn't repeated on the card. */
  readonly workstream: WorkstreamDto | undefined;
  /** Titles and statuses of the project's tasks, for the dependency marker. */
  readonly peers: ReadonlyMap<TaskId, Pick<TaskDto, 'title' | 'status'>>;
  /** The pull request of the batch that shipped a finished task. */
  readonly pullRequest?: string | undefined;
}

/** A board card: title, areas, unfinished dependencies, live workstream state (spec §10) and a shipped pull request. */
export function TaskCard({ task, workstream, peers, pullRequest }: TaskCardProps) {
  const waits = task.dependsOn.flatMap((id) => {
    const peer = peers.get(id);
    return peer && peer.status !== TaskStatus.Done ? [peer.title] : [];
  });
  const criteria = task.acceptanceCriteria.length;
  return (
    <Paper withBorder radius="md" p="sm">
      <Stack gap="xs">
        {/* The card's menu sits over the top-right corner, outside this element; the title leaves room. */}
        <Text size="sm" fw={500} pr={28}>
          {task.title}
        </Text>
        <Group gap={6}>
          {task.areas.map((area) => (
            <Badge key={area} size="sm" variant="light" color="gray" tt="none" fw={500}>
              {area}
            </Badge>
          ))}
          {criteria > 0 ? (
            <Text
              size="xs"
              c="dimmed"
            >{`${String(criteria)} ${criteria === 1 ? 'criterion' : 'criteria'}`}</Text>
          ) : null}
          {task.status === TaskStatus.Cancelled ? (
            <Badge size="sm" color="gray" variant="light">
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
