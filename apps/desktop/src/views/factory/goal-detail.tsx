import type { GoalSummaryDto, WorkstreamDto, WorkstreamId } from '@10db/contracts';
import { Button, Divider, Group, Stack, Text } from '@mantine/core';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useBatches, useTasks, useWorkstreams } from '../../daemon/queries';
import { OpenConversation } from '../shape/open-conversation';
import { useRemoveDraftGoalAction } from '../shape/remove-draft-goal';
import { useSelectedProject } from '../../shell/selected-project';
import { BatchSheet } from '../board/batch/batch-sheet';
import {
  AboutGoal,
  GoalBar,
  GoalFooter,
  NeedsYou,
  SinceYouLooked,
  type OpenedDigest,
} from './goal-digest';
import { GoalSessions } from './goal-sessions';
import { GoalTasks } from './goal-tasks';
import { taskRows } from './task-rows';

/** The workstreams `select` keeps, and whether they are still loading or failed to load. */
function useSessions(select: (ws: WorkstreamDto) => boolean) {
  const all = useWorkstreams({ active: false });
  return {
    all: (all.data ?? []).filter(select),
    loading: all.isPending,
    error: all.isError ? all.error.message : null,
  };
}

export interface GoalDetailProps {
  /** The goal and its current state, from the list. */
  readonly summary: GoalSummaryDto;
  readonly opened: OpenedDigest;
}

/**
 * An expanded goal, ordered by what the builder acts on: the bar by state, what needs them (only
 * when something does), one task list, the collapsed history and brief, and one dimmed footer line.
 * One self-contained component, so it can move into a drawer or a page.
 */
export function GoalDetail({ summary, opened }: GoalDetailProps) {
  const { goal, digest } = summary;
  const { project } = useSelectedProject();
  const [starting, setStarting] = useState(false);
  const removal = useRemoveDraftGoalAction(summary);
  const navigate = useNavigate();
  const tasks = useTasks(project?.id ?? null);
  const sessions = useSessions((ws) => goal.taskIds.includes(ws.taskId));
  const batches = useBatches(project?.id ?? null);
  const goalTasks = (tasks.data ?? []).filter((t) => t.goalId === goal.id);
  const ordered = goal.taskIds.flatMap((id) => goalTasks.filter((t) => t.id === id));
  const rows = taskRows({
    tasks: ordered,
    workstreams: sessions.all,
    batches: batches.data ?? [],
    nextTaskId: digest.next?.waitsOn.length === 0 ? digest.next.taskId : null,
    gateCommand: project?.gateCommand ?? null,
  });
  const ready = rows.filter((r) => r.bucket === 'ready').length;
  const loadError = tasks.isError
    ? tasks.error.message
    : (sessions.error ?? (batches.isError ? batches.error.message : null));

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="nowrap" align="center">
        <GoalBar digest={digest} rows={rows} />
        <Button
          variant="default"
          size="xs"
          disabled={ready === 0 || project === null}
          onClick={() => {
            setStarting(true);
          }}
        >
          Start Ready Tasks…
        </Button>
      </Group>
      <NeedsYou digest={digest} rows={rows} />
      <GoalTasks
        goalId={goal.id}
        rows={rows}
        loading={tasks.isPending || sessions.loading}
        error={loadError}
      />
      <Divider />
      <Stack gap="xs">
        <SinceYouLooked opened={opened} />
        <AboutGoal goal={goal} />
        <OpenConversation
          target={{ goalId: goal.id }}
          onOpen={(shapeId) => {
            void navigate({ to: '/shape/$shapeId', params: { shapeId } });
          }}
        />
        {removal.offer === 'available' ? (
          <Button
            variant="subtle"
            color="red"
            size="compact-sm"
            style={{ alignSelf: 'flex-start' }}
            onClick={removal.open}
          >
            Remove Draft Goal…
          </Button>
        ) : null}
        {removal.offer === 'started' ? (
          <Text size="xs" c="dimmed">
            Remove Draft Goal needs every task unstarted; a task of this goal has run.
          </Text>
        ) : null}
      </Stack>
      {removal.modal}
      <GoalFooter digest={digest} />
      {starting && project ? (
        <BatchSheet
          project={project}
          opened
          goal={{ id: goal.id, title: goal.title }}
          onClose={() => {
            setStarting(false);
          }}
        />
      ) : null}
    </Stack>
  );
}

/** The expanded Not in a goal row: only the sessions of tasks with no goal that are running or failed. */
export function UngroupedDetail({
  workstreamIds,
}: {
  readonly workstreamIds: readonly WorkstreamId[];
}) {
  const sessions = useSessions((ws) => workstreamIds.includes(ws.id));
  const { project } = useSelectedProject();
  const tasks = useTasks(project?.id ?? null);
  const batches = useBatches(project?.id ?? null);
  // A failed run offers Retry only once both are known, so a request that failed says why it does not.
  const loadError = tasks.isError
    ? tasks.error.message
    : (sessions.error ?? (batches.isError ? batches.error.message : null));
  return (
    <GoalSessions
      goalId={null}
      workstreams={sessions.all}
      tasks={tasks.data ?? []}
      batches={batches.data ?? []}
      loading={sessions.loading}
      error={loadError}
    />
  );
}
