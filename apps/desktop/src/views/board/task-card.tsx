import {
  areaLabel,
  BoardStatus,
  TaskStatus,
  type BatchDto,
  type TaskDto,
  type TaskId,
  type WorkstreamDto,
} from '@10db/contracts';
import { Box, Group, Paper, Stack, Text, Tooltip } from '@mantine/core';
import { ciResult } from './ci-line';
import { IndicatorRow, type Indicator } from './indicator-row';
import type { StartNote } from './start-note';
import { reviewSentBackLine, shippedAtLimitLine, taskState, type TaskState } from './task-state';

export interface TaskCardProps {
  readonly task: TaskDto;
  /** The task's workstream while it is active or failed, or finished work that is not shipped yet. */
  readonly workstream: WorkstreamDto | undefined;
  /** The batch the workstream ships in; it says whether finished work was shipped. */
  readonly batch?: BatchDto | undefined;
  /** Every batch of the project: a CI fix batch finds the root that holds the required checks. */
  readonly batches?: readonly BatchDto[] | undefined;
  /** The project's gate command, named while the task is checked. */
  readonly gateCommand?: string | null | undefined;
  /** Titles and statuses of the project's tasks, for the dependency marker. */
  readonly peers: ReadonlyMap<TaskId, Pick<TaskDto, 'title' | 'status' | 'boardStatus'>>;
  /** A Start asked for and not yet answered, or refused; it takes the place of the task's own line. */
  readonly startNote?: StartNote | null | undefined;
  /** A queued task's place in line, counting from 1. */
  readonly place?: number | undefined;
  /** The title of the goal the task belongs to, shown as a short badge; none under a Goal filter. */
  readonly goalTitle?: string | undefined;
}

/**
 * A start note as a card line: on its way is blue like a running task, refused is red, and no answer
 * is yellow like a card waiting on the builder in the Inbox.
 */
const NOTE_COLOR = { starting: 'blue', refused: 'red', unanswered: 'yellow' } as const;

function noteState(note: StartNote): TaskState {
  return { line: note.line, color: NOTE_COLOR[note.kind] };
}

/**
 * The dependencies the task waits on before it can start, by the daemon's rule: one is finished once it
 * is done, even with its pull request still open, or once a run shipped anyway has merged (in Done).
 * The daemon holds the task's batch at cut time until the pull requests merge.
 */
