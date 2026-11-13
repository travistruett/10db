import {
  passHoldsTasks,
  type GoalSummaryDto,
  type ProjectViewDto,
  type WorkstreamDto,
  type WorkstreamId,
} from '@10db/contracts';
import { Button, Divider, Group, Stack, Text } from '@mantine/core';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useGoalPassPages, useLivePass } from '../../daemon/pass-queries';
import { useBatches, useTasks, useWorkstreams } from '../../daemon/queries';
import { OpenConversation } from '../shape/open-conversation';
import { useRemoveDraftGoalAction } from '../shape/remove-draft-goal';
import { BatchSheet } from '../board/batch/batch-sheet';
import { goalReadyForPass } from '../workbench/start-pass-rules';
import { WorkOnThis } from '../workbench/work-on-this';
import {
  AboutGoal,
  GoalBar,
  GoalFooter,
  NeedsYou,
  WaitingOnOthers,
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
  /** The project the goal belongs to, which Factory names; not necessarily the one chosen in the sidebar. */
  readonly project: ProjectViewDto;
  /** The goal and its current state, from the list. */
  readonly summary: GoalSummaryDto;
  readonly opened: OpenedDigest;
}

/**
 * An expanded goal, ordered by what the builder acts on: the bar by state, what needs them (only
 * when something does), one task list, the collapsed history and brief, and one dimmed footer line.
 * One self-contained component, so it can move into a drawer or a page.
 */
export function GoalDetail({ project, summary, opened }: GoalDetailProps) {
  const { goal, digest } = summary;
  const [starting, setStarting] = useState(false);
  const removal = useRemoveDraftGoalAction(summary);
  const navigate = useNavigate();
  const tasks = useTasks(project.id);
  const sessions = useSessions((ws) => goal.taskIds.includes(ws.taskId));
  const batches = useBatches(project.id);
  const goalTasks = (tasks.data ?? []).filter((t) => t.goalId === goal.id);
  const ordered = goal.taskIds.flatMap((id) => goalTasks.filter((t) => t.id === id));
  const rows = taskRows({
    tasks: ordered,
    workstreams: sessions.all,
    batches: batches.data ?? [],
    nextTaskId: digest.next?.waitsOn.length === 0 ? digest.next.taskId : null,
    gateCommand: project.gateCommand,
  });
  const ready = rows.filter((r) => r.bucket === 'ready').length;
  // Work on This opens a pass, so it waits while the project's pass holds pages; the pages a goal's
  // commits touched are a git read, asked for only once it could show.
  const live = useLivePass(project.id);
  const passHolding = live.data != null && passHoldsTasks(live.data.pass.state);
  const passReady = live.isSuccess && !passHolding && goalReadyForPass(goalTasks, project.areas);
  const passPages = useGoalPassPages(passReady ? goal.id : null);
  const loadError = tasks.isError
    ? tasks.error.message
    : (sessions.error ?? (batches.isError ? batches.error.message : null));

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="nowrap" align="center">
        <GoalBar digest={digest} rows={rows} />
        <Group gap="xs" wrap="nowrap">
          <WorkOnThis
            goalId={goal.id}
            passPages={passReady ? passPages.data : undefined}
            tasks={goalTasks}
            areas={project.areas}
          />
          <Button
            variant="default"
            size="xs"
            disabled={ready === 0}
            onClick={() => {
              setStarting(true);
            }}
          >
            Start Ready Tasks
          </Button>
        </Group>
      </Group>
      <NeedsYou digest={digest} rows={rows} />
      <WaitingOnOthers digest={digest} />
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
            Remove Draft Goal
          </Button>
        ) : null}
        {removal.offer === 'started' ? (
          <Text size="xs" c="dimmed">
            Remove Draft Goal needs every task unstarted; a task of this goal has started.
          </Text>
        ) : null}
      </Stack>
      {removal.modal}
      <GoalFooter digest={digest} />
      {starting ? (
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
  project,
  workstreamIds,
}: {
  readonly project: ProjectViewDto;
  readonly workstreamIds: readonly WorkstreamId[];
}) {
  const sessions = useSessions((ws) => workstreamIds.includes(ws.id));
  const tasks = useTasks(project.id);
  const batches = useBatches(project.id);
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
