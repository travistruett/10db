import {
  BoardStatus,
  Rigor,
  TaskStatus,
  type BatchDto,
  type TaskDto,
  type TaskId,
  type WorkstreamDto,
} from '@10db/contracts';
import { Box, Group, Paper, Stack, Text, Tooltip } from '@mantine/core';
import { ciResult } from './ci-line';
import { RIGOR_LABEL } from './rigor-labels';
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
  /** How many tasks share the task's batch (`batchTaskCount`); more than one shows the shared-branch indicator. */
  readonly batchTaskCount?: number | undefined;
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

/** A kind's key as a title: "db-migration" is "Db Migration". */
function kindTitle(key: string): string {
  return key
    .split('-')
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(' ');
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
    task.areas.length > 0 ? `Areas: ${task.areas.join(', ')}.` : null,
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
 * The card's indicators, in the order they show (readable board spec §4). Each kind is derived from data
 * the card already has; a later kind is one more entry here.
 */
function indicatorsOf(
  task: TaskDto,
  peers: TaskCardProps['peers'],
  batch: BatchDto | undefined,
  batches: readonly BatchDto[],
  sharedWith: number,
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
    batch?.passId != null
      ? {
          kind: 'workbench',
          label: 'UI Workbench',
          color: 'gray',
          tooltip: 'A page open in the UI Workbench, worked on there',
        }
      : null,
    sharedWith > 1
      ? {
          kind: 'shared-branch',
          label: 'Shared branch',
          color: 'gray',
          tooltip: `${String(sharedWith)} tasks share this branch`,
        }
      : null,
    ci
      ? {
          kind: 'ci',
          label: ci === 'passed' ? 'CI passed' : 'CI failed',
          color: ci === 'passed' ? 'green' : 'red',
        }
      : null,
    waits.length > 0
      ? { kind: 'waits-on', label: 'Waits on', color: 'gray', tooltip: waits.join(', ') }
      : null,
    task.status === TaskStatus.Cancelled
      ? { kind: 'cancelled', label: 'Cancelled', color: 'gray' }
      : null,
    // The default rigor is the baseline every card has; one the builder set, or a kind raised, is worth saying.
    task.rigor !== null || task.effectiveRigor !== Rigor.Standard
      ? {
          kind: 'rigor',
          label: RIGOR_LABEL[task.effectiveRigor],
          color: 'gray',
          tooltip:
            task.rigor === null
              ? 'Rigor, from the project and the task’s kinds'
              : 'Rigor the builder set',
        }
      : null,
    ...task.kinds.map((k) => ({
      kind: `kind-${k.key}`,
      label: kindTitle(k.key),
      color: 'gray',
      tooltip: k.source === 'builder' ? 'Kind set by the builder' : 'Kind an agent gave the task',
    })),
  ].filter((indicator) => indicator !== null);
}

/**
 * A board card (readable board spec §5): the headline (the title when there is none), the why, a
 * status line only when the task needs the builder or has failed, then the indicator row, which
 * starts with the goal's badge.
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
  batchTaskCount = 1,
}: TaskCardProps) {
  const state = startNote
    ? noteState(startNote)
    : taskState(workstream, batch, gateCommand, place, batches, task);
  // The border takes the state's DESIGN.md color whatever the line says, thicker when it is the builder's
  // turn: no fill, no stripe, no animation. Queued keeps the plain border.
  const colored = state !== null && state.color !== 'gray' && state.plainBorder !== true;
  const waiting = colored && state.color === 'yellow';
  const line = state !== null && LINE_COLORS.has(state.color) ? state : null;
  const indicators = indicatorsOf(task, peers, batch, batches, batchTaskCount, goalTitle);
  return (
    <Paper
      withBorder
      radius="md"
      p="sm"
      shadow="xs"
      bg="var(--tendb-color-card)"
      data-testid="task-card"
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
        {/* The card's menu sits over the top-right corner, outside this element; the headline leaves room. */}
        <Text size="sm" fw={500} pr={28} lineClamp={3}>
          {task.headline || task.title}
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
        {/* The Inbox link is laid over this space by the board, outside the card's button. */}
        {startNote?.inbox ? <div style={{ height: 20 }} /> : null}
      </Stack>
    </Paper>
  );
}
