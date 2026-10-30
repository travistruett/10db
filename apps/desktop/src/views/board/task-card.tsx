import {
  TaskStatus,
  type BatchDto,
  type TaskDto,
  type TaskId,
  type WorkstreamDto,
} from '@10db/contracts';
import { Badge, Box, Group, Paper, Stack, Text } from '@mantine/core';
import type { StartNote } from './start-note';
import { taskState, type TaskState } from './task-state';

export interface TaskCardProps {
  readonly task: TaskDto;
  /** The task's workstream while it is active or failed, or finished work that is not shipped yet. */
  readonly workstream: WorkstreamDto | undefined;
  /** The batch the workstream ships in; it says whether finished work was shipped. */
  readonly batch?: BatchDto | undefined;
  /** The project's gate command, named while the task is checked. */
  readonly gateCommand?: string | null | undefined;
  /** Titles and statuses of the project's tasks, for the dependency marker. */
  readonly peers: ReadonlyMap<TaskId, Pick<TaskDto, 'title' | 'status'>>;
  /** The pull request of the batch that shipped a finished task. */
  readonly pullRequest?: string | undefined;
  /** Where the work will land, for a project that delivers by pull request. */
  readonly landing?: string | undefined;
  /** A Start asked for and not yet answered, or refused; it takes the place of the task's own line. */
  readonly startNote?: StartNote | null | undefined;
}

/**
 * A start note as a card line: on its way is blue like a running task, refused is red, and no answer
 * is yellow like a card waiting on the builder in the Inbox.
 */
const NOTE_COLOR = { starting: 'blue', refused: 'red', unanswered: 'yellow' } as const;

function noteState(note: StartNote): TaskState {
  return { line: note.line, color: NOTE_COLOR[note.kind] };
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
  batch?: BatchDto,
  gateCommand: string | null = null,
  landing: string | null = null,
  startNote: StartNote | null = null,
): string {
  const waits = waitsOn(task, peers);
  const criteria = task.acceptanceCriteria.length;
  const state = startNote ? noteState(startNote) : taskState(workstream, batch, gateCommand);
  return [
    task.areas.length > 0 ? `Areas: ${task.areas.join(', ')}.` : null,
    criteria > 0 ? `${String(criteria)} ${criteria === 1 ? 'criterion' : 'criteria'}.` : null,
    waits.length > 0 ? `Waits on ${waits.join(', ')}.` : null,
    landing ? `${landing}.` : null,
    task.status === TaskStatus.Cancelled ? 'Cancelled.' : null,
    state ? `${state.line}.` : null,
  ]
    .filter((part) => part !== null)
    .join(' ');
}

/** A board card: title, areas, unfinished dependencies and, in one line, what the task is doing (spec §10); room for a shipped pull request's link. */
export function TaskCard({
  task,
  workstream,
  batch,
  gateCommand = null,
  peers,
  pullRequest,
  landing,
  startNote = null,
}: TaskCardProps) {
  const waits = waitsOn(task, peers);
  const criteria = task.acceptanceCriteria.length;
  const state = startNote ? noteState(startNote) : taskState(workstream, batch, gateCommand);
  // Queued keeps the plain border; the other states take their DESIGN.md color as a border, thicker
  // when the builder's turn: no fill, no stripe, no animation.
  const colored = state !== null && state.color !== 'gray';
  const waiting = state?.color === 'yellow';
  return (
    <Paper
      withBorder
      radius="md"
      p="sm"
      data-testid="task-card"
      {...(colored ? { 'data-state-color': state.color } : {})}
      style={
        colored
          ? {
              borderColor: `var(--mantine-color-${state.color}-filled)`,
              borderWidth: waiting ? 2 : 1,
            }
          : { borderWidth: 1 }
      }
    >
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
        {landing ? (
          <Text size="xs" c="dimmed" data-testid="landing-line">
            {landing}
          </Text>
        ) : null}
        {state ? (
          <Group gap={6} wrap="nowrap" align="flex-start">
            <Box
              data-testid="state-dot"
              data-color={state.color}
              mt={5}
              w={8}
              h={8}
              style={{
                flex: 'none',
                borderRadius: '50%',
                background: `var(--mantine-color-${state.color}-filled)`,
              }}
            />
            {/* A refusal's reason is shown whole: it is the one thing the builder came to read. */}
            <Text
              size="sm"
              fw={waiting ? 600 : 400}
              {...(startNote?.kind === 'refused' ? {} : { lineClamp: 2 })}
            >
              {state.line}
            </Text>
          </Group>
        ) : null}
        {/* The pull request or Inbox link is laid over this space by the board, outside the card's button. */}
        {pullRequest || startNote?.inbox ? <div style={{ height: 20 }} /> : null}
      </Stack>
    </Paper>
  );
}