function waitsOn(task: TaskDto, peers: TaskCardProps['peers']): string[] {
  return task.dependsOn.flatMap((id) => {
    const peer = peers.get(id);
    const finished = peer?.status === TaskStatus.Done || peer?.boardStatus === BoardStatus.Done;
    return peer && !finished ? [peer.title] : [];
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
  place?: number,
  batches?: readonly BatchDto[],
  placement: string | null = null,
  sharedWith = 1,
): string {
  const waits = waitsOn(task, peers);
  const criteria = task.acceptanceCriteria.length;
  const state = startNote
    ? noteState(startNote)
    : taskState(workstream, batch, gateCommand, place, batches, task);
  const sentBack = reviewSentBackLine(workstream);
  const atLimit = shippedAtLimitLine(workstream);
  return [
    task.areas.length > 0
      ? `Areas: ${task.areas.map((area) => areaLabel(area, [])).join(', ')}.`
      : null,
    criteria > 0 ? `${String(criteria)} ${criteria === 1 ? 'criterion' : 'criteria'}.` : null,
    placement ? `Runs in ${placement}.` : null,
    batch?.passId != null ? 'A page open in the UI Workbench.' : null,
    sharedWith > 1
      ? `Shares its branch with ${String(sharedWith - 1)} other ${sharedWith === 2 ? 'task' : 'tasks'}.`
      : null,
    waits.length > 0 ? `Waits on ${waits.join(', ')}.` : null,
    landing ? `${landing}.` : null,
    task.status === TaskStatus.Cancelled ? 'Cancelled.' : null,
    state ? (state.line.endsWith('.') ? state.line : `${state.line}.`) : null,
    state?.detail ? `Reason: ${state.detail.replace(/\.$/, '')}.` : null,
    sentBack ? `${sentBack}.` : null,
    atLimit ? `${atLimit}.` : null,
  ]
    .filter((part) => part !== null)
    .join(' ');
}

/** The state colors whose line the card shows: waiting on the builder, failed or paused (spec §5). */
const LINE_COLORS: ReadonlySet<string> = new Set(['yellow', 'red', 'orange']);

/** The goal badge's longest label, ellipsis included; the tooltip carries the whole title. */
const GOAL_BADGE_LENGTH = 18;

function shortGoalTitle(title: string): string {
  const chars = Array.from(title);
  return chars.length <= GOAL_BADGE_LENGTH
    ? title
    : `${chars
        .slice(0, GOAL_BADGE_LENGTH - 1)
        .join('')
        .trimEnd()}…`;
}

/**
 * The card's indicators, in the order they show: the goal it serves, then only what says where it stands
 * (it waits on another task, its CI failed, it was cancelled). Rigor, kinds, a passing CI, a shared branch
 * and the Workbench are the drawer's to say.
 */
function indicatorsOf(
  task: TaskDto,
  peers: TaskCardProps['peers'],
  batch: BatchDto | undefined,
  batches: readonly BatchDto[],
  goalTitle: string | undefined,
): Indicator[] {
  const waits = waitsOn(task, peers);
  const ci = ciResult(batch, batches);
  return [
    goalTitle
      ? {
          kind: 'goal',
          label: shortGoalTitle(goalTitle),
          color: 'gray',
          tooltip: goalTitle,
        }
      : null,
    ci === 'failed' ? { kind: 'ci', label: 'CI failed', color: 'red' } : null,
    waits.length > 0
      ? { kind: 'waits-on', label: 'Waits On', color: 'gray', tooltip: waits.join(', ') }
      : null,
    task.status === TaskStatus.Cancelled
      ? { kind: 'cancelled', label: 'Cancelled', color: 'gray' }
      : null,
  ].filter((indicator) => indicator !== null);
}

/**
 * A board card: what (the title), why, and where it stands: a status line only when the task needs the
 * builder or has failed, then the indicator row (its goal, and what holds it up).
 * Everything else about the task is in its drawer; `cardSummary` still speaks it.
 */
export function TaskCard({
  task,
  workstream,
  batch,
  batches = [],
  gateCommand = null,
  peers,
  startNote = null,
  place,
  goalTitle,
}: TaskCardProps) {
  const state = startNote
    ? noteState(startNote)
    : taskState(workstream, batch, gateCommand, place, batches, task);
  // The border takes the state's DESIGN.md color whatever the line says, thicker when it is the builder's
  // turn: no fill, no stripe, no animation. Queued keeps the plain border, and so does a done task: its
  // column says it, and a column of green borders would be the Board's loudest.
  const colored =
    state !== null &&
    state.color !== 'gray' &&
    state.plainBorder !== true &&
    task.status !== TaskStatus.Done;
  const waiting = colored && state.color === 'yellow';
  const line = state !== null && LINE_COLORS.has(state.color) ? state : null;
  const indicators = indicatorsOf(task, peers, batch, batches, goalTitle);
  return (
    <Paper
      withBorder
      radius="md"
      p="sm"
      shadow="xs"
      bg="var(--tendb-color-card)"
      data-testid="task-card"
      data-keeps-drawer
      {...(colored ? { 'data-state-color': state.color } : {})}
      style={
        colored
          ? {
              borderColor: `var(--mantine-color-${state.color}-filled)`,
              borderWidth: waiting ? 2 : 1,
            }
          : // A queued card's border is its own fill: the tone lifts it off the column, not a line.
            { borderColor: 'var(--tendb-color-card)', borderWidth: 1 }
      }
    >
      <Stack gap="xs">
        {/* The card's menu sits over the top-right corner, outside this element. */}
        <Text size="sm" fw={500} pr={28} lineClamp={3}>
          {task.title}
        </Text>
        {task.why ? (
          <Text size="xs" c="dimmed" lineClamp={2} data-testid="task-card-why">
            {task.why}
          </Text>
        ) : null}
        {line ? (
          <Group gap={6} wrap="nowrap" align="flex-start">
            <Box
              data-testid="state-dot"
              data-color={line.color}
              mt={5}
              w={8}
              h={8}
              style={{
                flex: 'none',
                borderRadius: '50%',
                background: `var(--mantine-color-${line.color}-filled)`,
              }}
            />
            {/* A refusal's reason and a failure's line are shown whole: each is the one thing the builder came to read. */}
            <Tooltip
              label={line.detail}
              disabled={!line.detail}
              withArrow
              multiline
              maw={360}
              openDelay={300}
            >
              <Text
                size="sm"
                fw={waiting ? 600 : 400}
                {...(startNote?.kind === 'refused' || line.detail !== undefined
                  ? {}
                  : { lineClamp: 2 })}
              >
                {line.line}
              </Text>
            </Tooltip>
          </Group>
        ) : null}
        <IndicatorRow indicators={indicators} />
        {/* The Inbox link and the tracker link are laid over this space by the board, outside the card's button. */}
        {startNote?.inbox || task.external != null ? <div style={{ height: 20 }} /> : null}
      </Stack>
    </Paper>
  );
}
