import { TaskStatus, type TaskDto, type TaskId, type WorkstreamDto } from '@10db/contracts';
import { Badge, Group, Paper, Stack, Text } from '@mantine/core';
import { StateBadge } from '../factory/state-badge';
import { STATE_LABELS } from '../factory/workstream-state';
import { StepCell } from '../factory/step-cell';

/** The status line of a finished task with no gate: only the builder's Approve completes it. */
const READY_TO_CHECK = 'Ready for you to check';

export interface TaskCardProps {
  readonly task: TaskDto;
  /** The task's workstream while it is active or failed; a finished one isn't repeated on the card. */
  readonly workstream: WorkstreamDto | undefined;
  /** Titles and statuses of the project's tasks, for the dependency marker. */
  readonly peers: ReadonlyMap<TaskId, Pick<TaskDto, 'title' | 'status'>>;
  /** The pull request of the batch that shipped a finished task. */
  readonly pullRequest?: string | undefined;
}

function waitsOn(task: TaskDto, peers: TaskCardProps['peers']): string[] {
  return task.dependsOn.flatMap((id) => {
    const peer = peers.get(id);
    return peer && peer.status !== TaskStatus.Done ? [peer.title] : [];
  });
}

/** What the card shows besides its title, as a sentence a screen reader can speak. */
export function cardSummary(
  task: TaskDto,
  workstream: WorkstreamDto | undefined,
  peers: TaskCardProps['peers'],
): string {
  const waits = waitsOn(task, peers);
  const criteria = task.acceptanceCriteria.length;
  return [
    task.areas.length > 0 ? `Areas: ${task.areas.join(', ')}.` : null,
    criteria > 0 ? `${String(criteria)} ${criteria === 1 ? 'criterion' : 'criteria'}.` : null,
    waits.length > 0 ? `Waits on ${waits.join(', ')}.` : null,
    task.status === TaskStatus.Cancelled ? 'Cancelled.' : null,
    workstream ? `Workstream ${STATE_LABELS[workstream.state]}.` : null,
    workstream?.nextAction.kind === 'builder_review' ? `${READY_TO_CHECK}.` : null,
  ]
    .filter((part) => part !== null)
    .join(' ');
}

/** A board card: title, areas, unfinished dependencies, live workstream state (spec §10) and room for a shipped pull request's link. */
export function TaskCard({ task, workstream, peers, pullRequest }: TaskCardProps) {
  const waits = waitsOn(task, peers);
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
            {workstream.nextAction.kind === 'builder_review' ? (
              <Text size="sm">{READY_TO_CHECK}</Text>
            ) : (
              <StepCell workstream={workstream} />
            )}
          </Group>
        ) : null}
        {/* The pull request link is laid over this space by the board, outside the card's button. */}
        {pullRequest ? <div style={{ height: 20 }} /> : null}
      </Stack>
    </Paper>
  );
}
